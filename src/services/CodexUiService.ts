import * as vscode from 'vscode';
import {
  NativeUiAvailability,
  NativeUiOpenResult,
} from '../harnesses/types';
import {
  CODEX_CONVERSATION_VIEW_TYPE,
  CODEX_EXTENSION_ID,
  codexConversationUri,
} from './codexUiUri';
import { errorMessage } from '../utils/text';
import { firstWorkspaceFolderAvailability } from './nativeUiWorkspace';

/**
 * Hands an existing Codex thread to the Codex extension's conversation panel.
 *
 * The extension's sidebar deep link is not an editor tab, so it cannot carry
 * an exact session identity or be placed like the session's terminal. Its
 * custom editor (`chatgpt.conversationEditor`) is the panel its own
 * `chatgpt.newCodexPanel` command opens; a `openai-codex://route/local/<id>`
 * resource makes that panel resume an existing thread. Unlike Claude's UI, the
 * panel is not tied to the first workspace folder: it resumes the thread in
 * the thread's own cwd.
 */
export class CodexUiService {
  readonly extensionId = CODEX_EXTENSION_ID;

  /** Whether the Codex extension is installed. */
  isInstalled(): boolean {
    return vscode.extensions.getExtension(CODEX_EXTENSION_ID) !== undefined;
  }

  /**
   * Codex threads carry their own cwd, so any worktree can be handed to the
   * panel. Only the extension itself can be missing.
   */
  checkAvailability(_cwd: string): NativeUiAvailability {
    return this.isInstalled()
      ? { kind: 'available' }
      : { kind: 'not-installed' };
  }

  /**
   * A new Codex panel is created in the extension's workspace project, which
   * is built from the VS Code workspace folders. A thread's own cwd only
   * exists once it is resumed, so a new conversation is safe only when the
   * worktree is the sole workspace folder.
   */
  checkNewSessionAvailability(cwd: string): NativeUiAvailability {
    if (!this.isInstalled()) {
      return { kind: 'not-installed' };
    }
    return firstWorkspaceFolderAvailability(cwd, { requireSingleFolder: true });
  }

  /** Open a blank Codex conversation; the extension assigns the thread ID. */
  async openNewSession(cwd: string): Promise<NativeUiOpenResult> {
    const availability = this.checkNewSessionAvailability(cwd);
    if (availability.kind !== 'available') {
      return availability;
    }

    try {
      await vscode.commands.executeCommand('chatgpt.newCodexPanel');
      return { kind: 'opened', via: 'command' };
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
  }

  async openSession(
    sessionId: string,
    cwd: string
  ): Promise<NativeUiOpenResult> {
    const availability = this.checkAvailability(cwd);
    if (availability.kind !== 'available') {
      return availability;
    }

    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        codexConversationUri(sessionId),
        CODEX_CONVERSATION_VIEW_TYPE,
        {
          // Match the extension's own New Codex Agent command: the active
          // group is where the session's terminal was, or where the user's
          // files are. Reopening an existing panel reveals it.
          viewColumn: vscode.ViewColumn.Active,
          preserveFocus: false,
          preview: false,
        }
      );
      return { kind: 'opened', via: 'command' };
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
  }
}
