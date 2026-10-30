import * as vscode from 'vscode';
import { NativeUiAvailability } from '../harnesses/types';
import { canonicalPath } from '../utils/paths';

/**
 * Whether the native UI can work in `cwd`.
 *
 * Both agent UIs run in the first VS Code workspace folder, so a session from
 * another worktree would start its work in the wrong place. A caller that also
 * needs a single-folder workspace (a new conversation has no cwd of its own
 * yet) passes `requireSingleFolder`.
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
