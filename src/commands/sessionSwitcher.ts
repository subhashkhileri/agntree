import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessAdapter, NativeUiCapability, TurnState } from '../harnesses/types';
import { harnessIconPath } from '../harnesses/treeIcons';
import { chatPrimarySessionId, selectHarnessIconState } from '../harnesses/sessionUtils';
import { StorageService } from '../services/StorageService';
import { errorMessage, formatRelativeTime } from '../utils/text';

/** The switcher's sections, in display order. */
export type SwitcherSection = 'needsYou' | 'open' | 'starred' | 'recent' | 'current';

const SECTIONS: readonly SwitcherSection[] = ['needsYou', 'open', 'starred', 'recent', 'current'];

const SECTION_LABELS: Record<SwitcherSection, string> = {
  needsYou: 'Needs you',
  open: 'Open',
  starred: 'Starred',
  recent: 'Recent',
  current: 'Current session',
};

const PLACEHOLDER = 'Search sessions by name, repository, worktree, or agent';

export interface SwitcherFilter {
  starredOnly: boolean;
  /** Only this repository's sessions. */
  repoId?: string;
}

export interface SwitcherSnapshot {
  chats: readonly ChatSession[];
  starred: ReadonlySet<string>;
  /** Open chats that finished or began waiting unseen, longest-waiting first. */
  needsYou: readonly string[];
  /** The chat the user is in; it goes last so the first row is the one to switch to. */
  currentChatId?: string;
  isOpen: (chat: ChatSession) => boolean;
  /** The repository a chat's worktree belongs to; undefined when the worktree is gone. */
  repoOf: (chat: ChatSession) => string | undefined;
}

/**
 * Group sessions into the switcher's sections: the ones waiting on the user
 * (longest-waiting first), then open, starred, and the rest, each most
 * recently used first, with the current session last. A chat whose worktree
 * is gone cannot be opened, so it is left out.
 */
export function sectionSessions(
  snapshot: SwitcherSnapshot,
  filter: SwitcherFilter
): { section: SwitcherSection; chats: ChatSession[] }[] {
  const waitingRank = new Map(snapshot.needsYou.map((chatId, index) => [chatId, index]));
  const sections = new Map<SwitcherSection, ChatSession[]>(SECTIONS.map((section) => [section, []]));
  const recentFirst = (a: ChatSession, b: ChatSession) =>
    b.lastAccessedAt - a.lastAccessedAt || b.createdAt - a.createdAt;

  for (const chat of [...snapshot.chats].sort(recentFirst)) {
    const repoId = snapshot.repoOf(chat);
    if (
      repoId === undefined ||
      (filter.starredOnly && !snapshot.starred.has(chat.id)) ||
      (filter.repoId !== undefined && repoId !== filter.repoId)
    ) {
      continue;
    }
    const section: SwitcherSection =
      chat.id === snapshot.currentChatId
        ? 'current'
        : waitingRank.has(chat.id)
          ? 'needsYou'
          : snapshot.isOpen(chat)
            ? 'open'
            : snapshot.starred.has(chat.id)
              ? 'starred'
              : 'recent';
    sections.get(section)!.push(chat);
  }
  sections.get('needsYou')!.sort((a, b) => waitingRank.get(a.id)! - waitingRank.get(b.id)!);
  return SECTIONS.map((section) => ({ section, chats: sections.get(section)! })).filter(
    ({ chats }) => chats.length > 0
  );
}

export interface SessionSwitcherDeps {
  storage: Pick<
    StorageService,
    'getChats' | 'getChat' | 'getStarredChatIds' | 'getActiveChatId' | 'getRepository' | 'isStarred' | 'toggleStar'
  >;
  harnessRegistry: Pick<HarnessRegistry, 'get' | 'hasMultipleInstalled'>;
  extensionUri: vscode.Uri;
  getWorktree: (worktreeId: string) => Worktree | undefined;
  /** The worktree the Changes and Files panels show; its repository is the scope filter. */
  activeWorktree: () => Worktree | undefined;
  /** A live terminal or a native-UI tab. */
  isChatOpen: (chat: ChatSession) => boolean;
  /** A live terminal only; Close Session stops terminals. */
  isTerminalOpen: (chatId: string) => boolean;
  turnState: (chatId: string) => TurnState | undefined;
  /** What a session is waiting on the user for, while it waits. */
  waitingFor: (chatId: string) => string | undefined;
  sessionsNeedingYou: () => string[];
  /** Fires when a row's state may have changed: a turn, a terminal, a star, an import. */
  onDidChangeSessions: vscode.Event<unknown>;
  /** Open a chat the way a row click does. */
  open: (chat: ChatSession, worktree: Worktree) => Promise<void>;
  openInTerminal: (chat: ChatSession, worktree: Worktree) => Promise<void>;
  openInNativeUi: (chat: ChatSession, worktree: Worktree, nativeUi: NativeUiCapability) => Promise<void>;
  closeTerminal: (chatId: string) => void;
  refreshTree: () => void;
}

