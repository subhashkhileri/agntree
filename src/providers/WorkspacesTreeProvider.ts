import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, Worktree, ChatSession, TreeItemType } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';

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

  constructor(
    private storageService: StorageService,
    private gitService: GitService,
    private terminalManager: TerminalManager
  ) {
    // Refresh when terminal state changes
    terminalManager.onTerminalStateChange(() => {
      this.refresh();
    });
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
      const item = new WorkspaceTreeItem(
        repo.name,
        vscode.TreeItemCollapsibleState.Expanded,
        'repository',
        repo,
        'repository'
      );

      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = repo.rootPath;
      item.description = this.getRelativePath(repo.rootPath);

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

    return worktrees.map((worktree) => {
      const chats = this.storageService.getChatsByWorktree(worktree.id);
      const hasActiveChats = chats.some((c) => this.terminalManager.isActive(c.id));

      const item = new WorkspaceTreeItem(
        worktree.name,
        vscode.TreeItemCollapsibleState.Expanded,
        'worktree',
        worktree,
        'worktree'
      );

      item.iconPath = new vscode.ThemeIcon(worktree.isMain ? 'git-branch' : 'git-merge');
      item.tooltip = `${worktree.path}\n${chats.length} chat(s)`;
      item.description = worktree.isMain ? '(main)' : '';

      // Add indicator if there are active chats
      if (hasActiveChats) {
        item.description = `${item.description} ●`.trim();
      }

      return item;
    });
  }

  /**
   * Get chat tree items for a worktree
   */
  private getChatItems(worktree: Worktree): WorkspaceTreeItem[] {
    const chats = this.storageService.getChatsByWorktree(worktree.id);

    // Sort by last accessed (most recent first)
    chats.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

    return chats.map((chat) => {
      const isActive = this.terminalManager.isActive(chat.id);

      const item = new WorkspaceTreeItem(
        chat.name,
        vscode.TreeItemCollapsibleState.None,
        'chat',
        chat,
        'chat'
      );

      item.iconPath = new vscode.ThemeIcon(
        isActive ? 'comment-discussion' : 'comment',
        isActive ? new vscode.ThemeColor('charts.green') : undefined
      );

      item.tooltip = this.formatChatTooltip(chat, isActive);
      item.description = isActive ? 'active' : this.formatRelativeTime(chat.lastAccessedAt);

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
   * Format chat tooltip
   */
  private formatChatTooltip(chat: ChatSession, isActive: boolean): string {
    const lines = [
      chat.name,
      `Status: ${isActive ? 'Active' : chat.status}`,
      `Created: ${new Date(chat.createdAt).toLocaleString()}`,
      `Last accessed: ${new Date(chat.lastAccessedAt).toLocaleString()}`,
    ];

    if (chat.claudeSessionId) {
      lines.push(`Session: ${chat.claudeSessionId}`);
    }

    return lines.join('\n');
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

  /**
   * Get relative path from home directory
   */
  private getRelativePath(fullPath: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (fullPath.startsWith(homeDir)) {
      return '~' + fullPath.substring(homeDir.length);
    }
    return fullPath;
  }
}
