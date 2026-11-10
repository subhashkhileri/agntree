import * as vscode from 'vscode';
import { NativeUiAvailability, NativeUiCapability, NativeUiOpenResult } from './types';
import { attemptOpen, firstWorkspaceFolderAvailability } from './nativeUiWorkspace';
import { NativeUiTabSurfaceOptions, NativeUiTabSurfaceService } from '../services/NativeUiTabSurfaceService';

const CODEX_EXTENSION_ID = 'openai.chatgpt';
/** The custom editor the extension registers for a conversation panel. */
const CODEX_CONVERSATION_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_URI_SCHEME = 'openai-codex';
const CODEX_URI_AUTHORITY = 'route';

/**
 * The resource the Codex extension uses for a local conversation: the URI its
 * own `createNewPanel()` opens with `vscode.openWith`, and the one its
 * chat-session provider lists.
 */
export function codexConversationUri(sessionId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: CODEX_URI_SCHEME,
    authority: CODEX_URI_AUTHORITY,
    path: `/local/${sessionId}`,
    query: '',
  });
}

/** The thread a Codex conversation resource names, if any. */
export function codexSessionIdFromUri(uri: vscode.Uri): string | undefined {
  if (uri.scheme !== CODEX_URI_SCHEME || uri.authority !== CODEX_URI_AUTHORITY) {
    return undefined;
  }
  const [scope, sessionId] = uri.path.split('/').filter(Boolean);
  return (scope === 'local' || scope === 'remote') && sessionId ? sessionId : undefined;
}

/** The thread a tab shows, when it is a Codex conversation panel. */
export function codexSessionIdForTab(tab: vscode.Tab): string | undefined {
  const input = tab.input;
  return input instanceof vscode.TabInputCustom && input.viewType === CODEX_CONVERSATION_VIEW_TYPE
    ? codexSessionIdFromUri(input.uri)
    : undefined;
}

/**
 * A Codex panel's resource names its thread exactly, so panels opened from
 * the Codex extension or restored after a reload map too (ADR 0011).
 */
export function codexUiSurfaces(
  options: Omit<Partial<NativeUiTabSurfaceOptions>, 'matchByLabel'> = {}
): NativeUiTabSurfaceService {
  return new NativeUiTabSurfaceService({
    ...options,
    isUiTab: options.isUiTab ?? ((tab) => codexSessionIdForTab(tab) !== undefined),
    sessionIdForTab: options.sessionIdForTab ?? codexSessionIdForTab,
    matchByLabel: false,
  });
}

/**
 * The Codex extension's conversation panel. Its sidebar deep link is not an
 * editor tab, so it cannot carry a session identity or be placed like the
 * session's terminal; the panel (`chatgpt.conversationEditor`) can, and it
 * resumes a thread in the thread's own cwd.
 */
export class CodexUi implements NativeUiCapability {
  readonly displayName = 'Codex UI';
  readonly contextValueSuffix = 'CodexUi';
  readonly extensionId = CODEX_EXTENSION_ID;
  readonly surfaces = codexUiSurfaces();

  isInstalled(): boolean {
    return vscode.extensions.getExtension(CODEX_EXTENSION_ID) !== undefined;
  }

  /** A thread carries its own cwd, so any worktree can be handed over. */
  checkAvailability(_cwd: string): NativeUiAvailability {
    return this.isInstalled() ? { kind: 'available' } : { kind: 'not-installed' };
  }

  /**
   * A new panel starts in the extension's workspace project, built from the
   * VS Code folders, so it is safe only when the worktree is the sole folder.
   */
  checkNewSessionAvailability(cwd: string): NativeUiAvailability {
    return this.isInstalled()
      ? firstWorkspaceFolderAvailability(cwd, { requireSingleFolder: true })
      : { kind: 'not-installed' };
  }

  async openNewSession(cwd: string): Promise<NativeUiOpenResult> {
    const availability = this.checkNewSessionAvailability(cwd);
    return availability.kind === 'available'
      ? attemptOpen(() => vscode.commands.executeCommand('chatgpt.newCodexPanel'))
      : availability;
  }

  async openSession(sessionId: string, cwd: string): Promise<NativeUiOpenResult> {
    const availability = this.checkAvailability(cwd);
    if (availability.kind !== 'available') {
      return availability;
    }
    return attemptOpen(() =>
      vscode.commands.executeCommand('vscode.openWith', codexConversationUri(sessionId), CODEX_CONVERSATION_VIEW_TYPE, {
        // Like the extension's own New Codex Agent command: the active group
        // is where the session's terminal was, or where the user's files are.
        // Reopening an existing panel reveals it.
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
        preview: false,
      })
    );
  }
}
