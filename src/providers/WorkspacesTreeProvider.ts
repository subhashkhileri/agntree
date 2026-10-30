import * as vscode from 'vscode';
import * as path from 'path';
import {
  Repository,
  RepositoryWorktrees,
  Worktree,
  ChatSession,
  TreeItemType,
} from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { GitHubService } from '../services/GitHubService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { harnessSessionKey, lastExchange, selectHarnessIconState, sessionUsageLine } from '../harnesses/sessionUtils';
import { harnessIconPath } from '../harnesses/treeIcons';
import {
  HarnessAdapter,
  HarnessIconState,
  PreviewMessage,
  SessionMetadata,
  TurnState,
} from '../harnesses/types';
import { clampInlineText, formatRelativeTime } from '../utils/text';

/** Codicon fallback for harnesses that ship no custom art. */
const FALLBACK_CHAT_ICONS: Record<
  HarnessIconState,
  { id: string; color: string }
> = {
  working: { id: 'pulse', color: 'charts.green' },
  done: { id: 'circle-filled', color: 'charts.green' },
  closed: { id: 'history', color: 'charts.orange' },
  new: { id: 'comment', color: 'charts.foreground' },
};

/**
 * Tree item representing a node in the workspaces tree
 */
export class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    public readonly data: Repository | Worktree | ChatSession,
    public readonly contextValue: string
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    // Set stable ID for tree item identification across refreshes
    this.id = `${itemType}-${data.id}`;
  }
}

/**
 * Provides the tree data for the Workspaces view
 */
