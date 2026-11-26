import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, RepositoryWorktrees, Worktree, ChatSession, TreeItemType } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { GitHubService } from '../services/GitHubService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { selectHarnessIconState } from '../harnesses/sessionUtils';
import { harnessIconPath } from '../harnesses/treeIcons';
import { HarnessAdapter, SessionMetadata, TurnState } from '../harnesses/types';
import { formatRelativeTime } from '../utils/text';
import { debounce } from '../utils/debounce';
import { chatTooltip } from './chatTooltip';
import { sessionRowUri } from './StarredSessionDecorations';

const REFRESH_DEBOUNCE_MS = 300;
/** PR badges are re-fetched this often. */
const PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Every row render could ask for ahead/behind, and each count is a git process. */
const SYNC_CACHE_MS = 15_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A fold row that would hide fewer sessions than this is not shown. */
const MIN_FOLDED_SESSIONS = 2;

interface SessionLayout {
  /** Display order: starred first unless turned off, then newest first by creation. */
  chats: ChatSession[];
  starredIds: Set<string>;
  metadata: Map<string, SessionMetadata | null>;
  /** Chats listed under the worktree's Show more row instead of directly under it. */
  folded: Set<string>;
  /** `agntree.foldOlderSessionsAfterDays`; 0 means folding is off. */
  foldDays: number;
}

/** `agntree.foldOlderSessionsAfterDays`, with anything but a positive number meaning off. */
function foldAfterDays(config: vscode.WorkspaceConfiguration): number {
  const days = Number(config.get<number>('foldOlderSessionsAfterDays', 3));
  return Number.isFinite(days) && days > 0 ? days : 0;
}

/**
 * Whether a chat has had no activity, and no visit, for `days` days. A visit
 * counts, so a session you returned to stays in view. An unknown time is not
 * evidence that a chat is old.
 */
function quietFor(chat: ChatSession, meta: SessionMetadata | null, days: number): boolean {
  const lastActive = Math.max(meta?.lastActivity ?? 0, chat.lastAccessedAt ?? 0);
  return lastActive > 0 && Date.now() - lastActive > days * DAY_MS;
}

export class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    public readonly data: Repository | Worktree | ChatSession,
    public readonly contextValue: string
  ) {
    super(label, collapsibleState);
    // Stable across refreshes, so selection, expansion, and reveal survive.
    this.id = `${itemType}-${data.id}`;
  }
}

/**
 * The Workspaces view: workspace roots, their git worktrees, and the session
 * rows in each. A plain folder skips the worktree level and owns its sessions
 * directly.
 */
