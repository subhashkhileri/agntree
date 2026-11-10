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

const REFRESH_DEBOUNCE_MS = 300;
/** PR badges are re-fetched this often. */
const PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Every row render could ask for ahead/behind, and each count is a git process. */
const SYNC_CACHE_MS = 15_000;

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
  private readonly prRefreshTimer: NodeJS.Timeout;

  private readonly scheduledRefresh = debounce(() => {
    if (this.pendingCacheClear) {
      this.pendingCacheClear = false;
      this.worktreeCache.clear();
      this.gitHubService.clearCache();
    }
    this.updateRepoWatchers();
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

  /** Required by `TreeView.reveal()`. */
  getParent(element: WorkspaceTreeItem): WorkspaceTreeItem | undefined {
    if (element.itemType === 'chat') {
      const worktree = this.getWorktreeById((element.data as ChatSession).worktreeId);
      return worktree ? this.getTreeItemForWorktree(worktree) : undefined;
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
    item.iconPath = new vscode.ThemeIcon(isGit ? 'repo' : 'folder', new vscode.ThemeColor('descriptionForeground'));
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

      // Color marks state, not identity: amber for the open workspace, blue
      // for a PR checkout, green for the main worktree, neutral otherwise.
      const [icon, color] = isCurrent
        ? ['target', 'charts.yellow']
        : checkedOutPR
          ? ['git-pull-request', 'charts.blue']
          : ['git-branch', worktree.isMain ? 'charts.green' : 'descriptionForeground'];
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

  private async chatRows(worktree: Worktree): Promise<WorkspaceTreeItem[]> {
    const chats = this.storageService.getChatsByWorktree(worktree.id);
    const starredIds = this.storageService.getStarredChatIds();

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

    // One stable order: newest first by creation time. Opening, resuming, or
    // starring a chat never moves its row; the mark carries the active state.
    chats.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    return chats.map((chat) => {
      const isOpen = this.chatOpenProvider(chat);
      const isStarred = starredIds.has(chat.id);
      const meta = metadata.get(chat.id) ?? null;
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
      item.description = isStarred ? `★ ${time}` : time;

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
    if (item?.itemType === 'worktree') {
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
