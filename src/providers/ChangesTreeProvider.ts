import * as vscode from 'vscode';
import * as path from 'path';
import { FileChange, Worktree } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';

/** Row metadata for each change status, in display order. */
const STATUS_META: Record<
  FileChange['status'],
  { letter: string; word: string; order: number }
> = {
  added: { letter: 'A', word: 'Added', order: 0 },
  modified: { letter: 'M', word: 'Modified', order: 1 },
  renamed: { letter: 'R', word: 'Renamed', order: 2 },
  deleted: { letter: 'D', word: 'Deleted', order: 3 },
};

function statusMeta(status: FileChange['status']): { letter: string; word: string; order: number } {
  return STATUS_META[status] ?? { letter: '?', word: 'Changed', order: 99 };
}

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

    const stats = [
      totalAdditions > 0 ? `+${totalAdditions}` : '',
      totalDeletions > 0 ? `-${totalDeletions}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    this.description = [
      `${fileCount} file${fileCount === 1 ? '' : 's'}`,
      stats,
    ]
      .filter(Boolean)
      .join(' · ');

    this.iconPath = new vscode.ThemeIcon(
      sectionType === 'staged' ? 'check' : 'edit',
      new vscode.ThemeColor(
        sectionType === 'staged' ? 'charts.green' : 'charts.yellow'
      )
    );

    // Stable id so watcher refreshes keep the section expanded.
    this.id = `changes:${sectionType}`;

    // Context for section-level actions (stage all, unstage all)
    this.contextValue = sectionType === 'staged' ? 'stagedSection' : 'unstagedSection';
  }
}

/**
 * Section header for rebase in progress
 */
export class RebaseSectionItem extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    current: number,
    total: number
  ) {
    super('Rebase In Progress', vscode.TreeItemCollapsibleState.None);
    this.id = 'changes:rebase';
    this.description = `Step ${current} of ${total}`;
    this.iconPath = new vscode.ThemeIcon('git-merge');
    this.contextValue = 'rebaseSection';
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

    // Status letter and line counts in description (like Source Control).
    // Nested files also show their directory, because the list is flat and
    // two `index.ts` rows would otherwise be indistinguishable.
    const statusLetter = statusMeta(change.status).letter;
    const additions = change.additions > 0 ? `+${change.additions}` : '';
    const deletions = change.deletions > 0 ? `-${change.deletions}` : '';
    const lineCounts = [additions, deletions].filter(Boolean).join(' ');
    const directory = path.dirname(change.path);
    const status = [statusLetter, lineCounts].filter(Boolean).join(' ');
    this.description = [directory === '.' ? '' : directory, status]
      .filter(Boolean)
      .join(' · ');

    const statusWord = statusMeta(change.status).word;
    this.tooltip = [change.path, [statusWord, lineCounts].filter(Boolean).join(' · ')]
      .filter(Boolean)
      .join('\n\n');

    // Set context value for menus (different for staged vs unstaged)
    this.contextValue = isStaged ? 'stagedFile' : 'unstagedFile';
    this.id = `changes:${isStaged ? 'staged' : 'unstaged'}:${change.path}`;

    // Make clickable to open diff
    this.command = {
      command: 'agntree.openDiff',
      title: 'Open Diff',
      arguments: [this],
    };
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

    // If element is a changes section, return its file children
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

      // Check for rebase in progress
      const rebaseInProgress = this.gitService.isRebaseInProgress(worktree.path);
      vscode.commands.executeCommand('setContext', 'agntree.rebaseInProgress', rebaseInProgress);
      if (rebaseInProgress) {
        const progress = this.gitService.getRebaseProgress(worktree.path);
        items.push(new RebaseSectionItem(
          worktree.path,
          progress?.current ?? 1,
          progress?.total ?? 1
        ));
      }

      // Update context for commit button visibility
      const hasChanges = this.stagedChanges.length > 0 || this.unstagedChanges.length > 0;
      vscode.commands.executeCommand('setContext', 'agntree.hasChanges', hasChanges);

      // No changes message
      if (!hasChanges && !rebaseInProgress) {
        items.push(this.createPlaceholderItem('No uncommitted changes', 'check'));
        return items;
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
    // Group by status (added, modified, renamed, deleted), then keep paths
    // alphabetical so the order is stable and scannable.
    const sorted = [...changes].sort(
      (a, b) =>
        statusMeta(a.status).order - statusMeta(b.status).order ||
        a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
    );

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
  private createPlaceholderItem(message: string, icon = 'info'): vscode.TreeItem {
    const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      icon,
      icon === 'check'
        ? new vscode.ThemeColor('charts.green')
        : new vscode.ThemeColor('descriptionForeground')
    );
    return item;
  }
}
