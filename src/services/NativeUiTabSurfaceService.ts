import * as vscode from 'vscode';
import { NativeUiSurfaceTracker } from '../harnesses/types';

/** How long an expected tab can take to appear before the expectation expires. */
const PENDING_TTL_MS = 30_000;

interface PendingSurface {
  sessionId: string;
  label: string;
  expiresAt: number;
}

export interface NativeUiTabSurfaceOptions {
  /** Whether the tab belongs to this harness's native UI. */
  isUiTab: (tab: vscode.Tab) => boolean;
  /**
   * The native session ID the tab exposes, when the tab carries one. A tab
   * without an ID can still bind through a label expectation.
   */
  sessionIdForTab?: (tab: vscode.Tab) => string | undefined;
  /**
   * Whether a pending label may bind a tab that exposes no session ID. Claude
   * webview tabs need this; Codex conversation tabs are matched by URI only.
   */
  matchByLabel?: boolean;
  /** Injection points keep the tab API behind a testable boundary. */
  getTabGroups?: () => readonly vscode.TabGroup[];
  onDidChangeTabs?: (
    listener: (event: vscode.TabChangeEvent) => void
  ) => vscode.Disposable;
  onDidChangeTabGroups?: (
    listener: (event: vscode.TabGroupChangeEvent) => void
  ) => vscode.Disposable;
}

/**
 * Associates native-UI tabs with native session IDs.
 *
 * Harnesses differ in what a tab reveals: Codex's conversation editor carries
 * the thread URI, while Claude's webview carries only the title. The shared
 * lifecycle lives here; each harness supplies a policy for recognizing its
 * tabs and, when possible, reading the session ID from one.
 */
export class NativeUiTabSurfaceService implements NativeUiSurfaceTracker {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly tabs = new Map<vscode.Tab, string>();
  /** Reverse index so isOpen and closeSurface never scan the tab list. */
  private readonly sessionTabs = new Map<string, Set<vscode.Tab>>();
  private pending: PendingSurface[] = [];
  private lastActiveSessionId: string | undefined;

  private readonly isUiTab: (tab: vscode.Tab) => boolean;
  private readonly sessionIdForTab:
    | ((tab: vscode.Tab) => string | undefined)
    | undefined;
  private readonly matchByLabel: boolean;
  private readonly getTabGroups: () => readonly vscode.TabGroup[];
  private readonly tabListener: vscode.Disposable;
  private readonly groupListener: vscode.Disposable;

  constructor(options: NativeUiTabSurfaceOptions) {
    this.isUiTab = options.isUiTab;
    this.sessionIdForTab = options.sessionIdForTab;
    this.matchByLabel = options.matchByLabel ?? false;

    const tabGroups = vscode.window.tabGroups;
    this.getTabGroups = options.getTabGroups ?? (() => tabGroups.all);
    this.tabListener = (
      options.onDidChangeTabs ??
      ((listener) => tabGroups.onDidChangeTabs(listener))
    )((event) => this.handleTabChange(event));
    this.groupListener = (
      options.onDidChangeTabGroups ??
      ((listener) => tabGroups.onDidChangeTabGroups(listener))
    )(() => {
      if (this.updateActiveSession()) {
        this._onDidChange.fire();
      }
    });

    // Seed tabs that were restored before the extension activated. Claude has
    // no expectation yet, so this is a no-op there; Codex panels map exactly.
    for (const group of this.getTabGroups()) {
      for (const tab of group.tabs) {
        this.associate(tab, false);
      }
    }
    this.lastActiveSessionId = this.activeSessionId();
  }

  expect(sessionId: string, label: string): void {
    // A tracker that reads the session ID from the tab has nothing to claim;
    // the tab is associated as soon as it appears.
    if (!this.matchByLabel) {
      return;
    }
    // Reopening a session that already has a mapped tab just reveals it; there
    // is no new tab to claim.
    if (this.isOpen(sessionId)) {
      return;
    }
    this.prunePending();
    this.pending = this.pending.filter((entry) => entry.sessionId !== sessionId);
    this.pending.push({
      sessionId,
      label,
      expiresAt: Date.now() + PENDING_TTL_MS,
    });
  }

  cancelExpect(sessionId: string): void {
    this.pending = this.pending.filter((entry) => entry.sessionId !== sessionId);
  }

  settle(
    sessionId: string,
    options: { allowActiveFallback?: boolean } = {}
  ): void {
    this.prunePending();
    let mappingChanged = false;

    if (this.pending.some((entry) => entry.sessionId === sessionId)) {
      const groups = this.getTabGroups();
      const activeTab = groups.find((group) => group.isActive)?.activeTab;
      if (activeTab) {
        // The command just opened or revealed this session's tab. With a
        // single expectation, the active tab is safe to bind even if its title
        // was truncated differently from the chat name.
        mappingChanged = this.associate(
          activeTab,
          (options.allowActiveFallback ?? true) && this.pending.length === 1
        );
      }

      // A tab can be active in a non-active group, or the active tab can be a
      // file when the panel opened in the background. Match remaining tabs
      // without guessing.
      if (this.pending.some((entry) => entry.sessionId === sessionId)) {
        for (const group of groups) {
          for (const tab of group.tabs) {
            mappingChanged = this.associate(tab, false) || mappingChanged;
          }
        }
      }
    }

    const activeChanged = this.updateActiveSession();
    if (mappingChanged || activeChanged) {
      this._onDidChange.fire();
    }
  }

