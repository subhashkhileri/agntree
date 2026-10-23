import * as vscode from 'vscode';
import * as path from 'path';
import { FileTreeItem, FilesTreeProvider } from '../providers/FilesTreeProvider';
import { logOperation } from '../services/OperationLog';
import { isStrictlyWithin, isWithin } from '../utils/paths';

/** Resolve a user-entered name, refusing anything that is not one segment. */
function validateName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Name is required';
  }
  if (trimmed === '.' || trimmed === '..') {
    return 'Invalid name';
  }
  if (/[\\/]/.test(trimmed) || trimmed.includes('\0')) {
    return 'Name cannot contain path separators';
  }
  return undefined;
}

/** Create an empty file or folder through the shared guard/refresh flow. */
async function createEntry(
  filesProvider: FilesTreeProvider,
  kind: 'file' | 'folder',
  item?: FileTreeItem
): Promise<void> {
  const worktree = filesProvider.getActiveWorktree();
  if (!worktree) { return; }
  const parentPath = item ? item.uri.fsPath : worktree.path;
  if (!isWithin(parentPath, worktree.path)) {
    vscode.window.showErrorMessage(`Refusing to create a ${kind} outside the active worktree.`);
    logOperation(`Refused new ${kind} outside worktree: ${parentPath}`);
    return;
  }

  const name = await vscode.window.showInputBox({
    prompt: kind === 'file' ? 'File name' : 'Folder name',
    validateInput: validateName,
  });
  if (!name) { return; }

  const newUri = vscode.Uri.joinPath(vscode.Uri.file(parentPath), name);
  try {
    if (kind === 'folder') {
      await vscode.workspace.fs.createDirectory(newUri);
      logOperation(`Created folder: ${path.relative(worktree.path, newUri.fsPath)}`);
    } else {
      // writeFile truncates, so never touch an existing path.
      const exists = await vscode.workspace.fs.stat(newUri).then(
        () => true,
        () => false
      );
      if (exists) {
        vscode.window.showErrorMessage(`"${name}" already exists.`);
        logOperation(`Refused to overwrite existing file: ${newUri.fsPath}`);
        return;
      }
      await vscode.workspace.fs.writeFile(newUri, new Uint8Array());
      logOperation(`Created file: ${path.relative(worktree.path, newUri.fsPath)}`);
      filesProvider.refresh();
      vscode.commands.executeCommand('vscode.open', newUri);
      return;
    }
    filesProvider.refresh();
  } catch (err) {
    logOperation(`Create ${kind} failed: ${newUri.fsPath} (${String(err)})`);
    vscode.window.showErrorMessage(`Could not create ${kind}: ${err}`);
  }
}

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
    vscode.commands.registerCommand('agntree.files.search', () => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      vscode.commands.executeCommand('workbench.action.findInFiles', {
        filesToInclude: worktree.path,
      });
    }),

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
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      if (!isStrictlyWithin(item.uri.fsPath, worktree.path)) {
        vscode.window.showErrorMessage('Refusing to rename a path outside the active worktree.');
        logOperation(`Refused rename outside worktree: ${item.uri.fsPath}`);
        return;
      }

      const oldName = path.basename(item.uri.fsPath);
      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const dotIndex = oldName.lastIndexOf('.');
      const selectionEnd = (!isFolder && dotIndex > 0) ? dotIndex : oldName.length;

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new name',
        value: oldName,
        valueSelection: [0, selectionEnd],
        validateInput: validateName,
      });
      if (!newName || newName === oldName) { return; }

      const newUri = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(item.uri.fsPath)), newName);
      if (!isStrictlyWithin(newUri.fsPath, worktree.path)) {
        vscode.window.showErrorMessage('Refusing to rename to a path outside the active worktree.');
        logOperation(`Refused rename to outside worktree: ${newUri.fsPath}`);
        return;
      }

      try {
        await vscode.workspace.fs.rename(item.uri, newUri, { overwrite: false });
        logOperation(
          `Renamed ${path.relative(worktree.path, item.uri.fsPath)} -> ${newName}`
        );
        filesProvider.refresh();
      } catch (err) {
        logOperation(`Rename failed for ${item.uri.fsPath}: ${String(err)}`);
        vscode.window.showErrorMessage(`Rename failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.delete', async (item: FileTreeItem) => {
      const worktree = filesProvider.getActiveWorktree();
      if (!worktree) { return; }
      if (!isStrictlyWithin(item.uri.fsPath, worktree.path)) {
        vscode.window.showErrorMessage('Refusing to delete a path outside the active worktree.');
        logOperation(`Refused delete outside worktree: ${item.uri.fsPath}`);
        return;
      }

      const isFolder = (item.fileType & vscode.FileType.Directory) !== 0;
      const relativePath = path.relative(worktree.path, item.uri.fsPath);
      const answer = await vscode.window.showWarningMessage(
        `Move ${isFolder ? 'folder' : 'file'} "${relativePath}" to the Trash?`,
        { modal: true },
        'Move to Trash'
      );
      if (answer !== 'Move to Trash') { return; }
      try {
        await vscode.workspace.fs.delete(item.uri, { recursive: isFolder, useTrash: true });
        logOperation(`Moved to Trash: ${relativePath}`);
        filesProvider.refresh();
      } catch (err) {
        logOperation(`Delete failed for ${relativePath}: ${String(err)}`);
        vscode.window.showErrorMessage(`Delete failed: ${err}`);
      }
    }),

    vscode.commands.registerCommand('agntree.files.newFile', (item?: FileTreeItem) =>
      createEntry(filesProvider, 'file', item)
    ),

    vscode.commands.registerCommand('agntree.files.newFolder', (item?: FileTreeItem) =>
      createEntry(filesProvider, 'folder', item)
    ),

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
      if (!worktree) { return; }

      // Resolve target directory: folder item → that folder, file item → its parent, no item → worktree root
      const targetDir = item
        ? ((item.fileType & vscode.FileType.Directory) !== 0
            ? item.uri.fsPath
            : path.dirname(item.uri.fsPath))
        : worktree.path;
      if (!isWithin(targetDir, worktree.path)) {
        vscode.window.showErrorMessage('Refusing to paste outside the active worktree.');
        logOperation(`Refused paste outside worktree: ${targetDir}`);
        return;
      }

      const sourcePath = path.resolve(clipboard.uri.fsPath);
      let sourceIsFolder = false;
      try {
        sourceIsFolder =
          ((await vscode.workspace.fs.stat(clipboard.uri)).type & vscode.FileType.Directory) !== 0;
      } catch {
        vscode.window.showErrorMessage('The item to paste no longer exists.');
        logOperation(`Paste source missing: ${sourcePath}`);
        filesProvider.clearClipboard();
        return;
      }

      // A folder cannot be pasted into itself or one of its descendants;
      // that would recurse forever or delete the source mid-copy.
      if (sourceIsFolder && isWithin(targetDir, sourcePath)) {
        vscode.window.showErrorMessage('Cannot paste a folder into itself.');
        logOperation(`Refused paste of ${sourcePath} into its own subtree: ${targetDir}`);
        return;
      }

      // Cutting into the same folder is a no-op, not a rename to "<name> copy".
      if (
        clipboard.isCut &&
        path.resolve(path.dirname(sourcePath)) === path.resolve(targetDir)
      ) {
        vscode.window.showInformationMessage('The item is already in this folder.');
        return;
      }

      const destUri = await uniqueDestUri(vscode.Uri.file(targetDir), clipboard.uri);
      const relativeSource = path.relative(worktree.path, sourcePath);
      const relativeDest = path.relative(worktree.path, destUri.fsPath);
      try {
        if (clipboard.isCut) {
          await vscode.workspace.fs.rename(clipboard.uri, destUri, { overwrite: false });
          filesProvider.clearClipboard();
          logOperation(`Moved ${relativeSource} -> ${relativeDest}`);
        } else {
          await vscode.workspace.fs.copy(clipboard.uri, destUri, { overwrite: false });
          logOperation(`Copied ${relativeSource} -> ${relativeDest}`);
        }
        filesProvider.refresh();
      } catch (err) {
        logOperation(`Paste failed: ${relativeSource} -> ${relativeDest} (${String(err)})`);
        vscode.window.showErrorMessage(`Paste failed: ${err}`);
      }
    })
  );
}
