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

/**
 * The All Files view: one worktree's files, without build output and VCS
 * metadata. The extension refreshes it when the worktree's files change.
 */
export class FilesTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private activeWorktree: Worktree | undefined;
  private clipboard: { uri: vscode.Uri; isCut: boolean } | undefined;

  setClipboard(uri: vscode.Uri, isCut: boolean): void {
    this.clipboard = { uri, isCut };
    void vscode.commands.executeCommand('setContext', 'agntree.hasFileClipboard', true);
  }

  getClipboard(): { uri: vscode.Uri; isCut: boolean } | undefined {
    return this.clipboard;
  }

  clearClipboard(): void {
    this.clipboard = undefined;
    void vscode.commands.executeCommand('setContext', 'agntree.hasFileClipboard', false);
  }

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