interface SessionItem extends vscode.QuickPickItem {
  chatId: string;
}
type SwitcherItem = SessionItem | vscode.QuickPickItem;

type RowAction = 'openInUi' | 'openInTerminal' | 'close' | 'star' | 'unstar';
interface RowButton extends vscode.QuickInputButton {
  action: RowAction;
}
interface FilterButton extends vscode.QuickInputButton {
  filter: 'starred' | 'repo';
}

const isSessionItem = (item: SwitcherItem | undefined): item is SessionItem =>
  item !== undefined && 'chatId' in item;

/**
 * **Switch Session…**: one quick pick over every session in the list.
 *
 * The order is fixed when the picker opens so rows never move under the
 * cursor; marks, stars, and waiting reasons update in place while it is open.
 * Running the command again while it is open moves to the next row, so a held
 * shortcut walks the list. Opening goes through the caller's row-click path,
 * so a pick obeys the same surface rules as the tree.
 */
export class SessionSwitcher implements vscode.Disposable {
  private active: OpenSwitcher | undefined;
  /** Presses made while the picker is being created, replayed once it shows; undefined when not opening. */
  private pressesWhileOpening: { starredOnly?: boolean }[] | undefined;
  private disposed = false;

  constructor(private readonly deps: SessionSwitcherDeps) {}

  /** Open the switcher, or move to the next row when it is already open. */
  async show(options: { starredOnly?: boolean } = {}): Promise<void> {
    if (this.active) {
      this.active.repeat(options);
      return;
    }
    if (this.pressesWhileOpening) {
      this.pressesWhileOpening.push(options);
      return;
    }
    const { storage } = this.deps;
    const chats = storage.getChats();
    if (options.starredOnly && !chats.some((chat) => storage.isStarred(chat.id))) {
      vscode.window.showInformationMessage(
        'No starred sessions. Star a session in the tree or in Switch Session to bookmark it.'
      );
      return;
    }
    if (chats.length === 0) {
      vscode.window.showInformationMessage('No sessions yet. Start one with New Session.');
      return;
    }

    this.pressesWhileOpening = [];
    try {
      const multiHarness = await this.deps.harnessRegistry.hasMultipleInstalled();
      // The extension may have been deactivated while we waited.
      if (this.disposed) {
        return;
      }
      this.active = new OpenSwitcher(this.deps, { starredOnly: Boolean(options.starredOnly) }, multiHarness, () => {
        this.active = undefined;
      });
      for (const press of this.pressesWhileOpening) {
        this.active.repeat(press);
      }
    } finally {
      this.pressesWhileOpening = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.active?.hide();
  }
}

/** One open picker: its fixed order, its filter, and its listeners. */
class OpenSwitcher {
  private readonly picker = vscode.window.createQuickPick<SwitcherItem>();
  private readonly disposables: vscode.Disposable[] = [];
  private order: { section: SwitcherSection; chatIds: string[] }[] = [];

  constructor(
    private readonly deps: SessionSwitcherDeps,
    private filter: SwitcherFilter,
    private readonly multiHarness: boolean,
    onHidden: () => void
  ) {
    const { picker } = this;
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    // Live updates replace the items; the list must not jump back to the top.
    picker.keepScrollPosition = true;
    this.disposables.push(
      picker.onDidAccept(() => {
        const item = picker.selectedItems[0] ?? picker.activeItems[0];
        if (isSessionItem(item)) {
          this.hide();
          void this.openChat(item.chatId, this.deps.open);
        }
      }),
      picker.onDidTriggerItemButton(({ item, button }) => {
        if (isSessionItem(item)) {
          this.runRowAction(item.chatId, (button as RowButton).action);
        }
      }),
      picker.onDidTriggerButton((button) => this.toggleFilter((button as FilterButton).filter)),
      deps.onDidChangeSessions(() => this.render()),
      picker.onDidHide(() => {
        for (const disposable of this.disposables) {
          disposable.dispose();
        }
        picker.dispose();
        onHidden();
      })
    );
    this.reorder();
    picker.show();
  }

  hide(): void {
    this.picker.hide();
  }