  activeSessionId(): string | undefined {
    const activeTab = this.getTabGroups().find((group) => group.isActive)
      ?.activeTab;
    if (!activeTab) {
      return undefined;
    }
    const mapped = this.tabs.get(activeTab);
    if (mapped) {
      return mapped;
    }
    return this.isUiTab(activeTab)
      ? this.sessionIdForTab?.(activeTab)
      : undefined;
  }

  async closeSurface(sessionId: string): Promise<boolean> {
    const tab = this.sessionTabs.get(sessionId)?.values().next().value;
    return tab ? vscode.window.tabGroups.close(tab, true) : false;
  }

  /**
   * Whether this native session currently has an open native-UI tab.
   *
   * Reads the map only: the constructor seeds every restored tab and
   * `onDidChangeTabs` maps each new one, so the map is authoritative. This is
   * called once per chat row per tree render, so it must not scan the tabs.
   */
  isOpen(sessionId: string): boolean {
    return this.sessionTabs.has(sessionId);
  }

  dispose(): void {
    this.tabListener.dispose();
    this.groupListener.dispose();
    this._onDidChange.dispose();
    this.tabs.clear();
    this.sessionTabs.clear();
    this.pending = [];
  }

  private handleTabChange(event: vscode.TabChangeEvent): void {
    this.prunePending();
    let mappingChanged = false;

    for (const tab of event.closed) {
      if (this.unmapTab(tab)) {
        mappingChanged = true;
      }
    }
    for (const tab of [...event.opened, ...event.changed]) {
      mappingChanged =
        this.associate(tab, this.pending.length === 1) || mappingChanged;
    }

    const activeChanged = this.updateActiveSession();
    if (mappingChanged || activeChanged) {
      this._onDidChange.fire();
    }
  }

  private associate(tab: vscode.Tab, allowFallback: boolean): boolean {
    if (!this.isUiTab(tab)) {
      return false;
    }

    const exact = this.sessionIdForTab?.(tab);
    if (exact) {
      // The tab itself proves the session opened; a pending expectation for
      // that session is satisfied even if its label never matched.
      const pendingIndex = this.pending.findIndex(
        (entry) => entry.sessionId === exact
      );
      if (pendingIndex >= 0) {
        this.pending.splice(pendingIndex, 1);
      }
      return this.mapTab(tab, exact);
    }

    if (this.tabs.has(tab) || !this.matchByLabel || this.pending.length === 0) {
      return false;
    }

    const match = this.pending.findIndex((entry) =>
      labelsMatch(tab.label, entry.label)
    );
    const index = match >= 0 ? match : allowFallback ? 0 : -1;
    if (index < 0) {
      return false;
    }

    const [pending] = this.pending.splice(index, 1);
    if (!pending) {
      return false;
    }
    this.mapTab(tab, pending.sessionId);
    return true;
  }

  /** Map a tab to a session, keeping the reverse index in step. */
  private mapTab(tab: vscode.Tab, sessionId: string): boolean {
    if (this.tabs.get(tab) === sessionId) {
      return false;
    }
    this.unmapTab(tab);
    this.tabs.set(tab, sessionId);
    const mapped = this.sessionTabs.get(sessionId) ?? new Set<vscode.Tab>();
    mapped.add(tab);
    this.sessionTabs.set(sessionId, mapped);
    return true;
  }

  /** Drop a tab's mapping, whatever session it was bound to. */
  private unmapTab(tab: vscode.Tab): boolean {
    const sessionId = this.tabs.get(tab);
    if (!sessionId) {
      return false;
    }
    this.tabs.delete(tab);
    const mapped = this.sessionTabs.get(sessionId);
    if (mapped) {
      mapped.delete(tab);
      if (mapped.size === 0) {
        this.sessionTabs.delete(sessionId);
      }
    }
    return true;
  }

  /** Returns true when the active native-UI session changed. */
  private updateActiveSession(): boolean {
    const active = this.activeSessionId();
    if (active === this.lastActiveSessionId) {
      return false;
    }
    this.lastActiveSessionId = active;
    return true;
  }

  /** Drop expectations whose tab never appeared. */
  private prunePending(): void {
    const now = Date.now();
    this.pending = this.pending.filter((entry) => entry.expiresAt > now);
  }
}

/** A tab title and a chat name match exactly or by a truncated prefix. */
function labelsMatch(tabLabel: string, chatName: string): boolean {
  const label = tabLabel.trim();
  const name = chatName.trim();
  if (!label || !name) {
    return false;
  }
  if (label === name) {
    return true;
  }
  if (label.endsWith('…')) {
    const prefix = label.slice(0, -1);
    return prefix.length > 0 && name.startsWith(prefix);
  }
  return false;
}