export class WorkspacesTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkspaceTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache of effective worktrees and git state by repository ID */
  private worktreeCache = new Map<string, RepositoryWorktrees>();

  /** Cache of ahead/behind state, keyed by worktree path */
  private syncCache = new Map<
    string,
    { ahead: number; behind: number; fetchedAt: number }
  >();

  /** Lazily fetched previews for harnesses that do not inline them */
  private previewCache = new Map<string, PreviewMessage[]>();

  /**
   * Live turn state per chat, wired to the attention service after both exist.
   * Undefined means the harness has not reported one yet.
   */
  private turnStateProvider: (chatId: string) => TurnState | undefined =
    () => undefined;

  /**
   * Whether a chat is open. The extension wires this to the one predicate
   * shared by the tree, attention tick, and importer; the default keeps the
   * terminal check for callers that construct the provider alone.
   */
  private chatOpenProvider: (chat: ChatSession) => boolean = () => false;

  /** Service for GitHub PR status */
  private gitHubService = new GitHubService();

  /** Map of worktree ID to PR URL for context menu */
  private worktreePRUrls = new Map<string, string>();

  /** Git watchers per repository: HEAD, linked-worktree HEADs, and `.git` itself */
  private repoWatchers: vscode.FileSystemWatcher[] = [];

  /** Disposable for terminal state change listener */
  private terminalStateDisposable: vscode.Disposable;

  /** Debounce timer for HEAD change refresh */
  private headRefreshTimer: NodeJS.Timeout | undefined;

  /** Debounce timer for coalescing rapid refresh() calls */
  private refreshDebounceTimer: NodeJS.Timeout | undefined;

  /** Whether the pending debounced refresh should also drop caches */
  private pendingCacheClear = false;

  /** Tracks which repos have git watchers, to avoid unnecessary recreation */
  private watchedRepoIds = '';

  /** Generation counter to discard stale PR background fetches */
  private prFetchGeneration = 0;

  /** Timer for periodic PR status refresh (every 5 minutes) */
  private prRefreshInterval: NodeJS.Timeout | undefined;

  /** PR refresh interval in milliseconds (5 minutes) */
  private static readonly PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  /** Debounce window for coalescing refresh calls (ms) */
  private static readonly REFRESH_DEBOUNCE_MS = 300;

  /** How long ahead/behind counts stay cached (ms) */
  private static readonly SYNC_CACHE_MS = 15_000;

  constructor(
    private storageService: StorageService,
    private gitService: GitService,
    private terminalManager: TerminalManager,
    private harnessRegistry: HarnessRegistry,
    private extensionUri: vscode.Uri
  ) {
    this.chatOpenProvider = (chat) => terminalManager.isActive(chat.id);

    // Refresh when terminal state changes
    this.terminalStateDisposable = terminalManager.onTerminalStateChange(() => {
      this.refresh();
    });

    // Watch for branch changes (git checkout/switch) and `.git` appearing
    this.setupRepoWatchers();

    // Start periodic PR status refresh (every 5 minutes)
    this.prRefreshInterval = setInterval(() => {
      this.gitHubService.clearCache();
      this._onDidChangeTreeData.fire(undefined);
    }, WorkspacesTreeProvider.PR_REFRESH_INTERVAL_MS);
  }

  /**
   * Set up the git watchers for every repository: HEAD changes to detect
   * branch switches, and `.git` itself to detect `git init` or its removal.
   * Uses RelativePattern with absolute paths to watch repositories outside workspace.
   */
  setupRepoWatchers(): void {
    // Dispose existing watchers
    this.repoWatchers.forEach(w => w.dispose());
    this.repoWatchers = [];

    const debouncedRefresh = () => {
      if (this.headRefreshTimer) {
        clearTimeout(this.headRefreshTimer);
      }
      this.headRefreshTimer = setTimeout(() => {
        // A branch switch changes the upstream distance.
        this.syncCache.clear();
        this.refresh();
      }, 300); // 300ms debounce
    };

    // Create watchers for each repository
    const repositories = this.storageService.getRepositories();
    for (const repo of repositories) {
      const gitDir = path.join(repo.rootPath, '.git');

      // Watch main worktree HEAD: .git/HEAD
      const mainPattern = new vscode.RelativePattern(gitDir, 'HEAD');
      const mainWatcher = vscode.workspace.createFileSystemWatcher(mainPattern);
      mainWatcher.onDidChange(debouncedRefresh);
      mainWatcher.onDidCreate(debouncedRefresh);
      this.repoWatchers.push(mainWatcher);

      // Watch other worktrees HEAD: .git/worktrees/*/HEAD
      const worktreesPattern = new vscode.RelativePattern(gitDir, 'worktrees/*/HEAD');
      const worktreesWatcher = vscode.workspace.createFileSystemWatcher(worktreesPattern);
      worktreesWatcher.onDidChange(debouncedRefresh);
      worktreesWatcher.onDidCreate(debouncedRefresh);
      this.repoWatchers.push(worktreesWatcher);

      // A plain folder becomes a repository when someone runs `git init`, and
      // stops being one when `.git` is removed. The HEAD watchers above only
      // find files once `.git` exists, so rebuild them when it appears or
      // disappears.
      const gitDirWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(repo.rootPath, '.git')
      );
      const rebuildWatchers = () => {
        this.setupRepoWatchers();
        debouncedRefresh();
      };
      gitDirWatcher.onDidCreate(rebuildWatchers);
      gitDirWatcher.onDidDelete(rebuildWatchers);
      this.repoWatchers.push(gitDirWatcher);
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.terminalStateDisposable.dispose();
    this.repoWatchers.forEach(w => w.dispose());
    this.repoWatchers = [];
    this.syncCache.clear();
    if (this.headRefreshTimer) {
      clearTimeout(this.headRefreshTimer);
    }
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    if (this.prRefreshInterval) {
      clearInterval(this.prRefreshInterval);
    }
  }

  /**
   * Get PR URL for a worktree (used by context menu command)
   */
  getPRUrl(worktreeId: string): string | undefined {
    return this.worktreePRUrls.get(worktreeId);
  }

  /**
   * Wire the live turn state used to pick the working/done mark. Wired after
   * construction because the attention service depends on this provider for
   * worktree lookup.
   */
  setTurnStateProvider(
    provider: (chatId: string) => TurnState | undefined
  ): void {
    this.turnStateProvider = provider;
  }

  /**
   * Wire the open-chat predicate after the harness registry and terminal
   * manager exist. It covers both a live terminal and a mapped native-UI tab.
   */
  setChatOpenProvider(provider: (chat: ChatSession) => boolean): void {
    this.chatOpenProvider = provider;
  }

  private isChatOpen(chat: ChatSession): boolean {
    return this.chatOpenProvider(chat);
  }

  /**
   * Refresh the tree view (debounced — multiple rapid calls coalesce into one)
   */
  refresh(): void {
    this.scheduleRefresh(true);
  }

  /**
   * Re-render without dropping the worktree/PR caches. Use when a chat's
   * content changed (name, preview) but the repository structure did not.
   */
  softRefresh(): void {
    this.scheduleRefresh(false);
  }

  private scheduleRefresh(clearCaches: boolean): void {
    this.pendingCacheClear = this.pendingCacheClear || clearCaches;
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = undefined;
      const clear = this.pendingCacheClear;
      this.pendingCacheClear = false;
      this.doRefresh(clear);
    }, WorkspacesTreeProvider.REFRESH_DEBOUNCE_MS);
  }

  private doRefresh(clearCaches: boolean = true): void {
    if (clearCaches) {
      this.worktreeCache.clear();
      this.gitHubService.clearCache();
      this.worktreePRUrls.clear();
    }
    this.updateHeadWatchersIfNeeded();
    this._onDidChangeTreeData.fire(undefined);
  }

  private updateHeadWatchersIfNeeded(): void {
    const repositories = this.storageService.getRepositories();
    const currentRepoIds = repositories.map(r => r.id).sort().join(',');
    if (currentRepoIds !== this.watchedRepoIds) {
      this.watchedRepoIds = currentRepoIds;
      this.setupRepoWatchers();
    }
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get parent of a tree item (required for reveal() to work)
   */
  getParent(element: WorkspaceTreeItem): WorkspaceTreeItem | undefined {
    switch (element.itemType) {
      case 'chat': {
        const chat = element.data as ChatSession;
        const worktree = this.getWorktreeById(chat.worktreeId);
        return worktree ? this.getTreeItemForWorktree(worktree) : undefined;
      }
      case 'worktree': {
        const worktree = element.data as Worktree;
        const repo = this.storageService.getRepository(worktree.repoId);
        return repo ? this.getRepositoryTreeItem(repo) : undefined;
      }
      case 'repository':
      default:
        return undefined;
    }
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
    if (!element) {
      // Root level: show repositories
      return this.getRepositoryItems();
    }

    switch (element.itemType) {
      case 'repository': {
        const repo = element.data as Repository;
        const { isGit, worktrees } = this.getRepoWorktrees(repo);
        // A plain folder owns its sessions directly; a git repository keeps
        // the Repository → Worktree → Session hierarchy.
        return isGit
          ? this.getWorktreeItems(repo)
          : this.getChatItems(worktrees[0]);
      }
      case 'worktree':
        return this.getChatItems(element.data as Worktree);
      case 'chat':
        // Chats don't have children (could add changed files here)
        return [];
      default:
        return [];
    }
  }

  /**
   * Get repository tree items
   */
  private getRepositoryItems(): WorkspaceTreeItem[] {
    const repositories = this.storageService.getRepositories();

    return repositories.map((repo) => {
      const { isGit, worktrees } = this.getRepoWorktrees(repo);

      // A plain folder with no sessions has nothing to expand into, so it
      // should not show a chevron.
      const canExpand =
        isGit || this.storageService.getChatsByWorktree(worktrees[0].id).length > 0;

      const item = new WorkspaceTreeItem(
        repo.name,
        canExpand
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        'repository',
        repo,
        isGit ? 'repository' : 'folderRepository'
      );

      item.iconPath = new vscode.ThemeIcon(
        isGit ? 'repo' : 'folder',
        new vscode.ThemeColor('descriptionForeground')
      );

      item.tooltip = isGit
        ? repo.rootPath
        : `${repo.rootPath}\n\nNot a git repository. Sessions run directly in this folder.`;

      return item;
    });
  }

  /**
   * Effective worktrees and git state for a repository, cached per render.
   * A plain folder reports itself as its only worktree.
   */
  private getRepoWorktrees(repo: Repository): RepositoryWorktrees {
    const cached = this.worktreeCache.get(repo.id);
    if (cached) {
      return cached;
    }

    const entry = this.gitService.listRepositoryWorktrees(repo.rootPath, repo.id);
    this.worktreeCache.set(repo.id, entry);
    return entry;
  }

  /**
   * Get worktree tree items for a repository (sync, uses cached PR info)
   */
  private getWorktreeItems(repo: Repository): WorkspaceTreeItem[] {
    const worktrees = this.getRepoWorktrees(repo).worktrees;

    // Get current workspace folder to highlight active worktree
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Collect uncached branches for background fetch
    const uncachedBranches: string[] = [];

    const items = worktrees.map((worktree) => {
      const isCurrentWorkspace = currentFolder === worktree.path;

      const item = new WorkspaceTreeItem(
        worktree.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'worktree',
        worktree,
        'worktree'
      );

      // Check if this worktree was checked out from a PR
      const prWorktreeNumber = this.storageService.getPRWorktree(worktree.id);

      // Color marks state, not identity: amber for the open workspace, blue
      // for a PR checkout, green for the main worktree, neutral otherwise.
      if (isCurrentWorkspace) {
        item.iconPath = new vscode.ThemeIcon(
          'target',
          new vscode.ThemeColor('charts.yellow')
        );
      } else if (prWorktreeNumber) {
        item.iconPath = new vscode.ThemeIcon(
          'git-pull-request',
          new vscode.ThemeColor('charts.blue')
        );
      } else if (worktree.isMain) {
        item.iconPath = new vscode.ThemeIcon(
          'git-branch',
          new vscode.ThemeColor('charts.green')
        );
      } else {
        item.iconPath = new vscode.ThemeIcon(
          'git-branch',
          new vscode.ThemeColor('descriptionForeground')
        );
      }

      // Build the right-aligned state description.
      const descParts: string[] = [];
      if (isCurrentWorkspace) {
        descParts.push('●');
      }

      const sync = this.getSyncState(worktree.path);
      if (sync?.ahead) {
        descParts.push(`↑${sync.ahead}`);
      }
      if (sync?.behind) {
        descParts.push(`↓${sync.behind}`);
      }

      // Get cached PR info (sync - may be undefined if not fetched yet)
      const prInfo = this.gitHubService.getCachedPRInfo(repo.rootPath, worktree.name);

      if (prInfo === undefined) {
        // Not cached yet, queue for background fetch
        uncachedBranches.push(worktree.name);
      } else if (prInfo !== null) {
        // Store PR URL in Map for context menu
        this.worktreePRUrls.set(worktree.id, prInfo.url);
      }

      const prNumber = prWorktreeNumber ?? prInfo?.number;
      if (prNumber) {
        descParts.push(`PR #${prNumber}`);
      }

      if (descParts.length > 0) {
        item.description = descParts.join(' · ');
      }

      const tooltipParts = [worktree.path];
      if (isCurrentWorkspace) {
        tooltipParts.push('Active workspace');
      }
      if (prInfo) {
        tooltipParts.push(`PR #${prInfo.number}: ${prInfo.title}`);
      }
      item.tooltip = tooltipParts.join('\n\n');

      return item;
    });

    // Start background fetch for uncached branches
    if (uncachedBranches.length > 0) {
      this.fetchPRInfoInBackground(repo.rootPath, uncachedBranches);
    }

    return items;
  }

  /**
   * Ahead/behind counts are cached briefly because every terminal state change
   * refreshes the tree, and each count costs a git process.
   */
  private getSyncState(
    worktreePath: string
  ): { ahead: number; behind: number } | null {
    const cached = this.syncCache.get(worktreePath);
    if (
      cached &&
      Date.now() - cached.fetchedAt < WorkspacesTreeProvider.SYNC_CACHE_MS
    ) {
      return { ahead: cached.ahead, behind: cached.behind };
    }

    const state = this.gitService.getAheadBehind(worktreePath);
    if (!state) {
      this.syncCache.delete(worktreePath);
      return null;
    }

    this.syncCache.set(worktreePath, { ...state, fetchedAt: Date.now() });
    return state;
  }

  /**
   * Fetch PR info for branches in background, then refresh tree
   */
  private fetchPRInfoInBackground(repoPath: string, branches: string[]): void {
    const generation = ++this.prFetchGeneration;

    Promise.all(
      branches.map((branch) => this.gitHubService.fetchPRInfo(repoPath, branch))
    )
      .then(() => {
        if (generation === this.prFetchGeneration) {
          this._onDidChangeTreeData.fire(undefined);
        }
      })
      .catch((error) => {
        console.error('Failed to fetch PR info in background:', error);
        if (generation === this.prFetchGeneration) {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
  }

  /**
   * Get chat tree items for a worktree
   */
  private async getChatItems(worktree: Worktree): Promise<WorkspaceTreeItem[]> {
    const chats = this.storageService.getChatsByWorktree(worktree.id);

    const starredIds = this.storageService.getStarredChatIds();

    const multiHarness = await this.harnessRegistry.hasMultipleInstalled();

    // Fetch metadata through each chat's adapter. Expensive fields (opencode
    // previews) are fetched lazily by getPreview when the tooltip needs them.
    const metadata = new Map<string, SessionMetadata | null>();
    await Promise.all(
      chats.map(async (chat) => {
        if (!chat.harnessSessionId) {
          return;
        }

        const adapter = this.harnessRegistry.get(chat.harness);
        try {
          const meta = await adapter.getSessionMetadata(
            chat.harnessSessionId,
            worktree.path
          );
          if (meta) {
            metadata.set(chat.id, meta);
          }
        } catch {
          metadata.set(chat.id, null);
        }
      })
    );

    const activeIds = new Set(
      chats.filter((chat) => this.isChatOpen(chat)).map((chat) => chat.id)
    );

    // One stable order: newest first by creation time. Opening, resuming, or
    // starring a chat never moves its row, and the active state is carried by
    // the mark instead of by position.
    chats.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    return chats.map((chat) => {
      const isActive = activeIds.has(chat.id);
      const isStarred = starredIds.has(chat.id);
      const meta = metadata.get(chat.id) ?? null;
      const lastActivity = meta?.lastActivity ?? null;
      const adapter = this.harnessRegistry.get(chat.harness);
      // The mark carries harness identity. Keep the text label only for
      // adapters without custom art, where the icon is just a state codicon.
      const harnessLabel =
        multiHarness && !adapter.treeIcons ? ` · ${chat.harness}` : '';

      const item = new WorkspaceTreeItem(
        chat.name,
        vscode.TreeItemCollapsibleState.None,
        'chat',
        chat,
        this.getChatContextValue(adapter, isActive, isStarred)
      );

      this.applyChatIcon(item, chat, adapter, isActive, isStarred);

      let description: string;
      if (!chat.harnessSessionId) {
        description = 'new';
      } else {
        const timeSource =
          lastActivity ?? (isActive ? Date.now() : chat.lastAccessedAt);
        description = formatRelativeTime(timeSource, { short: true });
      }
      if (isStarred) {
        description = `★ ${description}`;
      }

      item.description = `${description}${harnessLabel}`;
      item.tooltip = this.formatChatTooltip(chat, adapter.displayName, meta);

      // Make it clickable to open the chat
      item.command = {
        command: 'agntree.openChat',
        title: 'Open Chat',
        arguments: [item],
      };

      return item;
    });
  }

  /**
   * The base context value names the row state; an adapter with a native UI
   * appends its own token so that UI's menu entry targets only its rows.
   * Commands and menus stay harness-agnostic: the suffix comes from the
   * adapter, not from a harness check here.
   */
  private getChatContextValue(
    adapter: HarnessAdapter,
    isActive: boolean,
    isStarred: boolean
  ): string {
    const base = isActive
      ? isStarred
        ? 'runningStarredChat'
        : 'runningChat'
      : isStarred
        ? 'starredChat'
        : 'chat';
    const suffix = adapter.nativeUi?.contextValueSuffix;
    return suffix ? `${base}${suffix}` : base;
  }

  /**
   * Custom harness marks carry harness identity; the generated state variants
   * animate the mark while a turn runs and add the done/closed/new badge.
   * Adapters without custom art fall back to the state codicons.
   */
  private applyChatIcon(
    item: WorkspaceTreeItem,
    chat: ChatSession,
    adapter: HarnessAdapter,
    isActive: boolean,
    isStarred: boolean
  ): void {
    const state = selectHarnessIconState(
      chat,
      isActive,
      this.turnStateProvider(chat.id)
    );

    if (adapter.treeIcons) {
      item.iconPath = harnessIconPath(this.extensionUri, adapter, state);
      return;
    }

    const icon = isStarred
      ? {
          id: 'star-full',
          color: isActive ? 'charts.green' : 'charts.yellow',
        }
      : FALLBACK_CHAT_ICONS[state];
    item.iconPath = new vscode.ThemeIcon(
      icon.id,
      new vscode.ThemeColor(icon.color)
    );
  }

  /**
   * Get a minimal tree item for a repository (for getParent/reveal)
   */
  getRepositoryTreeItem(repo: Repository): WorkspaceTreeItem {
    const { isGit } = this.getRepoWorktrees(repo);
    return new WorkspaceTreeItem(
      repo.name,
      vscode.TreeItemCollapsibleState.Expanded,
      'repository',
      repo,
      isGit ? 'repository' : 'folderRepository'
    );
  }

  /**
   * Get a minimal tree item for a worktree (for getParent/reveal)
   */
  getWorktreeTreeItem(worktree: Worktree): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      worktree.name,
      vscode.TreeItemCollapsibleState.Expanded,
      'worktree',
      worktree,
      'worktree'
    );
  }

  /**
   * The row that represents a worktree in the tree. A plain folder's root
   * worktree has no row of its own, so its folder row is the one to reveal.
   */
  getTreeItemForWorktree(worktree: Worktree): WorkspaceTreeItem {
    const repo = this.storageService.getRepository(worktree.repoId);
    if (repo && !this.getRepoWorktrees(repo).isGit) {
      return this.getRepositoryTreeItem(repo);
    }
    return this.getWorktreeTreeItem(worktree);
  }

  /**
   * Get a minimal tree item for a chat (for getParent/reveal)
   */
  getChatTreeItem(chat: ChatSession): WorkspaceTreeItem {
    const adapter = this.harnessRegistry.get(chat.harness);
    return new WorkspaceTreeItem(
      chat.name,
      vscode.TreeItemCollapsibleState.None,
      'chat',
      chat,
      this.getChatContextValue(
        adapter,
        this.isChatOpen(chat),
        this.storageService.isStarred(chat.id)
      )
    );
  }

  /**
   * Find a worktree by ID (for use by commands)
   */
  getWorktreeById(worktreeId: string): Worktree | undefined {
    return this.findWorktree((worktree) => worktree.id === worktreeId);
  }

  findWorktreeByPath(targetPath: string): Worktree | undefined {
    return this.findWorktree((worktree) => worktree.path === targetPath);
  }

  /**
   * Whether a stored workspace root is a git repository, using the same
   * effective state the tree renders.
   */
  isGitRepo(repo: Repository): boolean {
    return this.getRepoWorktrees(repo).isGit;
  }

  /**
   * Whether a worktree is git-backed. A plain folder's synthetic worktree is
   * not; a linked worktree of a git repository is.
   */
  isGitWorktree(worktree: Worktree): boolean {
    const repo = this.storageService.getRepository(worktree.repoId);
    return repo
      ? this.getRepoWorktrees(repo).isGit
      : this.gitService.isGitRepository(worktree.path);
  }

  /**
   * Resolve a tree item to the worktree its actions apply to. A plain folder
   * row stands in for its single root worktree.
   */
  getWorktreeForItem(item?: WorkspaceTreeItem): Worktree | undefined {
    if (!item) {
      return undefined;
    }
    if (item.itemType === 'worktree') {
      return item.data as Worktree;
    }
    if (item.itemType === 'repository') {
      const repo = item.data as Repository;
      const { isGit, worktrees } = this.getRepoWorktrees(repo);
      return isGit ? undefined : worktrees[0];
    }
    return undefined;
  }

  /**
   * Search the cache, then load every repository once and keep the result.
   * Startup resolves restored chats before the tree has rendered, so an
   * uncached lookup would run `git worktree list` again for every chat (and
   * again for the workspace folder). Caching each repository's list bounds the
   * synchronous git work to one call per repository.
   */
  private findWorktree(
    predicate: (worktree: Worktree) => boolean
  ): Worktree | undefined {
    for (const { worktrees } of this.worktreeCache.values()) {
      const found = worktrees.find(predicate);
      if (found) return found;
    }

    for (const repo of this.storageService.getRepositories()) {
      const { worktrees } = this.getRepoWorktrees(repo);
      const found = worktrees.find(predicate);
      if (found) return found;
    }

    return undefined;
  }

  /**
   * A session brief: what the session is about, where the last turn ended,
   * and the usage facts that are not visible in the row.
   *
   * Harness, open/closed state, the worktree, and the star are deliberately
   * absent: the row already carries all of them.
   */
  private formatChatTooltip(
    chat: ChatSession,
    harnessName: string,
    meta: SessionMetadata | null
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;

    md.appendMarkdown(`**${this.escapeTooltipText(chat.name)}**\n\n`);

    if (!chat.harnessSessionId) {
      md.appendMarkdown(`**No messages yet**\n\n`);
      md.appendMarkdown(`The first prompt will create the native session.\n\n`);
      md.appendMarkdown(`Started ${formatRelativeTime(chat.createdAt)}.\n\n`);
      return md;
    }

    if (!meta) {
      md.appendMarkdown(`**Session unavailable**\n\n`);
      md.appendMarkdown(
        `Agntree could not read the native session. It may have been removed or moved.\n\n`
      );
      return md;
    }

    const preview = this.getChatPreview(chat, meta);
    const { lastAsk, lastReply } = lastExchange(meta, preview);

    if (lastAsk || lastReply) {
      md.appendMarkdown(`**Last exchange**\n\n`);

      if (lastAsk) {
        md.appendMarkdown(
          `**You${this.formatTooltipTime(lastAsk.timestamp)}**\n\n`
        );
        md.appendMarkdown(
          `> ${this.escapeTooltipText(clampInlineText(lastAsk.text, 220))}\n\n`
        );
      }
      if (lastReply) {
        md.appendMarkdown(
          `**${this.escapeTooltipText(harnessName)}${this.formatTooltipTime(lastReply.timestamp)}**\n\n`
        );
        md.appendMarkdown(
          `${this.escapeTooltipText(clampInlineText(lastReply.text, 220))}\n\n`
        );
      }
    } else if (!meta.model && !meta.agent && !meta.tokens) {
      md.appendMarkdown(`No recent messages.\n\n`);
    }

    const footer: string[] = [];
    const usage = sessionUsageLine(meta);
    if (usage) {
      footer.push(usage);
    }
    if (
      meta.lastActivity &&
      Date.now() - meta.lastActivity > 24 * 60 * 60 * 1000
    ) {
      footer.push(
        `last active ${new Date(meta.lastActivity).toLocaleDateString()}`
      );
    }

    if (footer.length > 0) {
      md.appendMarkdown(`---\n\n${footer.join(' · ')}\n\n`);
    }

    return md;
  }

  private formatTooltipTime(timestamp: number | null | undefined): string {
    return timestamp ? ` · ${formatRelativeTime(timestamp)}` : '';
  }

  private escapeTooltipText(text: string): string {
    return text.replace(/([\\`*_{}\[\]<>#|~])/g, '\\$1');
  }

  /**
   * Claude previews arrive with the metadata. Harnesses that mark previews as
   * lazy (opencode) need an export, so fetch it once in the background and
   * refresh when it lands.
   */
  private getChatPreview(
    chat: ChatSession,
    meta: SessionMetadata | null
  ): PreviewMessage[] {
    if (!chat.harnessSessionId) {
      return [];
    }
    if (meta?.preview && meta.preview.length > 0) {
      return meta.preview;
    }

    const adapter = this.harnessRegistry.get(chat.harness);
    if (adapter.capabilities.preview !== 'lazy') {
      return meta?.preview ?? [];
    }

    const key = harnessSessionKey(chat.harness, chat.harnessSessionId);
    const cached = this.previewCache.get(key);
    if (cached) {
      return cached;
    }

    // Cache an empty placeholder while the export is in flight so repeated
    // renders do not queue more of them.
    this.previewCache.set(key, []);
    void adapter
      .getPreview(chat.harnessSessionId, 3)
      .then((messages) => {
        this.previewCache.set(key, messages);
        if (messages.length > 0) {
          this.softRefresh();
        }
      })
      .catch(() => {
        // Keep the empty placeholder so a broken session doesn't retry every render.
      });

    return [];
  }

}