  /**
   * The command ran again while the picker is open: Starred Sessions narrows
   * an unfiltered list to starred rows; otherwise the next row becomes active,
   * wrapping at the end. A typed filter has its own visible order, so the
   * arrow keys move through that.
   */
  repeat(options: { starredOnly?: boolean }): void {
    if (options.starredOnly && !this.filter.starredOnly) {
      this.toggleFilter('starred');
      return;
    }
    const rows = this.picker.items.filter(isSessionItem);
    if (this.picker.value || rows.length === 0) {
      return;
    }
    const index = rows.indexOf(this.picker.activeItems[0] as SessionItem);
    this.picker.activeItems = [rows[(index + 1) % rows.length]];
  }

  /** Recompute the order from scratch: on open and when the filter changes. */
  private reorder(): void {
    const { storage } = this.deps;
    const repoOf = (chat: ChatSession) => this.deps.getWorktree(chat.worktreeId)?.repoId;
    this.order = sectionSessions(
      {
        chats: storage.getChats(),
        starred: storage.getStarredChatIds(),
        needsYou: this.deps.sessionsNeedingYou(),
        currentChatId: storage.getActiveChatId(),
        isOpen: this.deps.isChatOpen,
        repoOf,
      },
      this.filter
    ).map(({ section, chats }) => ({ section, chatIds: chats.map((chat) => chat.id) }));
    this.render({ resetActive: true });
  }

  /**
   * Rebuild the rows in the fixed order with their current state. A removed
   * chat drops out, an emptied section loses its header, and the active row
   * stays active.
   */
  private render(options: { resetActive?: boolean } = {}): void {
    const { picker } = this;
    const { storage } = this.deps;
    const activeId = options.resetActive ? undefined : (picker.activeItems[0] as SessionItem | undefined)?.chatId;
    const chats = new Map(storage.getChats().map((chat) => [chat.id, chat]));
    const starred = storage.getStarredChatIds();

    const items: SwitcherItem[] = [];
    for (const { section, chatIds } of this.order) {
      const rows = chatIds.flatMap((chatId) => {
        const chat = chats.get(chatId);
        const worktree = chat && this.deps.getWorktree(chat.worktreeId);
        return chat && worktree ? [this.row(chat, worktree, starred.has(chatId))] : [];
      });
      if (rows.length > 0) {
        items.push({ label: SECTION_LABELS[section], kind: vscode.QuickPickItemKind.Separator }, ...rows);
      }
    }

    picker.items = items;
    const keep = activeId ? items.find((item) => isSessionItem(item) && item.chatId === activeId) : undefined;
    if (keep) {
      picker.activeItems = [keep];
    }
    picker.title = this.title();
    picker.buttons = this.filterButtons();
    picker.placeholder = items.length > 0 ? PLACEHOLDER : this.emptyText();
  }

  private row(chat: ChatSession, worktree: Worktree, starred: boolean): SessionItem {
    const adapter = this.deps.harnessRegistry.get(chat.harness);
    const repoName = this.deps.storage.getRepository(worktree.repoId)?.name;
    const location = repoName && repoName !== worktree.name ? `${repoName} › ${worktree.name}` : worktree.name;
    const time = chat.harnessSessionId ? formatRelativeTime(chat.lastAccessedAt, { short: true }) : 'new';
    const waitingFor = this.deps.waitingFor(chat.id);
    const iconState = selectHarnessIconState(chat, this.deps.isChatOpen(chat), this.deps.turnState(chat.id));
    return {
      chatId: chat.id,
      label: chat.name,
      description: [location, starred ? `★ ${time}` : time, this.multiHarness ? adapter.displayName : undefined]
        .filter(Boolean)
        .join(' · '),
      // Only a waiting row has detail: what it is waiting for.
      detail: waitingFor ? `Waiting for you: ${waitingFor}` : undefined,
      iconPath: harnessIconPath(this.deps.extensionUri, adapter, iconState),
      buttons: this.rowButtons(chat, adapter, starred),
    };
  }

  /**
   * Hover actions: the explicit surfaces when the agent's UI extension is
   * installed (otherwise a pick already opens the terminal), Close for a live
   * terminal, and the star. Nothing that removes a row.
   */
  private rowButtons(chat: ChatSession, adapter: HarnessAdapter, starred: boolean): RowButton[] {
    const buttons: RowButton[] = [];
    const nativeUi = adapter.nativeUi;
    const sessionId = chatPrimarySessionId(chat);
    const inTerminal = this.deps.isTerminalOpen(chat.id);
    const uiInstalled = nativeUi?.isInstalled() ?? false;
    if (nativeUi && uiInstalled && sessionId && !nativeUi.surfaces?.isOpen(sessionId)) {
      buttons.push({
        action: 'openInUi',
        iconPath: new vscode.ThemeIcon('comment-discussion'),
        tooltip: `Open in ${nativeUi.displayName}`,
      });
    }
    if (uiInstalled && !inTerminal) {
      buttons.push({ action: 'openInTerminal', iconPath: new vscode.ThemeIcon('terminal'), tooltip: 'Open Session in Terminal' });
    }
    if (inTerminal) {
      buttons.push({ action: 'close', iconPath: new vscode.ThemeIcon('stop-circle'), tooltip: 'Close Session' });
    }
    buttons.push(
      starred
        ? { action: 'unstar', iconPath: new vscode.ThemeIcon('star-full'), tooltip: 'Unstar Session' }
        : { action: 'star', iconPath: new vscode.ThemeIcon('star-empty'), tooltip: 'Star Session' }
    );
    return buttons;
  }

