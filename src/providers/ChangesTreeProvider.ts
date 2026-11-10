import * as vscode from 'vscode';
import * as path from 'path';
import { FileChange, Worktree } from '../types';
import { GitService } from '../services/GitService';

/** Row letter, tooltip word, and sort order for each change status. */
const STATUS: Record<FileChange['status'], { letter: string; word: string; order: number }> = {
  added: { letter: 'A', word: 'Added', order: 0 },
  modified: { letter: 'M', word: 'Modified', order: 1 },
  deleted: { letter: 'D', word: 'Deleted', order: 2 },
};

/** "+3 -1", omitting zero counts. */
function lineCounts(additions: number, deletions: number): string {
  return [additions > 0 ? `+${additions}` : '', deletions > 0 ? `-${deletions}` : '']
    .filter(Boolean)
    .join(' ');
}

const join = (separator: string, parts: string[]) => parts.filter(Boolean).join(separator);

export class ChangeSectionItem extends vscode.TreeItem {
  constructor(
    public readonly sectionType: 'staged' | 'unstaged',
    public readonly changes: FileChange[]
  ) {
    super(sectionType === 'staged' ? 'Staged Changes' : 'Changes', vscode.TreeItemCollapsibleState.Expanded);
    const count = changes.length;
    this.description = join(' · ', [
      `${count} file${count === 1 ? '' : 's'}`,
      lineCounts(
        changes.reduce((sum, c) => sum + c.additions, 0),
        changes.reduce((sum, c) => sum + c.deletions, 0)
      ),
    ]);
    this.iconPath = new vscode.ThemeIcon(
      sectionType === 'staged' ? 'check' : 'edit',
      new vscode.ThemeColor(sectionType === 'staged' ? 'charts.green' : 'charts.yellow')
    );
    // Stable id so watcher refreshes keep the section expanded.
    this.id = `changes:${sectionType}`;
    this.contextValue = sectionType === 'staged' ? 'stagedSection' : 'unstagedSection';
  }
}

export class RebaseSectionItem extends vscode.TreeItem {
  constructor(current: number, total: number) {
    super('Rebase In Progress', vscode.TreeItemCollapsibleState.None);
    this.id = 'changes:rebase';
    this.description = `Step ${current} of ${total}`;
    this.iconPath = new vscode.ThemeIcon('git-merge');
    this.contextValue = 'rebaseSection';
  }
}

export class ChangeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly change: FileChange,
    public readonly worktreePath: string,
    public readonly isStaged: boolean
  ) {
    super(path.basename(change.path), vscode.TreeItemCollapsibleState.None);
    // The theme's file icon, as in the Explorer.
    this.resourceUri = vscode.Uri.file(path.join(worktreePath, change.path));

    // The list is flat, so nested files also show their directory; two
    // `index.ts` rows would otherwise be indistinguishable.
    const { letter, word } = STATUS[change.status];
    const counts = lineCounts(change.additions, change.deletions);
    const directory = path.dirname(change.path);
    this.description = join(' · ', [directory === '.' ? '' : directory, join(' ', [letter, counts])]);
    this.tooltip = join('\n\n', [change.path, join(' · ', [word, counts])]);

    this.contextValue = isStaged ? 'stagedFile' : 'unstagedFile';
    this.id = `changes:${isStaged ? 'staged' : 'unstaged'}:${change.path}`;
    this.command = { command: 'agntree.openDiff', title: 'Open Diff', arguments: [this] };
  }
}

/**
 * The Changes view: staged and unstaged changes of one worktree, plus rebase
 * controls while a rebase is stopped. The extension refreshes it when the
 * worktree's files change.
 */
export class ChangesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  private activeWorktree: Worktree | undefined;

  constructor(
    private readonly gitService: GitService,
    private readonly isGitWorktree: (worktree: Worktree) => boolean
  ) {}

  setActiveWorktree(worktree: Worktree | undefined): void {
    this.activeWorktree = worktree;
    this.refresh();
  }

  getActiveWorktree(): Worktree | undefined {
    return this.activeWorktree;
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const worktree = this.activeWorktree;
    if (!worktree) {
      return [placeholder('Select a worktree or chat to view changes')];
    }
    if (element instanceof ChangeSectionItem) {
      return [...element.changes]
        .sort(
          (a, b) =>
            STATUS[a.status].order - STATUS[b.status].order ||
            a.path.localeCompare(b.path, undefined, { sensitivity: 'base' })
        )
        .map((change) => new ChangeTreeItem(change, worktree.path, element.sectionType === 'staged'));
    }
    if (element) {
      return [];
    }

    // A plain folder has no git state; answer from the tree's cached state
    // so it never spawns git processes that can only fail.
    if (!this.isGitWorktree(worktree)) {
      setContext(false, false);
      return [placeholder('Not a git repository')];
    }

    const staged = this.gitService.getStagedChanges(worktree.path);
    const unstaged = this.gitService.getUnstagedChanges(worktree.path);
    const progress = this.gitService.isRebaseInProgress(worktree.path)
      ? this.gitService.getRebaseProgress(worktree.path) ?? { current: 1, total: 1 }
      : undefined;
    const hasChanges = staged.length > 0 || unstaged.length > 0;
    setContext(Boolean(progress), hasChanges);

    const items: vscode.TreeItem[] = [];
    if (progress) {
      items.push(new RebaseSectionItem(progress.current, progress.total));
    } else if (!hasChanges) {
      items.push(placeholder('No uncommitted changes', 'check'));
    }
    if (staged.length > 0) {
      items.push(new ChangeSectionItem('staged', staged));
    }
    if (unstaged.length > 0) {
      items.push(new ChangeSectionItem('unstaged', unstaged));
    }
    return items;
  }
}

function setContext(rebaseInProgress: boolean, hasChanges: boolean): void {
  void vscode.commands.executeCommand('setContext', 'agntree.rebaseInProgress', rebaseInProgress);
  void vscode.commands.executeCommand('setContext', 'agntree.hasChanges', hasChanges);
}

function placeholder(message: string, icon = 'info'): vscode.TreeItem {
  const item = new vscode.TreeItem(message, vscode.TreeItemCollapsibleState.None);
  item.iconPath = new vscode.ThemeIcon(
    icon,
    new vscode.ThemeColor(icon === 'check' ? 'charts.green' : 'descriptionForeground')
  );
  return item;
}
