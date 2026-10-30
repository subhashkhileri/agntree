import * as vscode from 'vscode';
import {
  NativeUiAvailability,
  NativeUiOpenResult,
} from '../harnesses/types';
import { errorMessage } from '../utils/text';
import { firstWorkspaceFolderAvailability } from './nativeUiWorkspace';

/** The extension that owns the Claude Code chat UI. */
const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';

/** The extension's command that opens a session in its UI. */
const CLAUDE_UI_COMMAND = 'claude-vscode.editor.open';

/** The documented URI handler, used when the command is unavailable. */
const CLAUDE_UI_URI = 'vscode://anthropic.claude-code/open';

/**
 * Hands an existing Claude Code session to the Claude Code extension's UI.
 *
 * The extension runs its UI in the first workspace folder, not in the
 * session's cwd, so this service refuses to open a session from another
 * worktree. The command is preferred because it honors
 * `claudeCode.preferredLocation`; the documented URI is the fallback when the
 * command is not registered (older extension builds).
 */
export class ClaudeUiService {
  readonly extensionId = CLAUDE_EXTENSION_ID;

  /** Whether the Claude Code extension is installed. */
  isInstalled(): boolean {
    return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined;
  }

  /**
   * Whether the extension can open a session in `cwd`. The extension UI runs
   * in the first workspace folder, so any other cwd would start work in the
   * wrong place.
   */
  checkAvailability(cwd: string): NativeUiAvailability {
    if (!this.isInstalled()) {
      return { kind: 'not-installed' };
    }
    return firstWorkspaceFolderAvailability(cwd);
  }

  /**
   * A new conversation is created in the same first workspace folder as an
   * existing session, so the check is identical.
   */
  checkNewSessionAvailability(cwd: string): NativeUiAvailability {
    return this.checkAvailability(cwd);
  }

  /**
   * Open a session in the extension's UI. `cwd` must be the worktree the
   * session belongs to; the extension cannot be given a different cwd.
   */
  openSession(
    sessionId: string,
    cwd: string
  ): Promise<NativeUiOpenResult> {
    return this.open(cwd, sessionId);
  }

  /** Open a brand-new conversation; the extension assigns its session ID. */
  openNewSession(cwd: string): Promise<NativeUiOpenResult> {
    return this.open(cwd);
  }

  private async open(
    cwd: string,
    sessionId?: string
  ): Promise<NativeUiOpenResult> {
    const availability = sessionId
      ? this.checkAvailability(cwd)
      : this.checkNewSessionAvailability(cwd);
    if (availability.kind !== 'available') {
      return availability;
    }

    const commands = await vscode.commands.getCommands(true);
    if (commands.includes(CLAUDE_UI_COMMAND)) {
      try {
        await vscode.commands.executeCommand(
          CLAUDE_UI_COMMAND,
          sessionId,
          undefined,
          // Without a column the extension creates a new editor group on the
          // right and may lock it. The active group is where the session's
          // terminal was, or where the user's files are.
          vscode.ViewColumn.Active,
          undefined,
          undefined,
          { programmatic: 'honor-preferred-location' }
        );
        return { kind: 'opened', via: 'command' };
      } catch (error) {
        return { kind: 'failed', message: errorMessage(error) };
      }
    }

    try {
      const uri = sessionId
        ? `${CLAUDE_UI_URI}?session=${encodeURIComponent(sessionId)}`
        : CLAUDE_UI_URI;
      const opened = await vscode.env.openExternal(vscode.Uri.parse(uri));
      return opened
        ? { kind: 'opened', via: 'uri' }
        : {
            kind: 'failed',
            message: 'VS Code did not open the Claude Code UI.',
          };
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
  }
}
