import * as vscode from 'vscode';
import * as path from 'path';
import { ChatSession, FileChange, Worktree } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';

/**
 * Tree item for changed files
 */
export class ChangeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly change: FileChange,
    public readonly worktreePath: string,
    public readonly baseCommit: string | null
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    // Set icon based on change type
    this.iconPath = this.getIconForStatus(change.status);

    // Format description with line counts
    const additions = change.additions > 0 ? `+${change.additions}` : '';
    const deletions = change.deletions > 0 ? `-${change.deletions}` : '';
    this.description = [additions, deletions].filter(Boolean).join(' ');

    // Set tooltip
    this.tooltip = `${change.path}\n${change.status}\n${additions} ${deletions}`.trim();

    // Set context value for menus
    this.contextValue = 'changedFile';

    // Make clickable to open diff
    this.command = {
      command: 'claude-workspaces.openDiff',
      title: 'Open Diff',
      arguments: [this],
    };
  }

  private getIconForStatus(status: FileChange['status']): vscode.ThemeIcon {
    switch (status) {
      case 'added':
        return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
      case 'modified':
        return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
      case 'deleted':
        return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
      case 'renamed':
        return new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
      default:
        return new vscode.ThemeIcon('file');
    }
  }
}

/**
 * Summary item showing total changes
 */
export class ChangeSummaryItem extends vscode.TreeItem {
  constructor(totalFiles: number, totalAdditions: number, totalDeletions: number) {
    super('Summary', vscode.TreeItemCollapsibleState.None);

    this.description = `${totalFiles} file(s), +${totalAdditions} -${totalDeletions}`;
    this.iconPath = new vscode.ThemeIcon('git-commit');
    this.contextValue = 'summary';
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
    this.refresh();
  }

  /**
   * Set the active chat to display changes for (uses chat's worktree)
   */
  setActiveChat(chatId: string | undefined, worktree?: Worktree): void {
    this.activeWorktree = worktree;
    this.refresh();
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Only show root level items
    if (element) {
      return [];
    }

    // No active worktree
    if (!this.activeWorktree) {
      return [this.createPlaceholderItem('Select a worktree or chat to view changes')];
    }

    const worktree = this.activeWorktree;

    // Get working tree changes (uncommitted changes)
    const changes = this.gitService.getWorkingTreeChanges(worktree.path);

    if (changes.length === 0) {
      return [this.createPlaceholderItem('No changes detected')];
    }

    // Calculate totals
    const totalAdditions = changes.reduce((sum, c) => sum + c.additions, 0);
    const totalDeletions = changes.reduce((sum, c) => sum + c.deletions, 0);

    // Create items
    const items: vscode.TreeItem[] = [
      new ChangeSummaryItem(changes.length, totalAdditions, totalDeletions),
    ];

    // Sort changes: added first, then modified, then deleted
    const statusOrder: Record<FileChange['status'], number> = {
      added: 0,
      modified: 1,
      renamed: 2,
      deleted: 3,
    };
    changes.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    // Add file items
    for (const change of changes) {
      items.push(new ChangeTreeItem(
        path.basename(change.path),
        change,
        worktree.path,
        null
      ));
    }

    return items;
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
