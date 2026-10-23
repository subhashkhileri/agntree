import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, Worktree, ChatSession, TreeItemType } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { GitHubService } from '../services/GitHubService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { harnessSessionKey, selectHarnessIconState } from '../harnesses/sessionUtils';
import { HarnessAdapter, PreviewMessage, SessionMetadata } from '../harnesses/types';

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

  /** Cache of worktrees by repository ID */
  private worktreeCache: Map<string, Worktree[]> = new Map();

  /** Lazily fetched previews for harnesses that do not inline them */
  private previewCache = new Map<string, PreviewMessage[]>();

  /** Service for GitHub PR status */
  private gitHubService = new GitHubService();

  /** Map of worktree ID to PR URL for context menu */
  private worktreePRUrls = new Map<string, string>();

  /** File watchers for git HEAD changes (branch switches) - one per repository */
  private headWatchers: vscode.FileSystemWatcher[] = [];

  /** Disposable for terminal state change listener */
  private terminalStateDisposable: vscode.Disposable;

  /** Debounce timer for HEAD change refresh */
  private headRefreshTimer: NodeJS.Timeout | undefined;

  /** Debounce timer for coalescing rapid refresh() calls */
  private refreshDebounceTimer: NodeJS.Timeout | undefined;

  /** Tracks which repos have active HEAD watchers to avoid unnecessary recreation */
  private watchedRepoIds = '';

  /** Generation counter to discard stale PR background fetches */
  private prFetchGeneration = 0;

  /** Timer for periodic PR status refresh (every 5 minutes) */
  private prRefreshInterval: NodeJS.Timeout | undefined;

  /** PR refresh interval in milliseconds (5 minutes) */
  private static readonly PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  /** Debounce window for coalescing refresh calls (ms) */
  private static readonly REFRESH_DEBOUNCE_MS = 300;

  constructor(
    private storageService: StorageService,
    private gitService: GitService,
    private terminalManager: TerminalManager,
    private harnessRegistry: HarnessRegistry,
    private extensionUri: vscode.Uri
  ) {
    // Refresh when terminal state changes
    this.terminalStateDisposable = terminalManager.onTerminalStateChange(() => {
      this.refresh();
    });

    // Watch for branch changes (git checkout/switch)
    this.setupHeadWatchers();

    // Start periodic PR status refresh (every 5 minutes)
    this.prRefreshInterval = setInterval(() => {
      this.gitHubService.clearCache();
      this._onDidChangeTreeData.fire(undefined);
    }, WorkspacesTreeProvider.PR_REFRESH_INTERVAL_MS);
  }

  /**
   * Set up file watchers for .git/HEAD changes to detect branch switches
   * Uses RelativePattern with absolute paths to watch repositories outside workspace
   */
  setupHeadWatchers(): void {
    // Dispose existing watchers
    this.headWatchers.forEach(w => w.dispose());
    this.headWatchers = [];

    const debouncedRefresh = () => {
      if (this.headRefreshTimer) {
        clearTimeout(this.headRefreshTimer);
      }
      this.headRefreshTimer = setTimeout(() => {
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
      this.headWatchers.push(mainWatcher);

      // Watch other worktrees HEAD: .git/worktrees/*/HEAD
      const worktreesPattern = new vscode.RelativePattern(gitDir, 'worktrees/*/HEAD');
      const worktreesWatcher = vscode.workspace.createFileSystemWatcher(worktreesPattern);
      worktreesWatcher.onDidChange(debouncedRefresh);
      worktreesWatcher.onDidCreate(debouncedRefresh);
      this.headWatchers.push(worktreesWatcher);
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.terminalStateDisposable.dispose();
    this.headWatchers.forEach(w => w.dispose());
    this.headWatchers = [];
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
   * Refresh the tree view (debounced — multiple rapid calls coalesce into one)
   */
  refresh(): void {
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = undefined;
      this.doRefresh();
    }, WorkspacesTreeProvider.REFRESH_DEBOUNCE_MS);
  }

  private doRefresh(): void {
    this.worktreeCache.clear();
    this.gitHubService.clearCache();
    this.worktreePRUrls.clear();
    this.updateHeadWatchersIfNeeded();
    this._onDidChangeTreeData.fire(undefined);
  }

  private updateHeadWatchersIfNeeded(): void {
    const repositories = this.storageService.getRepositories();
    const currentRepoIds = repositories.map(r => r.id).sort().join(',');
    if (currentRepoIds !== this.watchedRepoIds) {
      this.watchedRepoIds = currentRepoIds;
      this.setupHeadWatchers();
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
        return worktree ? this.getWorktreeTreeItem(worktree) : undefined;
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
      case 'repository':
        return this.getWorktreeItems(element.data as Repository);
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
      const worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      this.worktreeCache.set(repo.id, worktrees);

      const item = new WorkspaceTreeItem(
        repo.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'repository',
        repo,
        'repository'
      );

      item.iconPath = new vscode.ThemeIcon(
        'repo',
        new vscode.ThemeColor('charts.green')
      );

      item.tooltip = repo.rootPath;

      return item;
    });
  }

  /**
   * Get worktree tree items for a repository (sync, uses cached PR info)
   */
  private getWorktreeItems(repo: Repository): WorkspaceTreeItem[] {
    // Check cache first
    let worktrees = this.worktreeCache.get(repo.id);

    if (!worktrees) {
      worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      this.worktreeCache.set(repo.id, worktrees);
    }

    // Get current workspace folder to highlight active worktree
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Collect uncached branches for background fetch
    const uncachedBranches: string[] = [];

    const items = worktrees.map((worktree) => {
      const hasChats = this.storageService.getChatsByWorktree(worktree.id).length > 0;
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

      // Highlight current workspace with yellow color, otherwise use standard colors
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
          'git-merge',
          new vscode.ThemeColor('charts.purple')
        );
      }

      // Build description from parts
      const descParts: string[] = [];

      if (isCurrentWorkspace) {
        descParts.push('● active workspace');
      }

      if (prWorktreeNumber) {
        descParts.push(`PR #${prWorktreeNumber}`);
      }

      // Get cached PR info (sync - may be undefined if not fetched yet)
      const prInfo = this.gitHubService.getCachedPRInfo(repo.rootPath, worktree.name);

      if (prInfo === undefined) {
        // Not cached yet, queue for background fetch
        uncachedBranches.push(worktree.name);
      } else if (prInfo !== null) {
        // Only add PR description if not already shown via PR worktree marker
        if (!prWorktreeNumber) {
          const prDesc = this.gitHubService.formatPRDescription(prInfo);
          if (prDesc) {
            descParts.push(prDesc);
          }
        }
        // Store PR URL in Map for context menu
        this.worktreePRUrls.set(worktree.id, prInfo.url);
        // Build tooltip with PR title
        item.tooltip = `${worktree.path}\n\nPR #${prInfo.number}: ${prInfo.title}`;
      }

      if (descParts.length > 0) {
        item.description = descParts.join(' · ');
      }

      // Default tooltip if no PR info
      if (!item.tooltip) {
        item.tooltip = worktree.path;
      }

      return item;
    });

    // Start background fetch for uncached branches
    if (uncachedBranches.length > 0) {
      this.fetchPRInfoInBackground(repo.rootPath, uncachedBranches);
    }

    return items;
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

    const lastActivityAt = (chat: ChatSession): number | null =>
      metadata.get(chat.id)?.lastActivity ?? null;

    // Sort: starred first, then by last activity (newest first), fallback to createdAt
    chats.sort((a, b) => {
      const aStarred = starredIds.has(a.id) ? 1 : 0;
      const bStarred = starredIds.has(b.id) ? 1 : 0;
      if (aStarred !== bStarred) return bStarred - aStarred;
      const aTime = lastActivityAt(a) ?? a.createdAt;
      const bTime = lastActivityAt(b) ?? b.createdAt;
      return bTime - aTime;
    });

    return chats.map((chat) => {
      const isActive = this.terminalManager.isActive(chat.id);
      const isStarred = starredIds.has(chat.id);
      const meta = metadata.get(chat.id) ?? null;
      const lastActivity = meta?.lastActivity ?? null;
      const adapter = this.harnessRegistry.get(chat.harness);
      const harnessLabel = multiHarness ? ` · ${chat.harness}` : '';

      const item = new WorkspaceTreeItem(
        chat.name,
        vscode.TreeItemCollapsibleState.None,
        'chat',
        chat,
        isActive ? (isStarred ? 'runningStarredChat' : 'runningChat') : (isStarred ? 'starredChat' : 'chat')
      );

      this.applyChatIcon(item, chat, adapter, isActive, isStarred);

      let description: string;
      if (isStarred) {
        if (isActive) {
          description = '★ running';
        } else if (chat.harnessSessionId) {
          description = `★ ${this.formatRelativeTime(lastActivity ?? chat.lastAccessedAt)}`;
        } else {
          description = '★ new session';
        }
      } else if (isActive) {
        description = '● running';
      } else if (chat.harnessSessionId) {
        description = this.formatRelativeTime(lastActivity ?? chat.lastAccessedAt);
      } else {
        description = 'new session';
      }

      item.description = `${description}${harnessLabel}`;
      item.tooltip = this.formatChatTooltip(
        chat,
        adapter.displayName,
        isActive,
        meta
      );

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
   * Custom harness marks carry harness identity; the generated state variants
   * bake in the running/closed/new badge. Adapters without custom art fall
   * back to the state codicons.
   */
  private applyChatIcon(
    item: WorkspaceTreeItem,
    chat: ChatSession,
    adapter: HarnessAdapter,
    isActive: boolean,
    isStarred: boolean
  ): void {
    if (adapter.treeIcons) {
      const state = selectHarnessIconState(chat, isActive);
      item.iconPath = {
        light: vscode.Uri.joinPath(
          this.extensionUri,
          adapter.treeIcons.light[state]
        ),
        dark: vscode.Uri.joinPath(
          this.extensionUri,
          adapter.treeIcons.dark[state]
        ),
      };
      return;
    }

    if (isStarred) {
      item.iconPath = new vscode.ThemeIcon(
        'star-full',
        new vscode.ThemeColor(isActive ? 'charts.green' : 'charts.yellow')
      );
    } else if (isActive) {
      item.iconPath = new vscode.ThemeIcon(
        'pulse',
        new vscode.ThemeColor('charts.green')
      );
    } else if (chat.harnessSessionId) {
      item.iconPath = new vscode.ThemeIcon(
        'history',
        new vscode.ThemeColor('charts.orange')
      );
    } else {
      item.iconPath = new vscode.ThemeIcon(
        'comment',
        new vscode.ThemeColor('charts.foreground')
      );
    }
  }

  /**
   * Get a minimal tree item for a repository (for getParent/reveal)
   */
  getRepositoryTreeItem(repo: Repository): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      repo.name,
      vscode.TreeItemCollapsibleState.Expanded,
      'repository',
      repo,
      'repository'
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
   * Get a minimal tree item for a chat (for getParent/reveal)
   */
  getChatTreeItem(chat: ChatSession): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      chat.name,
      vscode.TreeItemCollapsibleState.None,
      'chat',
      chat,
      'chat'
    );
  }

  /**
   * Get worktree by ID (for use by commands)
   */
  getWorktreeById(worktreeId: string): Worktree | undefined {
    for (const worktrees of this.worktreeCache.values()) {
      const found = worktrees.find((w) => w.id === worktreeId);
      if (found) return found;
    }

    // If not in cache, search all repos
    const repos = this.storageService.getRepositories();
    for (const repo of repos) {
      const worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      const found = worktrees.find((w) => w.id === worktreeId);
      if (found) return found;
    }

    return undefined;
  }

  findWorktreeByPath(targetPath: string): Worktree | undefined {
    for (const worktrees of this.worktreeCache.values()) {
      const found = worktrees.find((w) => w.path === targetPath);
      if (found) return found;
    }
    const repos = this.storageService.getRepositories();
    for (const repo of repos) {
      const worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      const found = worktrees.find((w) => w.path === targetPath);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Format chat tooltip with session metadata and a preview
   */
  private formatChatTooltip(
    chat: ChatSession,
    harnessName: string,
    isActive: boolean,
    meta: SessionMetadata | null
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;

    // Recap at the top if available (Claude only today)
    if (meta?.recap) {
      md.appendMarkdown(`**Recap**\n\n`);
      md.appendMarkdown(`${meta.recap}\n\n`);
      md.appendMarkdown(`---\n\n`);
    }

    // Header
    md.appendMarkdown(`**${chat.name}**\n\n`);
    md.appendMarkdown(`Harness: ${harnessName}\n\n`);
    if (chat.status === 'closed') {
      md.appendMarkdown(`Status: closed\n\n`);
    }
    if (meta?.model) {
      md.appendMarkdown(`Model: ${meta.model}\n\n`);
    }
    if (meta?.agent) {
      md.appendMarkdown(`Agent: ${meta.agent}\n\n`);
    }

    // Status info
    md.appendMarkdown(`Status: ${isActive ? '🟢 Active' : chat.status}\n\n`);
    md.appendMarkdown(`Created: ${new Date(chat.createdAt).toLocaleString()}\n\n`);
    md.appendMarkdown(`Last accessed: ${new Date(chat.lastAccessedAt).toLocaleString()}\n\n`);
    if (meta?.lastActivity) {
      md.appendMarkdown(`Last activity: ${new Date(meta.lastActivity).toLocaleString()}\n\n`);
    }
    if (chat.baseCommit) {
      md.appendMarkdown(`Base commit: \`${chat.baseCommit.substring(0, 12)}\`\n\n`);
    }

    if (meta?.tokens) {
      const tokens = meta.tokens;
      md.appendMarkdown(
        `Tokens: ${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out` +
          `${tokens.reasoning ? ` · ${tokens.reasoning.toLocaleString()} reasoning` : ''}` +
          `${tokens.cacheRead ? ` · ${tokens.cacheRead.toLocaleString()} cache read` : ''}\n\n`
      );
    }
    if (typeof meta?.cost === 'number' && meta.cost > 0) {
      md.appendMarkdown(`Cost: $${meta.cost.toFixed(4)}\n\n`);
    }

    const preview = this.getChatPreview(chat, meta);
    if (preview.length > 0) {
      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`**Recent messages:**\n\n`);
      for (const { text, timestamp } of preview) {
        const timeLabel = timestamp ? `*${new Date(timestamp).toLocaleString()}*  ` : '';
        md.appendMarkdown(`${timeLabel}\n\n> ${text}\n\n`);
      }
    }

    return md;
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
          this.refresh();
        }
      })
      .catch(() => {
        // Keep the empty placeholder so a broken session doesn't retry every render.
      });

    return [];
  }

  /**
   * Format relative time (e.g., "5m ago", "2h ago")
   */
  private formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

}
