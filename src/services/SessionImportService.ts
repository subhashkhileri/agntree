import * as vscode from 'vscode';
import { ChatSession, HarnessId, Worktree } from '../types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessAdapter, HarnessSession } from '../harnesses/types';
import {
  findClaimableSession,
  harnessSessionKey,
  snapshotSessionIds,
} from '../harnesses/sessionUtils';
import { isWithin } from '../utils/paths';
import { truncateName } from '../utils/text';
import { GitService } from './GitService';
import { StorageService } from './StorageService';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A new UI placeholder links quickly; after this it moves to the slow scan. */
const HOT_WINDOW_MS = 5 * 60 * 1000;
/** A placeholder that never gets a session stops being polled after this. */
const PENDING_LINK_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SCAN_INTERVAL_MS = 2 * 60 * 1000;
const DEFAULT_HOT_SCAN_INTERVAL_MS = 3_000;
const MAX_IMPORTS_PER_SCAN = 50;
/**
 * Listing worktrees costs one synchronous `git` call per repository, and the
 * hot scan runs every few seconds. Sessions created inside this window are
 * imported by the next scan.
 */
const SCOPE_TTL_MS = 15_000;

export interface SessionImportSettings {
  enabled: boolean;
  retentionDays: number;
}

export interface SessionImportEvent {
  imported: number;
  linked: number;
  renamed: number;
  removed: string[];
}

export interface SessionImportServiceOptions {
  scanIntervalMs?: number;
  hotScanIntervalMs?: number;
  /** A live terminal or open native-UI tab must not be pruned. */
  isChatOpen?: (chat: ChatSession) => boolean;
  /**
   * Whether anyone can see the rows right now. The slow discovery pass is
   * skipped while the tree is hidden, so an idle window spawns no harness
   * processes; a launch that is still linking always scans.
   */
  isVisible?: () => boolean;
  onChatsChanged?: (event: SessionImportEvent) => void;
  /** Settings are read per scan so a change applies without a reload. */
  readSettings?: () => SessionImportSettings;
}

interface PendingUiExpectation {
  harness: HarnessId;
  worktreePath: string;
  since: number;
  knownSessionIds: Set<string>;
  bindSurface: boolean;
}

interface ChatIndex {
  byId: Map<string, ChatSession>;
  linked: Map<HarnessId, Set<string>>;
  pending: Map<HarnessId, Set<string>>;
  removedKeys: Set<string>;
}

interface Scope {
  repoRoot: string;
  worktrees: Worktree[];
}

/**
 * Reconciles Agntree chats with the native sessions on disk.
 *
 * Agntree-started sessions are linked by their harness watcher, but two cases
 * have no chosen ID: a session started in the agent's VS Code UI, and a
 * session started outside Agntree entirely. This service covers both.
 *
 * It also imports recent native sessions automatically and ages out quiet rows
 * on the retention setting, keeping starred and open chats.
 * All work is asynchronous and bounded by a timer that stops when there is
 * nothing left to do.
 */
export class SessionImportService implements vscode.Disposable {
  private readonly scanIntervalMs: number;
  private readonly hotScanIntervalMs: number;
  private readonly isChatOpen: (chat: ChatSession) => boolean;
  private readonly isVisible: () => boolean;
  private readonly onChatsChanged: (event: SessionImportEvent) => void;
  private readonly readSettings: () => SessionImportSettings;

  private readonly expectations = new Map<string, PendingUiExpectation>();
  private readonly configListener: vscode.Disposable;
  private timer: NodeJS.Timeout | undefined;
  private timerIntervalMs: number | undefined;
  private scopeCache: { fetchedAt: number; scopes: Scope[] } | undefined;
  private started = false;
  private scanning = false;
  private disposed = false;

