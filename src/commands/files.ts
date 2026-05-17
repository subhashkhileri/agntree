import * as vscode from 'vscode';
import * as path from 'path';
import { FileTreeItem, FilesTreeProvider } from '../providers/FilesTreeProvider';

async function uniqueDestUri(targetDirUri: vscode.Uri, sourceUri: vscode.Uri): Promise<vscode.Uri> {
  const name = path.basename(sourceUri.fsPath);
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;

  let candidate = vscode.Uri.joinPath(targetDirUri, name);
  let counter = 0;

  while (true) {
    try {
      await vscode.workspace.fs.stat(candidate);
      // File exists — generate a new name
      counter++;
      const suffix = counter === 1 ? ' copy' : ` copy ${counter}`;
      candidate = vscode.Uri.joinPath(targetDirUri, `${base}${suffix}${ext}`);
    } catch {
      // stat threw → file does not exist, this name is free
      return candidate;
    }
  }
}

export function registerFileCommands(
  context: vscode.ExtensionContext,
  filesProvider: FilesTreeProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.files.refresh', () => {
      filesProvider.refresh();
    }),

    vscode.commands.registerCommand('agntree.files.openToSide', (item: FileTreeItem) => {
      vscode.commands.executeCommand('vscode.open', item.uri, vscode.ViewColumn.Beside);
    }),

    vscode.commands.registerCommand('agntree.files.revealInFinder', (item: FileTreeItem) => {
      vscode.commands.executeCommand('revealFileInOS', item.uri);
    }),

    vscode.commands.registerCommand('agntree.files.openInTerminal', (item: FileTreeItem) => {
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const cwd = isFolder ? item.uri.fsPath : path.dirname(item.uri.fsPath);
      vscode.window.createTerminal({ cwd }).show();
    }),

    vscode.commands.registerCommand('agntree.files.copyPath', (item: FileTreeItem) => {
      vscode.env.clipboard.writeText(item.uri.fsPath);
    }),

    vscode.commands.registerCommand('agntree.files.copyRelativePath', (item: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      vscode.env.clipboard.writeText(path.relative(worktree.path, item.uri.fsPath));
    }),

    vscode.commands.registerCommand('agntree.files.rename', async (item: FileTreeItem) => {
      const oldName = path.basename(item.uri.fsPath);
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const dotIndex = oldName.lastIndexOf('.');
      const selectionEnd = (!isFolder && dotIndex > 0) ? dotIndex : oldName.length;

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new name',
        value: oldName,
        valueSelection: [0, selectionEnd],
      });
      if (!newName || newName === oldName) { return; }

      const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(item.uri.fsPath)), newName);
      try {
        await vscode.workspace.fs.rename(item.uri, newUri, { overwrite: false });
        filesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Rename failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.delete', async (item: FileTreeItem) => {
      const name = path.basename(item.uri.fsPath);
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const answer = await vscode.window.showWarningMessage(
        `Delete ${isFolder ? 'folder' : 'file'} "${name}"?`,
        { modal: true },
        'Delete'
      );
      if (answer !== 'Delete') { return; }
      try {
        await vscode.workspace.fs.delete(item.uri, { recursive: isFolder, useTrash: true });
        filesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Delete failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.newFile', async (item?: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      const parentPath = item ? item.uri.fsPath : worktree.path;
      const name = await vscode.window.showInputBox({ prompt: 'File name' });
      if (!name) { return; }
      const newUri = vscode.Uri.joinPath(vscode.Uri.file(parentPath), name);
      try {
        await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
        filesProvider.refresh();
        vscode.commands.executeCommand('vscode.open', newUri);
      } catch (err) {
        vscode.window.showErrorMessage(`Could not create file: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.newFolder', async (item?: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      const parentPath = item ? item.uri.fsPath : worktree.path;
      const name = await vscode.window.showInputBox({ prompt: 'Folder name' });
      if (!name) { return; }
      const newUri = vscode.Uri.joinPath(vscode.Uri.file(parentPath), name);
      try {
        await vscode.workspace.fs.createDirectory(newUri);
        filesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Could not create folder: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.copy', (item: FileTreeItem) => {
      filesProvider.setClipboard(item.uri, false);
      vscode.window.setStatusBarMessage(`Copied: ${path.basename(item.uri.fsPath)}`, 3000);
    }),

    vscode.commands.registerCommand('agntree.files.cut', (item: FileTreeItem) => {
      filesProvider.setClipboard(item.uri, true);
      vscode.window.setStatusBarMessage(`Cut: ${path.basename(item.uri.fsPath)}`, 3000);
    }),

    vscode.commands.registerCommand('agntree.files.paste', async (item?: FileTreeItem) => {
      const clipboard = filesProvider.getClipboard();
      if (!clipboard) { return; }

      const worktree = filesProvider.getActiveWorktree();

      // Resolve target directory: folder item → that folder, file item → its parent, no item → worktree root
      let targetDir: string | undefined;
      if (item) {
        const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
        targetDir = isFolder ? item.uri.fsPath : path.dirname(item.uri.fsPath);
      } else {
        targetDir = worktree?.path;
      }
      if (!targetDir) { return; }

      const destUri = await uniqueDestUri(vscode.Uri.file(targetDir), clipboard.uri);
      try {
        if (clipboard.isCut) {
          await vscode.workspace.fs.rename(clipboard.uri, destUri, { overwrite: false });
          filesProvider.clearClipboard();
        } else {
          await vscode.workspace.fs.copy(clipboard.uri, destUri, { overwrite: false });
        }
        filesProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Paste failed: ${err}`);
      }
    })
  );
}
