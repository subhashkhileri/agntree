import * as vscode from 'vscode';
import * as path from 'path';
import { Worktree } from '../types';

const HIDDEN_NAMES = new Set(['.git', 'node_modules', '.DS_Store', '.next', 'dist', 'out', '.turbo']);

export class FileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly uri: vscode.Uri,
    public readonly fileType: vscode.FileType,
    rootPath: string
  ) {
    const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
    super(
      path.basename(uri.fsPath),
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.resourceUri = uri;
    // Stable id so file-watcher refreshes keep selection and expansion state.
    this.id = `file:${uri.fsPath}`;
    this.tooltip = path.relative(rootPath, uri.fsPath) || path.basename(uri.fsPath);
    this.contextValue = isDirectory ? 'folder' : 'file';
    if (!isDirectory) {
      this.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [uri],
      };
    }
  }
}

export class FilesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private activeWorktree: Worktree | undefined;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private clipboard: { uri: vscode.Uri; isCut: boolean } | undefined;

  setClipboard(uri: vscode.Uri, isCut: boolean): void {
    this.clipboard = { uri, isCut };
    vscode.commands.executeCommand('setContext', 'agntree.hasFileClipboard', true);
  }

  getClipboard(): { uri: vscode.Uri; isCut: boolean } | undefined {
    return this.clipboard;
  }

  clearClipboard(): void {
    this.clipboard = undefined;
    vscode.commands.executeCommand('setContext', 'agntree.hasFileClipboard', false);
  }

  setActiveWorktree(worktree: Worktree | undefined): void {
    this.activeWorktree = worktree;
    this.setupFileWatcher();
    this.refresh();
  }

  getActiveWorktree(): Worktree | undefined {
    return this.activeWorktree;
  }

  private setupFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
    if (!this.activeWorktree) {
      return;
    }

    const pattern = new vscode.RelativePattern(this.activeWorktree.path, '**/*');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

    const debouncedRefresh = () => {
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
      }
      this.refreshTimer = setTimeout(() => this.refresh(), 300);
    };

    this.fileWatcher.onDidChange(debouncedRefresh);
    this.fileWatcher.onDidCreate(debouncedRefresh);
    this.fileWatcher.onDidDelete(debouncedRefresh);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this.fileWatcher?.dispose();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.activeWorktree) {
      const placeholder = new vscode.TreeItem(
        'Select a worktree or chat',
        vscode.TreeItemCollapsibleState.None
      );
      placeholder.iconPath = new vscode.ThemeIcon(
        'info',
        new vscode.ThemeColor('descriptionForeground')
      );
      return [placeholder];
    }

    const rootPath = this.activeWorktree.path;
    const dirUri =
      element instanceof FileTreeItem ? element.uri : vscode.Uri.file(rootPath);

    try {
      const entries = await vscode.workspace.fs.readDirectory(dirUri);

      const filtered = entries.filter(([name]) => !HIDDEN_NAMES.has(name));

      // Directories first, then files — each group sorted naturally, so
      // `file2` comes before `file10` and case does not decide the order.
      filtered.sort(([nameA, typeA], [nameB, typeB]) => {
        const isDirA = (typeA & vscode.FileType.Directory) !== 0;
        const isDirB = (typeB & vscode.FileType.Directory) !== 0;
        if (isDirA !== isDirB) {
          return isDirA ? -1 : 1;
        }
        return nameA.localeCompare(nameB, undefined, {
          sensitivity: 'base',
          numeric: true,
        });
      });

      return filtered.map(([name, type]) =>
        new FileTreeItem(vscode.Uri.joinPath(dirUri, name), type, rootPath)
      );
    } catch {
      return [];
    }
  }
}
