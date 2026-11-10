import * as vscode from 'vscode';
import * as path from 'path';
import { GitOutcome, GitService } from '../services/GitService';
import { ChangesTreeProvider, ChangeTreeItem } from '../providers/ChangesTreeProvider';
import { Worktree } from '../types';
import { isStrictlyWithin } from '../utils/paths';
import { logOperation } from '../services/OperationLog';
import { RegisterCommand, commandRegistrar } from './common';

/**
 * Register the Changes panel commands: diffs, staging, discards, and the
 * rebase controls. Every command acts on the panel's active worktree.
 */
export function registerChangesCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  changesProvider: ChangesTreeProvider,
  refreshTree: () => void
): void {
  const register = commandRegistrar(context);

  /** A per-file git action that refreshes the panel or reports the failure. */
  const fileAction =
    (run: (worktreePath: string, filePath: string) => boolean, verb: string) =>
    (item?: ChangeTreeItem) => {
      if (!(item instanceof ChangeTreeItem)) {
        return;
      }
      if (run(item.worktreePath, item.change.path)) {
        changesProvider.refresh();
      } else {
        vscode.window.showErrorMessage(`Failed to ${verb} ${item.change.path}`);
      }
    };

  /** A whole-worktree git action on the panel's active worktree. */
  const worktreeAction =
    (run: (worktreePath: string) => boolean, failure: string) => () => {
      const worktree = changesProvider.getActiveWorktree();
      if (!worktree) {
        return;
      }
      if (run(worktree.path)) {
        changesProvider.refresh();
      } else {
        vscode.window.showErrorMessage(failure);
      }
    };

  register('agntree.refreshChanges', () => changesProvider.refresh());
  register('agntree.stageFile', fileAction((w, f) => gitService.stageFile(w, f), 'stage'));
  register('agntree.unstageFile', fileAction((w, f) => gitService.unstageFile(w, f), 'unstage'));
  register('agntree.stageAll', worktreeAction((w) => gitService.stageAll(w), 'Failed to stage all changes'));
  register('agntree.unstageAll', worktreeAction((w) => gitService.unstageAll(w), 'Failed to unstage all changes'));

  registerDiffCommand(register, gitService);

  register('agntree.discardFile', async (item?: ChangeTreeItem) => {
    if (!(item instanceof ChangeTreeItem)) {
      return;
    }

    const fullPath = path.resolve(item.worktreePath, item.change.path);
    if (!isStrictlyWithin(fullPath, item.worktreePath)) {
      vscode.window.showErrorMessage('Refusing to discard a path outside the worktree.');
      logOperation(`Refused discard outside worktree: ${fullPath}`);
      return;
    }

    // Untracked files are deleted, not restored, so they get a clear
    // confirmation and go to the Trash instead of vanishing.
    const tracked = gitService.isTracked(item.worktreePath, item.change.path);
    const confirm = await vscode.window.showWarningMessage(
      tracked
        ? `Discard changes to "${item.change.path}"? This cannot be undone.`
        : `Move untracked file "${item.change.path}" to the Trash?`,
      { modal: true },
      'Discard'
    );
    if (confirm !== 'Discard') {
      return;
    }

    let success: boolean;
    if (tracked) {
      success = gitService.discardFile(item.worktreePath, item.change.path);
    } else {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(fullPath), { useTrash: true });
        success = true;
      } catch {
        success = false;
      }
    }

    if (success) {
      logOperation(
        tracked
          ? `Discarded changes: ${item.change.path}`
          : `Moved untracked file to Trash: ${item.change.path}`
      );
      changesProvider.refresh();
    } else {
      logOperation(`Discard failed: ${item.change.path}`);
      vscode.window.showErrorMessage(`Failed to discard changes to ${item.change.path}`);
    }
  });

  register('agntree.discardAll', async () => {
    const worktree = changesProvider.getActiveWorktree();
    if (!worktree) {
      return;
    }

    // Spell out what `git clean` is about to delete; untracked files do not
    // go to the Trash.
    const summary = gitService.getDiscardSummary(worktree.path);
    const counts: string[] = [];
    if (summary.tracked > 0) {
      counts.push(plural(summary.tracked, 'modified file'));
    }
    if (summary.untracked.length > 0) {
      const n = summary.untracked.length;
      counts.push(`${n} untracked file${n === 1 ? '' : 's'} or folder${n === 1 ? '' : 's'}`);
    }
    const message =
      counts.length > 0
        ? `Discard ${counts.join(' and ')} in "${worktree.name}"?\n\nUntracked files and folders are permanently deleted. This cannot be undone.`
        : `Discard all unstaged changes in "${worktree.name}"? This cannot be undone.`;

    const confirm = await vscode.window.showWarningMessage(message, { modal: true }, 'Discard All');
    if (confirm !== 'Discard All') {
      return;
    }

    if (gitService.discardAll(worktree.path)) {
      const listed = summary.untracked.slice(0, 20).join(', ');
      const more = summary.untracked.length > 20 ? `, … (${summary.untracked.length - 20} more)` : '';
      logOperation(
        `Discarded ${summary.tracked} tracked change(s) in ${worktree.path}` +
          (summary.untracked.length > 0 ? `; deleted untracked: ${listed}${more}` : '')
      );
      changesProvider.refresh();
    } else {
      logOperation(`Discard-all failed in ${worktree.path}`);
      vscode.window.showErrorMessage('Failed to discard all changes');
    }
  });

  /** The active worktree, when a rebase is in progress there. */
  const rebasingWorktree = (): Worktree | undefined => {
    const worktree = changesProvider.getActiveWorktree();
    if (!worktree) {
      vscode.window.showErrorMessage('No active worktree selected.');
      return undefined;
    }
    if (!gitService.isRebaseInProgress(worktree.path)) {
      vscode.window.showInformationMessage('No rebase in progress.');
      return undefined;
    }
    return worktree;
  };

  /** Continue and Skip share one shape: run, then report where the rebase stands. */
  const rebaseStep =
    (
      run: (worktreePath: string) => GitOutcome,
      messages: { stillRunning: string; finished: string; failed: string }
    ) =>
    () => {
      const worktree = rebasingWorktree();
      if (!worktree) {
        return;
      }
      const result = run(worktree.path);
      if (!result.success) {
        vscode.window.showErrorMessage(`${messages.failed}: ${result.error || 'Unknown error'}`);
      } else if (gitService.isRebaseInProgress(worktree.path)) {
        vscode.window.showWarningMessage(messages.stillRunning);
      } else {
        vscode.window.showInformationMessage(messages.finished);
        refreshTree();
      }
      changesProvider.refresh();
    };

  register(
    'agntree.rebaseContinue',
    rebaseStep((w) => gitService.rebaseContinue(w), {
      stillRunning: 'Rebase continued but more conflicts were encountered. Resolve and continue.',
      finished: 'Rebase completed successfully.',
      failed: 'Failed to continue rebase',
    })
  );
  register(
    'agntree.rebaseSkip',
    rebaseStep((w) => gitService.rebaseSkip(w), {
      stillRunning: 'Commit skipped but rebase is still in progress.',
      finished: 'Rebase completed after skipping.',
      failed: 'Failed to skip',
    })
  );

  register('agntree.rebaseAbort', async () => {
    const worktree = rebasingWorktree();
    if (!worktree) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      'Abort the current rebase? This will restore the branch to its original state.',
      { modal: true },
      'Abort Rebase'
    );
    if (confirm !== 'Abort Rebase') {
      return;
    }
    if (gitService.rebaseAbort(worktree.path)) {
      vscode.window.showInformationMessage('Rebase aborted.');
      refreshTree();
    } else {
      vscode.window.showErrorMessage('Failed to abort rebase.');
    }
    changesProvider.refresh();
  });
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Open Diff shows one file at a time in the second editor group: clicking the
 * open file again closes it, and clicking another file replaces it.
 */
