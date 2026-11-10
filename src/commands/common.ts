import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessSession } from '../harnesses/types';
import { sessionDisplayName } from '../harnesses/sessionUtils';
import { ChatSession, HarnessId, Repository, Worktree } from '../types';

/** Registers commands and ties each one's lifetime to the extension. */
export type RegisterCommand = (id: string, handler: (...args: any[]) => unknown) => void;

export function commandRegistrar(context: vscode.ExtensionContext): RegisterCommand {
  return (id, handler) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

/** Run a task under a notification progress message. */
export function withProgress<T>(title: string, task: () => Thenable<T> | T): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => task()
  );
}

/**
 * Ask for a worktree across every stored workspace root. A plain folder is its
 * own only worktree and is listed once under its name.
 */
export async function pickWorktree(
  storageService: StorageService,
  gitService: GitService,
  placeHolder: string
): Promise<Worktree | undefined> {
  const items = storageService.getRepositories().flatMap((repo) => {
    const { isGit, worktrees } = gitService.listRepositoryWorktrees(repo.rootPath, repo.id);
    return worktrees.map((worktree) => ({
      label: isGit ? `${repo.name} / ${worktree.name}` : repo.name,
      description: worktree.path,
      worktree,
    }));
  });
  if (items.length === 0) {
    vscode.window.showErrorMessage('No worktrees available. Add a folder first.');
    return undefined;
  }
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.worktree;
}

/** Ask for a new branch name that does not exist yet. */
export function promptNewBranchName(
  existingBranches: readonly string[],
  options: { prompt: string; value?: string }
): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    prompt: options.prompt,
    value: options.value,
    placeHolder: 'feature/my-feature',
    validateInput: (value) => {
      if (!value.trim()) {
        return 'Branch name is required';
      }
      if (existingBranches.includes(value)) {
        return 'Branch already exists';
      }
      if (!/^[\w\-/.]+$/.test(value)) {
        return 'Invalid branch name. Use only letters, numbers, hyphens, slashes, and dots.';
      }
      return undefined;
    },
  });
}

/** Where a new worktree for `branch` goes: `<parent>/<repo>-worktrees/<branch>`. */
export function defaultWorktreePath(repo: Repository, branch: string): string {
  return path.join(path.dirname(repo.rootPath), `${repo.name}-worktrees`, branch.replace(/\//g, '-'));
}

/** Shown when an action needs a harness CLI and none is installed. */
export function noHarnessInstalledMessage(harnessRegistry: HarnessRegistry): string {
  const names = harnessRegistry.all().map((adapter) => adapter.displayName);
  return `No supported harnesses detected. Install one of: ${names.join(', ')}.`;
}

/**
 * Add a native session to a worktree as a row. Importing by hand is also the
 * user undoing an earlier removal, so the session's tombstone is cleared.
 */
export function importNativeSession(
  storageService: StorageService,
  worktree: Worktree,
  harness: HarnessId,
  session: Pick<HarnessSession, 'sessionId' | 'summary' | 'lastUpdated'>
): ChatSession {
  const chat = storageService.createChat(worktree.id, harness, sessionDisplayName(session, 'Imported: '), {
    harnessSessionId: session.sessionId,
    createdAt: session.lastUpdated?.getTime() || Date.now(),
  });
  storageService.forgetRemovedSession(harness, session.sessionId);
  return chat;
}
