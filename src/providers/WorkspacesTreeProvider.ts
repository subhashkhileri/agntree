import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, Worktree, ChatSession, TreeItemType } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { ClaudeSessionService } from '../services/ClaudeSessionService';

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

  /** Service for reading Claude session data */
  private claudeSessionService = new ClaudeSessionService();

  /** File watchers for git HEAD changes (branch switches) - one per repository */
  private headWatchers: vscode.FileSystemWatcher[] = [];

  /** Debounce timer for HEAD change refresh */
  private headRefreshTimer: NodeJS.Timeout | undefined;

  constructor(
    private storageService: StorageService,
    private gitService: GitService,
    private terminalManager: TerminalManager
  ) {
    // Refresh when terminal state changes
    terminalManager.onTerminalStateChange(() => {
      this.refresh();
    });

    // Watch for branch changes (git checkout/switch)
    this.setupHeadWatchers();
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
    this.headWatchers.forEach(w => w.dispose());
    this.headWatchers = [];
    if (this.headRefreshTimer) {
      clearTimeout(this.headRefreshTimer);
    }
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this.worktreeCache.clear();
    this._onDidChangeTreeData.fire(undefined);
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
        vscode.TreeItemCollapsibleState.Expanded,
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
   * Get worktree tree items for a repository
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

    return worktrees.map((worktree) => {
      const hasChats = this.storageService.getChatsByWorktree(worktree.id).length > 0;
      const isCurrentWorkspace = currentFolder === worktree.path;

      const item = new WorkspaceTreeItem(
        worktree.name,
        hasChats ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
        'worktree',
        worktree,
        'worktree'
      );

      // Highlight current workspace with yellow color, otherwise use standard colors
      if (isCurrentWorkspace) {
        item.iconPath = new vscode.ThemeIcon(
          'folder-opened',
          new vscode.ThemeColor('charts.yellow')
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

      item.tooltip = worktree.path;

      if (isCurrentWorkspace) {
        item.description = '● open';
      }

      return item;
    });
  }

  /**
   * Get chat tree items for a worktree
   */
  private getChatItems(worktree: Worktree): WorkspaceTreeItem[] {
    const chats = this.storageService.getChatsByWorktree(worktree.id);

    // Sort by creation time (newest first) - stable order that doesn't change on selection
    chats.sort((a, b) => b.createdAt - a.createdAt);

    return chats.map((chat) => {
      const isActive = this.terminalManager.isActive(chat.id);

      const item = new WorkspaceTreeItem(
        chat.name,
        vscode.TreeItemCollapsibleState.None,
        'chat',
        chat,
        'chat'
      );

      // Distinctive icons with colors based on state
      if (isActive) {
        item.iconPath = new vscode.ThemeIcon(
          'pulse',
          new vscode.ThemeColor('charts.green')
        );
        item.description = '● running';
      } else if (chat.claudeSessionId) {
        // Has a session ID - can be resumed
        item.iconPath = new vscode.ThemeIcon(
          'history',
          new vscode.ThemeColor('charts.orange')
        );
        item.description = this.formatRelativeTime(chat.lastAccessedAt);
      } else {
        // New chat without session
        item.iconPath = new vscode.ThemeIcon(
          'comment',
          new vscode.ThemeColor('charts.foreground')
        );
        item.description = 'new session';
      }

      item.tooltip = this.formatChatTooltip(chat, isActive);

      // Make it clickable to open the chat
      item.command = {
        command: 'claude-workspaces.openChat',
        title: 'Open Chat',
        arguments: [item],
      };

      return item;
    });
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

  /**
   * Format chat tooltip with session preview
   */
  private formatChatTooltip(chat: ChatSession, isActive: boolean): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;

    // Header
    md.appendMarkdown(`**${chat.name}**\n\n`);

    // Status info
    md.appendMarkdown(`Status: ${isActive ? '🟢 Active' : chat.status}\n\n`);
    md.appendMarkdown(`Created: ${new Date(chat.createdAt).toLocaleString()}\n\n`);
    md.appendMarkdown(`Last accessed: ${new Date(chat.lastAccessedAt).toLocaleString()}\n\n`);

    // Session preview if available
    if (chat.claudeSessionId) {
      const preview = this.claudeSessionService.getSessionPreview(chat.claudeSessionId, 3);
      if (preview.length > 0) {
        md.appendMarkdown(`---\n\n`);
        md.appendMarkdown(`**Recent messages:**\n\n`);
        for (const msg of preview) {
          md.appendMarkdown(`> ${msg}\n\n`);
        }
      }
    }

    return md;
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