function registerDiffCommand(register: RegisterCommand, gitService: GitService): void {
  let currentDiffPath: string | null = null;

  const closeCurrentDiff = async (): Promise<void> => {
    if (!currentDiffPath) {
      return;
    }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        const uri =
          input instanceof vscode.TabInputTextDiff
            ? input.modified
            : input instanceof vscode.TabInputText
              ? input.uri
              : undefined;
        if (uri?.fsPath === currentDiffPath) {
          await Promise.resolve(vscode.window.tabGroups.close(tab)).catch(() => undefined);
          return;
        }
      }
    }
  };

  const gitUri = (filePath: string, ref: string): vscode.Uri =>
    vscode.Uri.from({
      scheme: 'git',
      path: filePath,
      query: JSON.stringify({ path: filePath, ref }),
    });

  const showInSecondGroup = async (uri: vscode.Uri): Promise<void> => {
    await vscode.window.showTextDocument(uri, {
      viewColumn: vscode.ViewColumn.Two,
      preview: true,
      preserveFocus: false,
    });
  };

  register('agntree.openDiff', async (item?: ChangeTreeItem) => {
    if (!(item instanceof ChangeTreeItem)) {
      return;
    }

    const fullPath = path.join(item.worktreePath, item.change.path);
    const fileName = path.basename(item.change.path);
    const fileUri = vscode.Uri.file(fullPath);

    // Clicking the open file again closes it.
    if (currentDiffPath === fullPath) {
      await closeCurrentDiff();
      currentDiffPath = null;
      return;
    }
    await closeCurrentDiff();
    currentDiffPath = fullPath;

    // Open the repository in VS Code's Git extension so the git: scheme works
    // for repositories outside the workspace.
    await Promise.resolve(
      vscode.commands.executeCommand('git.openRepository', item.worktreePath)
    ).catch(() => undefined);
    await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');

    try {
      if (item.change.status === 'added') {
        // Nothing to compare against: a staged addition shows what will be
        // committed, an untracked file its working copy.
        await showInSecondGroup(item.isStaged ? gitUri(fullPath, '~') : fileUri);
      } else if (item.isStaged) {
        // Staged: HEAD on the left, the index on the right.
        await vscode.commands.executeCommand(
          'vscode.diff',
          gitUri(fullPath, 'HEAD'),
          gitUri(fullPath, '~'),
          `${fileName} (Staged)`,
          { viewColumn: vscode.ViewColumn.Two, preview: true }
        );
      } else {
        // Unstaged: the index on the left, the working tree on the right.
        await vscode.commands.executeCommand(
          'vscode.diff',
          gitUri(fullPath, '~'),
          fileUri,
          fileName,
          { viewColumn: vscode.ViewColumn.Two, preview: true }
        );
      }
      // Lock the group so other files do not take it over.
      await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    } catch {
      try {
        await vscode.commands.executeCommand('git.openChange', fileUri);
      } catch {
        await vscode.window.showTextDocument(fileUri, {
          viewColumn: vscode.ViewColumn.Two,
          preview: true,
        });
      }
    }
  });
}