export class WorkspacesTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  /** Worktrees per repository id, kept until the next hard refresh. */
  private readonly worktreeCache = new Map<string, RepositoryWorktrees>();
  /** Ahead/behind counts per worktree path. */
  private readonly syncCache = new Map<string, { ahead: number; behind: number; fetchedAt: number }>();

  private turnStateProvider: (chatId: string) => TurnState | undefined = () => undefined;
  private chatOpenProvider: (chat: ChatSession) => boolean;

  private repoWatchers: vscode.Disposable[] = [];
  private watchedRepoIds = '';
  private pendingCacheClear = false;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Per worktree rendered this session: the chats its Show more row held at
   * the last render, and how many times that row has been re-keyed to
   * collapse it. Entries go when their worktree has no chats left.
   */
  private readonly lastFolded = new Map<string, Set<string>>();
  private readonly olderRowGeneration = new Map<string, number>();
  private readonly prRefreshTimer: NodeJS.Timeout;

  private readonly scheduledRefresh = debounce(() => {
    if (this.pendingCacheClear) {
      this.pendingCacheClear = false;
      this.worktreeCache.clear();
      this.gitHubService.clearCache();
    }
    this.updateRepoWatchers();
    this.forgetEmptyWorktrees();
    this.changeEmitter.fire();
  }, REFRESH_DEBOUNCE_MS);

  /** A branch switch, `git init`, or `.git` removal changes worktrees and upstream distance. */
  private readonly onGitChange = debounce(() => {
    this.syncCache.clear();
    this.refresh();
  }, REFRESH_DEBOUNCE_MS);

  constructor(
    private readonly storageService: StorageService,
    private readonly gitService: GitService,
    terminalManager: TerminalManager,
    private readonly harnessRegistry: HarnessRegistry,
    private readonly gitHubService: GitHubService,
    private readonly extensionUri: vscode.Uri
  ) {
    this.chatOpenProvider = (chat) => terminalManager.isActive(chat.id);
    // A terminal opening or closing only changes its row's mark.
    this.disposables.push(terminalManager.onTerminalStateChange(() => this.softRefresh()));
    // Fold age and starred order change which rows a worktree lists.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration('agntree.foldOlderSessionsAfterDays') ||
          event.affectsConfiguration('agntree.starredSessionsFirst') ||
          // Without decoration badges a starred row carries its star in the
          // description, which only a fresh getTreeItem picks up.
          event.affectsConfiguration('explorer.decorations.badges')
        ) {
          this.softRefresh();
        }
      })
    );
    this.updateRepoWatchers();
    this.prRefreshTimer = setInterval(() => {
      this.gitHubService.clearCache();
      this.changeEmitter.fire();
    }, PR_REFRESH_INTERVAL_MS);
  }

  dispose(): void {
    this.scheduledRefresh.cancel();
    this.onGitChange.cancel();
    clearInterval(this.prRefreshTimer);
    for (const disposable of [...this.disposables, ...this.repoWatchers]) {
      disposable.dispose();
    }
    this.changeEmitter.dispose();
  }

  /** Live turn state for the working/done mark, wired once the attention service exists. */
  setTurnStateProvider(provider: (chatId: string) => TurnState | undefined): void {
    this.turnStateProvider = provider;
  }

  /** The one "is this chat open" predicate: a live terminal or a mapped native-UI tab. */
  setChatOpenProvider(provider: (chat: ChatSession) => boolean): void {
    this.chatOpenProvider = provider;
  }

  /** Re-render and re-list worktrees and PRs (debounced). */
  refresh(): void {
    this.pendingCacheClear = true;
    this.scheduledRefresh();
  }

  /** Re-render rows whose content changed, keeping the worktree and PR caches. */
  softRefresh(): void {
    this.scheduledRefresh();
  }

  /** The PR URL for a worktree's branch, once its badge has been looked up. */
  getPRUrl(worktree: Worktree): string | undefined {
    const repo = this.storageService.getRepository(worktree.repoId);
    return repo ? this.gitHubService.getCachedPRInfo(repo.rootPath, worktree.name)?.url : undefined;
  }

  /**
   * Watch each root's HEADs (branch switches) and `.git` itself (`git init`
   * or its removal). Rebuilt only when the set of roots changes, or when
   * `.git` appears or disappears, since the HEAD patterns need it to exist.
   */
  private updateRepoWatchers(force = false): void {
    const repositories = this.storageService.getRepositories();
    const ids = repositories.map((r) => r.id).sort().join(',');
    if (!force && ids === this.watchedRepoIds) {
      return;
    }
    this.watchedRepoIds = ids;
    this.repoWatchers.forEach((watcher) => watcher.dispose());
    this.repoWatchers = [];

    const watch = (base: string, pattern: string, events: ('change' | 'create' | 'delete')[], onEvent: () => void) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      if (events.includes('change')) watcher.onDidChange(onEvent);
      if (events.includes('create')) watcher.onDidCreate(onEvent);
      if (events.includes('delete')) watcher.onDidDelete(onEvent);
      this.repoWatchers.push(watcher);
    };
    for (const repo of repositories) {
      const gitDir = path.join(repo.rootPath, '.git');
      watch(gitDir, 'HEAD', ['change', 'create'], this.onGitChange);
      watch(gitDir, 'worktrees/*/HEAD', ['change', 'create'], this.onGitChange);
      watch(repo.rootPath, '.git', ['create', 'delete'], () => {
        this.updateRepoWatchers(true);
        this.onGitChange();
      });
    }
  }

  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Fill a chat tooltip on hover. Only rows whose harness builds previews from
   * an expensive export arrive here without one; the adapter caches the
   * export, so hovering again is cheap and a later render picks up new turns.
   */
  async resolveTreeItem(item: vscode.TreeItem, element: WorkspaceTreeItem): Promise<vscode.TreeItem> {
    if (element.itemType !== 'chat' || item.tooltip !== undefined) {
      return item;
    }
    const chat = element.data as ChatSession;
    const adapter = this.harnessRegistry.get(chat.harness);
    let meta: SessionMetadata | null = null;
    if (chat.harnessSessionId) {
      await adapter.getPreview(chat.harnessSessionId, 3).catch(() => undefined);
      meta = await adapter
        .getSessionMetadata(chat.harnessSessionId, this.getWorktreeById(chat.worktreeId)?.path)
        .catch(() => null);
    }
    item.tooltip = chatTooltip(chat, adapter.displayName, meta);
    return item;
  }

  /**
   * Required by `TreeView.reveal()`. A folded chat's parent is its worktree's
   * Show more row, so revealing it from Switch Session or a notification opens
   * that row.
   */
  async getParent(element: WorkspaceTreeItem): Promise<WorkspaceTreeItem | undefined> {
    if (element.itemType === 'chat') {
      const chat = element.data as ChatSession;
      const worktree = this.getWorktreeById(chat.worktreeId);
      if (!worktree) {
        return undefined;
      }
      const layout = await this.sessionLayout(worktree);
      return layout.folded.has(chat.id) ? this.olderSessionsItem(worktree, layout) : this.getTreeItemForWorktree(worktree);
    }
    if (element.itemType === 'olderSessions') {
      return this.getTreeItemForWorktree(element.data as Worktree);
    }
    if (element.itemType === 'worktree') {
      const repo = this.storageService.getRepository((element.data as Worktree).repoId);
      return repo ? this.repositoryItem(repo, vscode.TreeItemCollapsibleState.Expanded) : undefined;
    }
    return undefined;
  }

  async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
    if (!element) {
      return this.storageService.getRepositories().map((repo) => this.repositoryRow(repo));
    }
    if (element.itemType === 'repository') {
      const repo = element.data as Repository;
      const { isGit, worktrees } = this.getRepoWorktrees(repo);
      return isGit ? this.worktreeRows(repo, worktrees) : this.chatRows(worktrees[0]);
    }
    if (element.itemType === 'worktree') {
      return this.chatRows(element.data as Worktree);
    }
    if (element.itemType === 'olderSessions') {
      return this.olderSessionRows(element.data as Worktree);
    }
    return [];
  }

  private repositoryItem(repo: Repository, state: vscode.TreeItemCollapsibleState): WorkspaceTreeItem {
    const { isGit } = this.getRepoWorktrees(repo);
    return new WorkspaceTreeItem(repo.name, state, 'repository', repo, isGit ? 'repository' : 'folderRepository');
  }

  private repositoryRow(repo: Repository): WorkspaceTreeItem {
    const { isGit, worktrees } = this.getRepoWorktrees(repo);
    // A plain folder with no sessions has nothing to expand into.
    const canExpand = isGit || this.storageService.getChatsByWorktree(worktrees[0].id).length > 0;
    const item = this.repositoryItem(
      repo,
      canExpand ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = new vscode.ThemeIcon(isGit ? 'repo' : 'folder', new vscode.ThemeColor('charts.purple'));
    item.tooltip = isGit
      ? repo.rootPath
      : `${repo.rootPath}\n\nNot a git repository. Sessions run directly in this folder.`;
    return item;
  }

  /** A repository's worktrees and git state, listed once per hard refresh. */
  private getRepoWorktrees(repo: Repository): RepositoryWorktrees {
    let entry = this.worktreeCache.get(repo.id);
    if (!entry) {
      entry = this.gitService.listRepositoryWorktrees(repo.rootPath, repo.id);
      this.worktreeCache.set(repo.id, entry);
    }
    return entry;
  }

  private worktreeItem(worktree: Worktree, state: vscode.TreeItemCollapsibleState): WorkspaceTreeItem {
    return new WorkspaceTreeItem(worktree.name, state, 'worktree', worktree, 'worktree');
  }

  private worktreeRows(repo: Repository, worktrees: Worktree[]): WorkspaceTreeItem[] {
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const unknownPRs: string[] = [];

    const rows = worktrees.map((worktree) => {
      const item = this.worktreeItem(worktree, vscode.TreeItemCollapsibleState.Collapsed);
      const isCurrent = currentFolder === worktree.path;
      const checkedOutPR = this.storageService.getPRWorktree(worktree.id);
      const pr = this.gitHubService.getCachedPRInfo(repo.rootPath, worktree.name);
      if (pr === undefined) {
        unknownPRs.push(worktree.name);
      }

      // Shape says what a worktree is: a house for the main one, a pull
      // request for a PR checkout, a branch otherwise. Each color has one
      // meaning: blue is where you are, purple is the repository (its main
      // worktree shares it), cyan a PR checkout. Green, amber, and red stay
      // free for the session marks and git status.
      const icon = worktree.isMain ? 'home' : checkedOutPR ? 'git-pull-request' : 'git-branch';
      const color = isCurrent
        ? 'charts.blue'
        : worktree.isMain
          ? 'charts.purple'
          : checkedOutPR
            ? 'terminal.ansiCyan'
            : 'descriptionForeground';
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));

      const sync = this.getSyncState(worktree.path);
      const prNumber = checkedOutPR ?? pr?.number;
      const description = [
        isCurrent ? '●' : '',
        sync?.ahead ? `↑${sync.ahead}` : '',
        sync?.behind ? `↓${sync.behind}` : '',
        prNumber ? `PR #${prNumber}` : '',
      ].filter(Boolean);
      if (description.length > 0) {
        item.description = description.join(' · ');
      }
      item.tooltip = [worktree.path, isCurrent ? 'Active workspace' : '', pr ? `PR #${pr.number}: ${pr.title}` : '']
        .filter(Boolean)
        .join('\n\n');
      return item;
    });

    if (unknownPRs.length > 0) {
      void Promise.all(unknownPRs.map((branch) => this.gitHubService.fetchPRInfo(repo.rootPath, branch))).then(() =>
        this.changeEmitter.fire()
      );
    }
    return rows;
  }

  private getSyncState(worktreePath: string): { ahead: number; behind: number } | null {
    const cached = this.syncCache.get(worktreePath);
    if (cached && Date.now() - cached.fetchedAt < SYNC_CACHE_MS) {
      return cached;
    }
    const state = this.gitService.getAheadBehind(worktreePath);
    if (state) {
      this.syncCache.set(worktreePath, { ...state, fetchedAt: Date.now() });
    } else {
      this.syncCache.delete(worktreePath);
    }
    return state;
  }

  /** Drop the fold records of worktrees that no longer have any chats. */
  private forgetEmptyWorktrees(): void {
    for (const worktreeId of this.lastFolded.keys()) {
      if (this.storageService.getChatsByWorktree(worktreeId).length === 0) {
        this.lastFolded.delete(worktreeId);
        this.olderRowGeneration.delete(worktreeId);
      }
    }
  }

  /**
   * A worktree's chats in display order, with their cached metadata and the
   * quiet ones that fold under its Show more row. Rendering a worktree,
   * expanding that row, and `getParent()` for `reveal()` all read this one layout.
   */
  private async sessionLayout(worktree: Worktree): Promise<SessionLayout> {
    const chats = this.storageService.getChatsByWorktree(worktree.id);
    const starredIds = this.storageService.getStarredChatIds();
    const config = vscode.workspace.getConfiguration('agntree');

    // Adapters answer from their caches; a lazy-preview harness leaves the
    // preview empty until resolveTreeItem asks for it on hover.
    const metadata = new Map<string, SessionMetadata | null>(
      await Promise.all(
        chats.map(async (chat): Promise<[string, SessionMetadata | null]> => [
          chat.id,
          chat.harnessSessionId
            ? await this.harnessRegistry
                .get(chat.harness)
                .getSessionMetadata(chat.harnessSessionId, worktree.path)
                .catch(() => null)
            : null,
        ])
      )
    );

    // Starred chats first (unless turned off), then the rest, each newest
    // first by creation time. Only starring or unstarring moves a row;
    // opening, resuming, and activity change its mark and description.
    const starredFirst = config.get<boolean>('starredSessionsFirst', true);
    chats.sort(
      (a, b) =>
        (starredFirst ? Number(starredIds.has(b.id)) - Number(starredIds.has(a.id)) : 0) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0)
    );

    // Quiet chats fold away; starred and open ones never do. A fold row that
    // hides a single chat saves nothing, so that chat stays in place.
    const foldDays = foldAfterDays(config);
    const quiet =
      foldDays > 0
        ? chats.filter(
            (chat) =>
              !starredIds.has(chat.id) &&
              !this.chatOpenProvider(chat) &&
              // A linked chat whose metadata has not loaded may be busy
              // today; it folds once its activity is known, so it never
              // folds and then jumps back out.
              !(chat.harnessSessionId && !metadata.get(chat.id)) &&
              quietFor(chat, metadata.get(chat.id) ?? null, foldDays)
          )
        : [];
    const folded = new Set(quiet.length >= MIN_FOLDED_SESSIONS ? quiet.map((chat) => chat.id) : []);
    return { chats, starredIds, metadata, folded, foldDays };
  }

  private async chatRows(worktree: Worktree): Promise<WorkspaceTreeItem[]> {
    const layout = await this.sessionLayout(worktree);
    this.collapseOlderRowIfLeft(worktree, layout);
    const rows = this.sessionItems(layout, layout.chats.filter((chat) => !layout.folded.has(chat.id)));
    return layout.folded.size > 0 ? [...rows, this.olderSessionsItem(worktree, layout)] : rows;
  }

  /**
   * VS Code keeps a row's expanded state by id and has no API to collapse one
   * row. Once a chat leaves the Show more row (still listed, no longer folded),
   * the row gets a new id, so it comes back collapsed. A removed chat does not
   * count: deleting several from an open Show more row keeps it open.
   */
  private collapseOlderRowIfLeft(worktree: Worktree, layout: SessionLayout): void {
    const previous = this.lastFolded.get(worktree.id);
    this.lastFolded.set(worktree.id, layout.folded);
    const listed = new Set(layout.chats.map((chat) => chat.id));
    if (previous && [...previous].some((id) => listed.has(id) && !layout.folded.has(id))) {
      this.olderRowGeneration.set(worktree.id, (this.olderRowGeneration.get(worktree.id) ?? 0) + 1);
    }
  }

  private async olderSessionRows(worktree: Worktree): Promise<WorkspaceTreeItem[]> {
    const layout = await this.sessionLayout(worktree);
    return this.sessionItems(layout, layout.chats.filter((chat) => layout.folded.has(chat.id)));
  }

  /** The collapsed row at the bottom of a worktree that holds its quiet sessions. */
  private olderSessionsItem(worktree: Worktree, layout: SessionLayout): WorkspaceTreeItem {
    const item = new WorkspaceTreeItem(
      `Show more (${layout.folded.size})`,
      vscode.TreeItemCollapsibleState.Collapsed,
      'olderSessions',
      worktree,
      'olderSessions'
    );
    const generation = this.olderRowGeneration.get(worktree.id);
    if (generation) {
      item.id = `olderSessions-${worktree.id}-${generation}`;
    }
    item.iconPath = new vscode.ThemeIcon('history', new vscode.ThemeColor('disabledForeground'));
    const age = layout.foldDays === 1 ? 'day' : `${layout.foldDays} days`;
    item.tooltip = `Sessions with no activity in the last ${age}. Starred and open sessions never fold here. Change the days, or turn folding off, with the agntree.foldOlderSessionsAfterDays setting.`;
    return item;
  }

  private sessionItems(layout: SessionLayout, chats: ChatSession[]): WorkspaceTreeItem[] {
    // A starred row's star is a decoration badge on its resourceUri
    // (StarredSessionDecorations). With decoration badges turned off the star
    // stays in the description; the tree re-renders when that setting changes.
    const starBadges = vscode.workspace.getConfiguration('explorer.decorations').get<boolean>('badges', true);

    return chats.map((chat) => {
      const isOpen = this.chatOpenProvider(chat);
      const isStarred = layout.starredIds.has(chat.id);
      const meta = layout.metadata.get(chat.id) ?? null;
      const adapter = this.harnessRegistry.get(chat.harness);
      const item = new WorkspaceTreeItem(
        chat.name,
        vscode.TreeItemCollapsibleState.None,
        'chat',
        chat,
        chatContextValue(adapter, isOpen, isStarred)
      );
      item.iconPath = harnessIconPath(
        this.extensionUri,
        adapter,
        selectHarnessIconState(chat, isOpen, this.turnStateProvider(chat.id))
      );

      const time = chat.harnessSessionId
        ? formatRelativeTime(meta?.lastActivity ?? (isOpen ? Date.now() : chat.lastAccessedAt), { short: true })
        : 'new';
      item.resourceUri = sessionRowUri(chat.id);
      item.description = isStarred && !starBadges ? `★ ${time}` : time;
      if (isStarred) {
        // Screen readers read the label and description, which no longer carry the star.
        item.accessibilityInformation = { label: `${chat.name}, starred, ${time}` };
      }

      // A lazy-preview harness needs an export for the last exchange; leave
      // the tooltip unset so only the hovered row pays for it.
      const needsPreview =
        meta !== null && meta.preview.length === 0 && adapter.capabilities.preview === 'lazy';
      if (!needsPreview) {
        item.tooltip = chatTooltip(chat, adapter.displayName, meta);
      }
      item.command = { command: 'agntree.openChat', title: 'Open Chat', arguments: [item] };
      return item;
    });
  }

  /** A minimal chat row for `reveal()`. */
  getChatTreeItem(chat: ChatSession): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      chat.name,
      vscode.TreeItemCollapsibleState.None,
      'chat',
      chat,
      chatContextValue(
        this.harnessRegistry.get(chat.harness),
        this.chatOpenProvider(chat),
        this.storageService.isStarred(chat.id)
      )
    );
  }

  /**
   * The row that represents a worktree. A plain folder's root worktree has no
   * row of its own, so its folder row stands in.
   */
  getTreeItemForWorktree(worktree: Worktree): WorkspaceTreeItem {
    const repo = this.storageService.getRepository(worktree.repoId);
    return repo && !this.getRepoWorktrees(repo).isGit
      ? this.repositoryItem(repo, vscode.TreeItemCollapsibleState.Expanded)
      : this.worktreeItem(worktree, vscode.TreeItemCollapsibleState.Expanded);
  }

  getWorktreeById(worktreeId: string): Worktree | undefined {
    return this.findWorktree((worktree) => worktree.id === worktreeId);
  }

  findWorktreeByPath(targetPath: string): Worktree | undefined {
    return this.findWorktree((worktree) => worktree.path === targetPath);
  }

  isGitRepo(repo: Repository): boolean {
    return this.getRepoWorktrees(repo).isGit;
  }

  /** Whether a worktree is git-backed; a plain folder's own worktree is not. */
  isGitWorktree(worktree: Worktree): boolean {
    const repo = this.storageService.getRepository(worktree.repoId);
    return repo ? this.getRepoWorktrees(repo).isGit : this.gitService.isGitRepository(worktree.path);
  }

  /**
   * The worktree a row's actions apply to: a worktree row, or the single
   * worktree a plain folder row stands in for.
   */
  getWorktreeForItem(item?: WorkspaceTreeItem): Worktree | undefined {
    if (item?.itemType === 'worktree' || item?.itemType === 'olderSessions') {
      return item.data as Worktree;
    }
    if (item?.itemType === 'repository') {
      const { isGit, worktrees } = this.getRepoWorktrees(item.data as Repository);
      return isGit ? undefined : worktrees[0];
    }
    return undefined;
  }

  /**
   * Search the cached worktrees, listing each root at most once. Startup
   * resolves restored chats before the tree renders, so without the cache
   * every chat would run `git worktree list` again.
   */
  private findWorktree(predicate: (worktree: Worktree) => boolean): Worktree | undefined {
    for (const repo of this.storageService.getRepositories()) {
      const found = this.getRepoWorktrees(repo).worktrees.find(predicate);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
}

/**
 * The context value names the row state for menus; an adapter with a native
 * UI appends its own suffix so that UI's entry targets only its rows.
 */
function chatContextValue(adapter: HarnessAdapter, isOpen: boolean, isStarred: boolean): string {
  const base = isOpen ? (isStarred ? 'runningStarredChat' : 'runningChat') : isStarred ? 'starredChat' : 'chat';
  return `${base}${adapter.nativeUi?.contextValueSuffix ?? ''}`;
}