  constructor(
    private readonly storageService: StorageService,
    private readonly gitService: GitService,
    private readonly harnessRegistry: HarnessRegistry,
    options: SessionImportServiceOptions = {}
  ) {
    this.scanIntervalMs =
      options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    this.hotScanIntervalMs =
      options.hotScanIntervalMs ?? DEFAULT_HOT_SCAN_INTERVAL_MS;
    this.isChatOpen = options.isChatOpen ?? (() => false);
    this.isVisible = options.isVisible ?? (() => true);
    this.onChatsChanged = options.onChatsChanged ?? (() => undefined);
    this.readSettings =
      options.readSettings ??
      (() => {
        const config = vscode.workspace.getConfiguration('agntree');
        const days = Number(config.get<number>('autoImport.retentionDays', 7));
        return {
          enabled: config.get<boolean>('autoImport.enabled', true),
          retentionDays:
            Number.isFinite(days) && days >= 1 ? Math.floor(days) : 7,
        };
      });

    this.configListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration('agntree.autoImport')) {
          this.schedule();
          this.wake();
        }
      }
    );
  }

  start(): void {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    // Restoring a launch needs the worktrees, which costs one synchronous git
    // call per repository; skip it when no chat is waiting for a UI session.
    const chats = this.storageService.getChats();
    if (chats.some((chat) => chat.pendingUiLaunch && !chat.harnessSessionId)) {
      this.restorePendingUiExpectations(this.getScopes(true), chats);
    }
    this.schedule();
    this.wake();
  }

  /**
   * Record a chat whose session will be created by its native UI. The
   * snapshot is taken before the UI opens, so only a session that appears
   * afterwards can be claimed. It is persisted too, so a reload between the
   * launch and the first prompt cannot make the placeholder claim an older
   * session in the same worktree.
   */
  async expectChat(
    chatId: string,
    worktreePath: string,
    options: { bindSurface?: boolean } = {}
  ): Promise<void> {
    const chat = this.storageService.getChat(chatId);
    if (!chat || chat.harnessSessionId || !chat.pendingUiLaunch) {
      return;
    }

    const snapshot = await this.snapshotSessions(chat.harness, worktreePath);
    const knownSessionIds = new Set(snapshot ?? []);

    // The user may have started this chat in a terminal while the listing was
    // in flight; that launch owns the linkage now.
    const latest = this.storageService.getChat(chatId);
    if (!latest || latest.harnessSessionId || !latest.pendingUiLaunch) {
      return;
    }

    this.expectations.set(chatId, {
      harness: chat.harness,
      worktreePath,
      since: Date.now(),
      knownSessionIds,
      bindSurface: options.bindSurface ?? true,
    });
    if (snapshot) {
      this.storageService.updateChat(chatId, {
        pendingUiKnownSessionIds: snapshot,
      });
    }
    this.schedule();
  }

  /**
   * Sessions that already exist before a UI launch. A listing failure must not
   * strand the placeholder: the `since` cutoff still keeps older sessions out,
   * so an empty snapshot is the safe fallback.
   */
  private async snapshotSessions(
    harness: HarnessId,
    worktreePath: string
  ): Promise<string[] | undefined> {
    try {
      const sessions = await this.harnessRegistry
        .get(harness)
        .listSessionsForWorktree(worktreePath, true);
      return snapshotSessionIds(sessions);
    } catch (error) {
      console.error(
        '[SessionImportService] Could not snapshot sessions before a UI launch:',
        error
      );
      return undefined;
    }
  }

  cancelExpectation(chatId: string): void {
    if (this.expectations.delete(chatId)) {
      this.schedule();
    }
    // The launch did not happen, so its snapshot must not outlive it.
    if (this.storageService.getChat(chatId)?.pendingUiKnownSessionIds) {
      this.storageService.updateChat(chatId, {
        pendingUiKnownSessionIds: undefined,
      });
    }
  }

  /** Scan immediately, e.g. after a UI launch or a settings change. */
  wake(): void {
    if (this.disposed) {
      return;
    }
    if (this.scanning) {
      return;
    }
    void this.scan().catch((error) => {
      console.error('[SessionImportService] Scan failed:', error);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.expectations.clear();
    this.configListener.dispose();
  }

  private async scan(): Promise<void> {
    if (this.scanning || this.disposed) {
      return;
    }
    this.scanning = true;

    const event: SessionImportEvent = {
      imported: 0,
      linked: 0,
      renamed: 0,
      removed: [],
    };

    try {
      const settings = this.readSettings();
      const now = Date.now();
      const hot = this.hasHotExpectation(now);
      // Nothing is linking and nobody can see the rows: skip the whole
      // discovery pass so an idle, hidden sidebar spawns no harness processes.
      if (!hot && !this.isVisible()) {
        return;
      }
      const adapters = await this.harnessRegistry.getInstalled();
      if (adapters.length === 0) {
        return;
      }
      const scopes = this.getScopes();
      const chats = this.storageService.getChats();
      this.restorePendingUiExpectations(scopes, chats);

      const index = this.buildIndex(chats);

      // While a UI launch is linking, poll only its worktree. A full discovery
      // pass over every repository every few seconds would spawn harness
      // processes and walk session directories for no benefit.
      if (hot) {
        await this.linkHotExpectations(adapters, scopes, index, event);
        return;
      }

      const retentionMs = settings.retentionDays * DAY_MS;
      const starred = this.storageService.getStarredChatIds();
      const listings = await this.listRepositorySessions(scopes, adapters);

      for (const { scope, adapter, sessions } of listings) {
        const byWorktree = this.groupByWorktree(scope.worktrees, sessions);
        for (const worktree of scope.worktrees) {
          const worktreeSessions = byWorktree.get(worktree.id) ?? [];
          const sessionsById = new Map(
            worktreeSessions.map((session) => [session.sessionId, session])
          );
          this.linkPendingUiLaunches(
            adapter,
            worktree,
            worktreeSessions,
            index,
            event
          );
          this.renameLinkedChats(adapter, worktree, sessionsById, index, event);
          if (settings.enabled) {
            this.importRecentSessions(
              adapter,
              worktree,
              worktreeSessions,
              index,
              event,
              now,
              retentionMs
            );
            this.pruneExpiredChats(
              adapter,
              worktree,
              sessionsById,
              starred,
              index,
              event,
              now,
              retentionMs
            );
          }
        }
      }
    } finally {
      if (event.removed.length > 0) {
        this.storageService.deleteChats(event.removed, {
          rememberSession: false,
        });
      }
      this.scanning = false;
      if (
        event.imported > 0 ||
        event.linked > 0 ||
        event.renamed > 0 ||
        event.removed.length > 0
      ) {
        this.onChatsChanged(event);
      }
      this.schedule();
    }
  }

  /**
   * List every repository once per adapter. The listings are independent, so
   * they run together; only the mutations that follow need the original order.
   */
  private async listRepositorySessions(
    scopes: Scope[],
    adapters: HarnessAdapter[]
  ): Promise<
    Array<{ scope: Scope; adapter: HarnessAdapter; sessions: HarnessSession[] }>
  > {
    const listings = await Promise.all(
      scopes.flatMap((scope) =>
        adapters.map(async (adapter) => {
          try {
            const sessions = await adapter.listSessionsForRepository(
              scope.repoRoot,
              scope.worktrees.map((worktree) => worktree.path)
            );
            return { scope, adapter, sessions };
          } catch (error) {
            console.error(
              `[SessionImportService] Could not list ${adapter.displayName} sessions for ${scope.repoRoot}:`,
              error
            );
            return undefined;
          }
        })
      )
    );
    return listings.filter(
      (
        listing
      ): listing is {
        scope: Scope;
        adapter: HarnessAdapter;
        sessions: HarnessSession[];
      } => listing !== undefined
    );
  }

  /**
   * The fast pass while a UI launch is waiting for its session. Only the
   * worktree that has an expectation is listed; imports, renames, and
   * retention wait for the next full scan.
   */
  private async linkHotExpectations(
    adapters: HarnessAdapter[],
    scopes: Scope[],
    index: ChatIndex,
    event: SessionImportEvent
  ): Promise<void> {
    const jobs = new Map<
      string,
      { adapter: HarnessAdapter; worktree: Worktree }
    >();
    for (const expectation of this.expectations.values()) {
      const adapter = adapters.find(
        (candidate) => candidate.id === expectation.harness
      );
      const worktree = this.findWorktreeByPath(
        expectation.worktreePath,
        scopes
      );
      if (adapter && worktree) {
        jobs.set(`${expectation.harness}\u0000${worktree.path}`, {
          adapter,
          worktree,
        });
      }
    }

    const listings = await Promise.all(
      Array.from(jobs.values(), async ({ adapter, worktree }) => {
        try {
          return {
            adapter,
            worktree,
            sessions: await adapter.listSessionsForWorktree(
              worktree.path,
              true
            ),
          };
        } catch (error) {
          console.error(
            `[SessionImportService] Could not poll ${adapter.displayName} sessions for ${worktree.path}:`,
            error
          );
          return undefined;
        }
      })
    );

    for (const listing of listings) {
      if (listing) {
        this.linkPendingUiLaunches(
          listing.adapter,
          listing.worktree,
          listing.sessions,
          index,
          event
        );
      }
    }
  }

  private buildIndex(chats: ChatSession[]): ChatIndex {
    const index: ChatIndex = {
      byId: new Map(chats.map((chat) => [chat.id, chat])),
      linked: new Map(),
      pending: new Map(),
      removedKeys: this.storageService.getRemovedSessionKeys(),
    };

    for (const chat of chats) {
      const linked = index.linked.get(chat.harness) ?? new Set<string>();
      const pending = index.pending.get(chat.harness) ?? new Set<string>();
      if (chat.harnessSessionId) {
        linked.add(chat.harnessSessionId);
      }
      if (chat.pendingHarnessSessionId) {
        pending.add(chat.pendingHarnessSessionId);
      }
      index.linked.set(chat.harness, linked);
      index.pending.set(chat.harness, pending);
    }
    return index;
  }

  private restorePendingUiExpectations(
    scopes: Scope[],
    chats: ChatSession[]
  ): void {
    const now = Date.now();
    for (const chat of chats) {
      if (!chat.pendingUiLaunch || chat.harnessSessionId) {
        continue;
      }
      if (now - chat.createdAt > PENDING_LINK_WINDOW_MS) {
        // Stop polling a placeholder that never produced a session. The chat
        // stays in the tree and can still be opened in the terminal.
        this.storageService.updateChat(chat.id, {
          pendingUiLaunch: false,
          pendingUiKnownSessionIds: undefined,
        });
        this.expectations.delete(chat.id);
        continue;
      }
      if (this.expectations.has(chat.id)) {
        continue;
      }
      const worktree = this.findWorktree(chat.worktreeId, scopes);
      if (!worktree) {
        continue;
      }
      // Prefer the snapshot the launch persisted. Without one, fall back to
      // the chat's creation time: the session appeared after the UI opened.
      this.expectations.set(chat.id, {
        harness: chat.harness,
        worktreePath: worktree.path,
        since: chat.createdAt,
        knownSessionIds: new Set(chat.pendingUiKnownSessionIds ?? []),
        bindSurface: true,
      });
    }
  }

  private linkPendingUiLaunches(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessions: HarnessSession[],
    index: ChatIndex,
    event: SessionImportEvent
  ): void {
    const linked = index.linked.get(adapter.id) ?? new Set<string>();

    for (const [chatId, expectation] of Array.from(
      this.expectations.entries()
    )) {
      if (
        expectation.harness !== adapter.id ||
        expectation.worktreePath !== worktree.path
      ) {
        continue;
      }

      const chat = index.byId.get(chatId);
      if (!chat || chat.harnessSessionId) {
        this.expectations.delete(chatId);
        continue;
      }

      // A UI-started chat normally has no chosen ID, but honoring one keeps
      // the path correct if the harness ever accepts it.
      const exact = chat.pendingHarnessSessionId
        ? sessions.find(
            (session) =>
              session.sessionId === chat.pendingHarnessSessionId &&
              !linked.has(session.sessionId)
          )
        : undefined;
      const match =
        exact ??
        findClaimableSession(
          sessions,
          expectation.since,
          (sessionId) =>
            expectation.knownSessionIds.has(sessionId) ||
            linked.has(sessionId)
        );
      if (!match) {
        continue;
      }

      this.linkChat(
        adapter,
        chat,
        match,
        expectation.bindSurface,
        index,
        event
      );
      this.expectations.delete(chatId);
      linked.add(match.sessionId);
      index.linked.set(adapter.id, linked);
    }
  }

  private linkChat(
    adapter: HarnessAdapter,
    chat: ChatSession,
    session: HarnessSession,
    bindSurface: boolean,
    index: ChatIndex,
    event: SessionImportEvent
  ): void {
    const updates: Partial<ChatSession> = {
      harnessSessionId: session.sessionId,
      pendingHarnessSessionId: null,
      pendingUiLaunch: false,
      pendingUiKnownSessionIds: undefined,
      forkedFromSessionId: null,
    };
    const name = session.summary?.trim();
    if (name && chat.name.startsWith('New Session')) {
      updates.name = truncateName(name);
    }

    const updated = this.storageService.updateChat(chat.id, updates);
    if (!updated) {
      return;
    }
    index.byId.set(updated.id, updated);
    event.linked++;

    if (bindSurface) {
      const surfaces = adapter.nativeUi?.surfaces;
      surfaces?.expect(session.sessionId, updated.name);
      // This runs in the background, so the active tab may belong to another
      // conversation: bind only a tab whose title matches the session name.
      surfaces?.settle(session.sessionId, { allowActiveFallback: false });
    }
  }

  private renameLinkedChats(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessionsById: Map<string, HarnessSession>,
    index: ChatIndex,
    event: SessionImportEvent
  ): void {
    for (const chat of index.byId.values()) {
      if (
        chat.harness !== adapter.id ||
        chat.worktreeId !== worktree.id ||
        !chat.harnessSessionId ||
        chat.customName
      ) {
        continue;
      }
      // A user-started chat picks up its first harness name once. An
      // auto-imported one may have been named from the first prompt before
      // the harness wrote its title, so keep it current.
      if (!chat.autoImported && !chat.name.startsWith('New Session')) {
        continue;
      }
      const session = sessionsById.get(chat.harnessSessionId);
      const name = session?.summary?.trim();
      if (!name) {
        continue;
      }
      const nextName = truncateName(name);
      if (nextName === chat.name) {
        continue;
      }
      const updated = this.storageService.renameChat(chat.id, nextName);
      if (updated) {
        index.byId.set(updated.id, updated);
        event.renamed++;
      }
    }
  }

  private importRecentSessions(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessions: HarnessSession[],
    index: ChatIndex,
    event: SessionImportEvent,
    now: number,
    retentionMs: number
  ): void {
    if (event.imported >= MAX_IMPORTS_PER_SCAN) {
      return;
    }

    const linked = index.linked.get(adapter.id) ?? new Set<string>();
    const pending = index.pending.get(adapter.id) ?? new Set<string>();

    // A CLI-launched chat without a chosen ID is waiting for its own session.
    // Reserve the session its watcher will claim so this scan cannot create a
    // duplicate first. Chats started in the UI are linked above instead.
    const reserved = this.reserveAwaitingSessions(
      adapter.id,
      worktree,
      sessions,
      index,
      linked
    );

    const candidates = [...sessions].sort(
      (a, b) =>
        (a.lastUpdated?.getTime() ?? 0) - (b.lastUpdated?.getTime() ?? 0)
    );

    for (const session of candidates) {
      if (event.imported >= MAX_IMPORTS_PER_SCAN) {
        return;
      }
      if (linked.has(session.sessionId)) {
        continue;
      }
      if (pending.has(session.sessionId)) {
        continue;
      }
      if (reserved.has(session.sessionId)) {
        continue;
      }
      if (
        index.removedKeys.has(
          harnessSessionKey(adapter.id, session.sessionId)
        )
      ) {
        continue;
      }

      const lastActive =
        session.lastActivity ??
        session.lastUpdated?.getTime() ??
        0;
      if (!lastActive || now - lastActive > retentionMs) {
        continue;
      }

      const name = session.summary?.trim();
      const createdAt = session.lastUpdated?.getTime() ?? lastActive;
      const chat = this.storageService.createChatFromSession(
        worktree.id,
        adapter.id,
        name ? truncateName(name) : 'New Session',
        session.sessionId,
        { createdAt, lastAccessedAt: lastActive, autoImported: true }
      );
      index.byId.set(chat.id, chat);
      linked.add(session.sessionId);
      index.linked.set(adapter.id, linked);
      event.imported++;
    }
  }

  /**
   * Sessions that an unlinked CLI chat is about to claim. Its watcher owns the
   * link; auto-import only needs to stay out of the way.
   */
  private reserveAwaitingSessions(
    harness: HarnessId,
    worktree: Worktree,
    sessions: HarnessSession[],
    index: ChatIndex,
    linked: Set<string>
  ): Set<string> {
    const reserved = new Set<string>();
    const now = Date.now();
    const awaiting = Array.from(index.byId.values())
      .filter(
        (chat) =>
          chat.harness === harness &&
          chat.worktreeId === worktree.id &&
          !chat.harnessSessionId &&
          !chat.pendingUiLaunch &&
          !chat.pendingHarnessSessionId &&
          // A placeholder that never produced a session must not keep
          // reserving sessions that belong to someone else.
          now - chat.createdAt <= PENDING_LINK_WINDOW_MS
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    if (awaiting.length === 0) {
      return reserved;
    }

    for (const chat of awaiting) {
      const match = findClaimableSession(
        sessions,
        chat.createdAt,
        (sessionId) => linked.has(sessionId) || reserved.has(sessionId)
      );
      if (match) {
        reserved.add(match.sessionId);
      }
    }
    return reserved;
  }

  /**
   * Remove rows that have been quiet longer than the retention window, whether
   * Agntree created them or they were imported. A star is the only exemption
   * the user controls; an open terminal or native-UI tab is kept so retention
   * never pulls a row out from under a live session.
   */
  private pruneExpiredChats(
    adapter: HarnessAdapter,
    worktree: Worktree,
    sessionsById: Map<string, HarnessSession>,
    starred: Set<string>,
    index: ChatIndex,
    event: SessionImportEvent,
    now: number,
    retentionMs: number
  ): void {
    for (const chat of Array.from(index.byId.values())) {
      if (chat.harness !== adapter.id || chat.worktreeId !== worktree.id) {
        continue;
      }
      if (starred.has(chat.id) || this.isChatOpen(chat)) {
        continue;
      }

      const session = chat.harnessSessionId
        ? sessionsById.get(chat.harnessSessionId)
        : undefined;
      const lastActive = Math.max(
        session?.lastActivity ?? 0,
        session?.lastUpdated?.getTime() ?? 0,
        chat.lastAccessedAt ?? 0
      );
      // An unknown timestamp is not evidence that the row is old.
      if (!lastActive || now - lastActive <= retentionMs) {
        continue;
      }

      // Retention is not a user removal, so no tombstone: if the session
      // becomes active again, the importer may bring it back. The scan
      // deletes every expired row in one write once it has finished.
      index.byId.delete(chat.id);
      event.removed.push(chat.id);
    }
  }

  private groupByWorktree(
    worktrees: Worktree[],
    sessions: HarnessSession[]
  ): Map<string, HarnessSession[]> {
    const byId = new Map<string, HarnessSession[]>();
    const deepestFirst = [...worktrees].sort(
      (a, b) => b.path.length - a.path.length
    );

    for (const session of sessions) {
      const worktree = deepestFirst.find((candidate) =>
        isWithin(session.cwd, candidate.path)
      );
      if (!worktree) {
        continue;
      }
      const group = byId.get(worktree.id) ?? [];
      group.push(session);
      byId.set(worktree.id, group);
    }
    return byId;
  }

  private getScopes(force = false): Scope[] {
    if (
      !force &&
      this.scopeCache &&
      Date.now() - this.scopeCache.fetchedAt < SCOPE_TTL_MS
    ) {
      return this.scopeCache.scopes;
    }

    const scopes: Scope[] = [];
    for (const repo of this.storageService.getRepositories()) {
      const { worktrees } = this.gitService.listRepositoryWorktrees(
        repo.rootPath,
        repo.id
      );
      if (worktrees.length > 0) {
        scopes.push({ repoRoot: repo.rootPath, worktrees });
      }
    }
    // Listing worktrees is a synchronous git call per repository, and the hot
    // scan runs every few seconds; a short TTL keeps it off that path.
    this.scopeCache = { fetchedAt: Date.now(), scopes };
    return scopes;
  }

  /** Whether a UI launch is recent enough to keep polling quickly. */
  private hasHotExpectation(now: number): boolean {
    for (const expectation of this.expectations.values()) {
      if (now - expectation.since < HOT_WINDOW_MS) {
        return true;
      }
    }
    return false;
  }

  private findWorktree(
    worktreeId: string,
    scopes: Scope[]
  ): Worktree | undefined {
    for (const scope of scopes) {
      const worktree = scope.worktrees.find(
        (candidate) => candidate.id === worktreeId
      );
      if (worktree) {
        return worktree;
      }
    }
    return undefined;
  }

  private findWorktreeByPath(
    worktreePath: string,
    scopes: Scope[]
  ): Worktree | undefined {
    for (const scope of scopes) {
      const worktree = scope.worktrees.find(
        (candidate) => candidate.path === worktreePath
      );
      if (worktree) {
        return worktree;
      }
    }
    return undefined;
  }

  private nextIntervalMs(): number | undefined {
    const settings = this.readSettings();
    const now = Date.now();
    let hot = false;

    for (const [chatId, expectation] of Array.from(this.expectations)) {
      const age = now - expectation.since;
      if (age > PENDING_LINK_WINDOW_MS) {
        this.expectations.delete(chatId);
        continue;
      }
      if (age < HOT_WINDOW_MS) {
        hot = true;
      }
    }

    if (hot) {
      return this.hotScanIntervalMs;
    }
    if (settings.enabled || this.expectations.size > 0) {
      return this.scanIntervalMs;
    }
    return undefined;
  }

  private schedule(): void {
    if (!this.started || this.disposed) {
      return;
    }
    const interval = this.nextIntervalMs();
    if (interval === undefined) {
      this.stopTimer();
      return;
    }
    if (this.timer && this.timerIntervalMs === interval) {
      return;
    }
    this.stopTimer();
    this.timerIntervalMs = interval;
    this.timer = setInterval(() => {
      this.wake();
    }, interval);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.timerIntervalMs = undefined;
  }
}