  private runRowAction(chatId: string, action: RowAction): void {
    const { storage } = this.deps;
    const chat = storage.getChat(chatId);
    if (!chat) {
      this.render();
      return;
    }
    switch (action) {
      case 'star':
      case 'unstar':
        // Set, not flip: the row may be stale if the tree changed the star.
        if (storage.isStarred(chatId) !== (action === 'star')) {
          storage.toggleStar(chatId);
        }
        this.deps.refreshTree();
        this.render();
        return;
      case 'close':
        this.deps.closeTerminal(chatId);
        this.deps.refreshTree();
        this.render();
        return;
      case 'openInTerminal':
        this.hide();
        void this.openChat(chatId, this.deps.openInTerminal);
        return;
      case 'openInUi': {
        const nativeUi = this.deps.harnessRegistry.get(chat.harness).nativeUi;
        this.hide();
        if (nativeUi) {
          void this.openChat(chatId, (current, worktree) => this.deps.openInNativeUi(current, worktree, nativeUi));
        }
        return;
      }
    }
  }

  /** Open the chat's current record; it may have been removed while the picker was open. */
  private async openChat(chatId: string, open: (chat: ChatSession, worktree: Worktree) => Promise<void>): Promise<void> {
    const chat = this.deps.storage.getChat(chatId);
    if (!chat) {
      vscode.window.showInformationMessage('That session is no longer in the list.');
      return;
    }
    const worktree = this.deps.getWorktree(chat.worktreeId);
    if (!worktree) {
      vscode.window.showErrorMessage('Could not find worktree for this session.');
      return;
    }
    try {
      await open(chat, worktree);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open "${chat.name}": ${errorMessage(error)}`);
    }
  }

  private toggleFilter(filter: FilterButton['filter']): void {
    if (filter === 'starred') {
      this.filter = { ...this.filter, starredOnly: !this.filter.starredOnly };
    } else {
      this.filter = { ...this.filter, repoId: this.filter.repoId ? undefined : this.scopeRepo()?.id };
    }
    this.reorder();
  }

  /**
   * The repository the scope filter narrows to: the one the panels show, when
   * the list has sessions somewhere else too.
   */
  private scopeRepo(): { id: string; name: string } | undefined {
    const repoId = this.deps.activeWorktree()?.repoId;
    const repo = repoId ? this.deps.storage.getRepository(repoId) : undefined;
    if (!repo) {
      return undefined;
    }
    const elsewhere = this.deps.storage
      .getChats()
      .some((chat) => {
        const other = this.deps.getWorktree(chat.worktreeId)?.repoId;
        return other !== undefined && other !== repo.id;
      });
    return elsewhere ? repo : undefined;
  }

  private filterButtons(): FilterButton[] {
    const { starredOnly, repoId } = this.filter;
    const buttons: FilterButton[] = [
      {
        filter: 'starred',
        iconPath: new vscode.ThemeIcon(starredOnly ? 'star-full' : 'star-empty'),
        tooltip: starredOnly ? 'Show All Sessions' : 'Show Starred Sessions Only',
      },
    ];
    const scope = repoId ? this.deps.storage.getRepository(repoId) : this.scopeRepo();
    if (scope) {
      buttons.push({
        filter: 'repo',
        iconPath: new vscode.ThemeIcon(repoId ? 'filter-filled' : 'filter'),
        tooltip: repoId ? 'Show Every Repository' : `Show ${scope.name} Only`,
      });
    }
    return buttons;
  }

  private title(): string {
    const base = this.filter.starredOnly ? 'Starred Sessions' : 'Switch Session';
    const repoName = this.filter.repoId && this.deps.storage.getRepository(this.filter.repoId)?.name;
    return repoName ? `${base} · ${repoName}` : base;
  }

  private emptyText(): string {
    const repoName = this.filter.repoId && this.deps.storage.getRepository(this.filter.repoId)?.name;
    const what = this.filter.starredOnly ? 'No starred sessions' : 'No sessions';
    return repoName ? `${what} in ${repoName}` : what;
  }
}
