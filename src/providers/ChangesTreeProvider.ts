import * as vscode from 'vscode';
import * as path from 'path';
import { FileChange, Worktree } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';

/**
 * Section header for staged/unstaged changes
 */
export class ChangeSectionItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sectionType: 'staged' | 'unstaged',
    public readonly worktreePath: string,
    fileCount: number,
    totalAdditions: number,
    totalDeletions: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);

    const additions = totalAdditions > 0 ? `+${totalAdditions}` : '';
    const deletions = totalDeletions > 0 ? `-${totalDeletions}` : '';
    const stats = [additions, deletions].filter(Boolean).join(' ');
    this.description = `${fileCount} file(s)${stats ? ` ${stats}` : ''}`;

    this.iconPath = new vscode.ThemeIcon(
      sectionType === 'staged' ? 'check' : 'edit'
    );

    // Context for section-level actions (stage all, unstage all)
    this.contextValue = sectionType === 'staged' ? 'stagedSection' : 'unstagedSection';
  }
}

/**
 * Tree item for changed files
 */
export class ChangeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly change: FileChange,
    public readonly worktreePath: string,
    public readonly baseCommit: string | null,
    public readonly isStaged: boolean
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    // Use resourceUri to get file icon from the current theme (like Explorer)
    const fullPath = path.join(worktreePath, change.path);
    this.resourceUri = vscode.Uri.file(fullPath);

    // Status letter and line counts in description (like Source Control)
    const statusLetter = this.getStatusLetter(change.status);
    const additions = change.additions > 0 ? `+${change.additions}` : '';
    const deletions = change.deletions > 0 ? `-${change.deletions}` : '';
    const lineCounts = [additions, deletions].filter(Boolean).join(' ');
    this.description = lineCounts ? `${statusLetter} ${lineCounts}` : statusLetter;

    // Set tooltip
    this.tooltip = `${change.path}\n${change.status}\n${additions} ${deletions}`.trim();

    // Set context value for menus (different for staged vs unstaged)
    this.contextValue = isStaged ? 'stagedFile' : 'unstagedFile';

    // Make clickable to open diff
    this.command = {
      command: 'claude-workspaces.openDiff',
      title: 'Open Diff',
      arguments: [this],
    };
  }

  private getStatusLetter(status: FileChange['status']): string {
    switch (status) {
      case 'added':
        return 'A';
      case 'modified':
        return 'M';
      case 'deleted':
        return 'D';
      case 'renamed':
        return 'R';
      default:
        return '?';
    }
  }
}

/**
 * Provides tree data for the Changes view
 */
export class ChangesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Currently displayed worktree */
  private activeWorktree: Worktree | undefined;

  /** File watcher for auto-refresh */
  private fileWatcher: vscode.FileSystemWatcher | undefined;

  /** Debounce timer for refresh */
  private refreshTimer: NodeJS.Timeout | undefined;

  /** Cached data for getChildren calls */
  private stagedChanges: FileChange[] = [];
  private unstagedChanges: FileChange[] = [];

  constructor(
    private storageService: StorageService,
    private gitService: GitService,
    private getWorktreeById: (id: string) => Worktree | undefined
  ) {}

  /**
   * Set the active worktree to display changes for
   */
  setActiveWorktree(worktree: Worktree | undefined): void {
    this.activeWorktree = worktree;
    this.setupFileWatcher();
    this.refresh();
  }

  /**
   * Set the active chat to display changes for (uses chat's worktree)
   */
  setActiveChat(chatId: string | undefined, worktree?: Worktree): void {
    this.activeWorktree = worktree;
    this.setupFileWatcher();
    this.refresh();
  }

  /**
   * Get the current active worktree
   */
  getActiveWorktree(): Worktree | undefined {
    return this.activeWorktree;
  }

  /**
   * Setup file watcher for auto-refresh
   */
  private setupFileWatcher(): void {
    // Dispose existing watcher
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }

    if (!this.activeWorktree) {
      return;
    }

    // Watch all files in the worktree (excluding .git and node_modules)
    const pattern = new vscode.RelativePattern(
      this.activeWorktree.path,
      '**/*'
    );

    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    // Debounced refresh on any file change
    const debouncedRefresh = () => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => {
        this.refresh();
      }, 500); // 500ms debounce
    };

    this.fileWatcher.onDidChange(debouncedRefresh);
    this.fileWatcher.onDidCreate(debouncedRefresh);
    this.fileWatcher.onDidDelete(debouncedRefresh);
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // No active worktree
    if (!this.activeWorktree) {
      return [this.createPlaceholderItem('Select a worktree or chat to view changes')];
    }

    const worktree = this.activeWorktree;

    // If element is a section, return its children
    if (element instanceof ChangeSectionItem) {
      const changes = element.sectionType === 'staged'
        ? this.stagedChanges
        : this.unstagedChanges;

      return this.createFileItems(changes, worktree.path, element.sectionType === 'staged');
    }

    // Root level - show sections
    if (!element) {
      // Fetch fresh data
      this.stagedChanges = this.gitService.getStagedChanges(worktree.path);
      this.unstagedChanges = this.gitService.getUnstagedChanges(worktree.path);

      const items: vscode.TreeItem[] = [];

      // No changes at all
      if (this.stagedChanges.length === 0 && this.unstagedChanges.length === 0) {
        return [this.createPlaceholderItem('No changes detected')];
      }

      // Staged Changes section
      if (this.stagedChanges.length > 0) {
        const stagedAdditions = this.stagedChanges.reduce((sum, c) => sum + c.additions, 0);
        const stagedDeletions = this.stagedChanges.reduce((sum, c) => sum + c.deletions, 0);
        items.push(new ChangeSectionItem(
          'Staged Changes',
          'staged',
          worktree.path,
          this.stagedChanges.length,
          stagedAdditions,
          stagedDeletions
        ));
      }

      // Unstaged Changes section
      if (this.unstagedChanges.length > 0) {
        const unstagedAdditions = this.unstagedChanges.reduce((sum, c) => sum + c.additions, 0);
        const unstagedDeletions = this.unstagedChanges.reduce((sum, c) => sum + c.deletions, 0);
        items.push(new ChangeSectionItem(
          'Changes',
          'unstaged',
          worktree.path,
          this.unstagedChanges.length,
          unstagedAdditions,
          unstagedDeletions
        ));
      }

      return items;
    }

    return [];
  }

  /**
   * Create tree items for file changes
   */
  private createFileItems(changes: FileChange[], worktreePath: string, isStaged: boolean): vscode.TreeItem[] {
    // Sort changes: added first, then modified, then deleted
    const statusOrder: Record<FileChange['status'], number> = {
      added: 0,
      modified: 1,
      renamed: 2,
      deleted: 3,
    };
    const sorted = [...changes].sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    return sorted.map(change => new ChangeTreeItem(
      path.basename(change.path),
      change,
      worktreePath,
      null,
      isStaged
    ));
  }

  /**
   * Create a placeholder item for empty/error states
   */
  private createPlaceholderItem(message: string): vscode.TreeItem {
    const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }
}
