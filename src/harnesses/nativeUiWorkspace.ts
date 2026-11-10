import * as vscode from 'vscode';
import { NativeUiAvailability } from './types';
import { canonicalPath } from '../utils/paths';
import { errorMessage } from '../utils/text';

/**
 * Whether an agent UI that runs in the first VS Code workspace folder can work
 * in `cwd`: a session from another worktree would start its work in the wrong
 * place. A new conversation, which has no cwd of its own yet, may also need a
 * single-folder workspace.
 */
export function firstWorkspaceFolderAvailability(
  cwd: string,
  options: { requireSingleFolder?: boolean } = {}
): NativeUiAvailability {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const uiCwd = folders[0]?.uri.fsPath;
  if (!uiCwd) {
    return { kind: 'no-workspace' };
  }
  if (options.requireSingleFolder && folders.length > 1) {
    return { kind: 'workspace-multi-root', uiCwd };
  }
  if (canonicalPath(uiCwd) !== canonicalPath(cwd)) {
    return { kind: 'workspace-mismatch', uiCwd };
  }
  return { kind: 'available' };
}

/** Run an open, turning a thrown error into a reportable result. */
export async function attemptOpen(
  open: () => Thenable<unknown>
): Promise<{ kind: 'opened'; via: 'command' } | { kind: 'failed'; message: string }> {
  try {
    await open();
    return { kind: 'opened', via: 'command' };
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  }
}
