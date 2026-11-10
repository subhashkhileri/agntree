import * as vscode from 'vscode';
import { NativeUiAvailability, NativeUiCapability, NativeUiOpenResult } from './types';
import { attemptOpen, firstWorkspaceFolderAvailability } from './nativeUiWorkspace';
import { NativeUiTabSurfaceOptions, NativeUiTabSurfaceService } from '../services/NativeUiTabSurfaceService';
import { errorMessage } from '../utils/text';

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
/** The extension's command that opens a session in its UI. */
const CLAUDE_UI_COMMAND = 'claude-vscode.editor.open';
/** The documented URI handler, used when the command is unavailable. */
const CLAUDE_UI_URI = 'vscode://anthropic.claude-code/open';
/** The webview view type the extension registers for its tabs. */
const CLAUDE_TAB_VIEW_TYPE = 'claudeVSCodePanel';

/**
 * Claude Code tabs carry the session title, not its ID, so a tab binds
 * through an expectation registered before a handoff (ADR 0010).
 */
export function claudeUiSurfaces(
  options: Omit<Partial<NativeUiTabSurfaceOptions>, 'matchByLabel'> = {}
): NativeUiTabSurfaceService {
  return new NativeUiTabSurfaceService({
    ...options,
    isUiTab:
      options.isUiTab ??
      ((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.includes(CLAUDE_TAB_VIEW_TYPE)),
    matchByLabel: true,
  });
}

/**
 * The Claude Code extension's UI. It runs in the first workspace folder, not
 * in the session's cwd, so a session from another worktree is refused. The
 * extension's command is preferred because it honors
 * `claudeCode.preferredLocation`; the documented URI is the fallback for
 * builds without it.
 */
export class ClaudeUi implements NativeUiCapability {
  readonly displayName = 'Claude Code UI';
  readonly contextValueSuffix = 'ClaudeUi';
  readonly extensionId = CLAUDE_EXTENSION_ID;
  readonly surfaces = claudeUiSurfaces();

  isInstalled(): boolean {
    return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID) !== undefined;
  }

  checkAvailability(cwd: string): NativeUiAvailability {
    return this.isInstalled() ? firstWorkspaceFolderAvailability(cwd) : { kind: 'not-installed' };
  }

  /** A new conversation also runs in the first workspace folder. */
  checkNewSessionAvailability(cwd: string): NativeUiAvailability {
    return this.checkAvailability(cwd);
  }

  openSession(sessionId: string, cwd: string): Promise<NativeUiOpenResult> {
    return this.open(cwd, sessionId);
  }

  openNewSession(cwd: string): Promise<NativeUiOpenResult> {
    return this.open(cwd);
  }

  private async open(cwd: string, sessionId?: string): Promise<NativeUiOpenResult> {
    const availability = this.checkAvailability(cwd);
    if (availability.kind !== 'available') {
      return availability;
    }

    if ((await vscode.commands.getCommands(true)).includes(CLAUDE_UI_COMMAND)) {
      return attemptOpen(() =>
        vscode.commands.executeCommand(
          CLAUDE_UI_COMMAND,
          sessionId,
          undefined,
          // Without a column the extension opens a new group on the right and
          // may lock it. The active group is where the session's terminal
          // was, or where the user's files are.
          vscode.ViewColumn.Active,
          undefined,
          undefined,
          { programmatic: 'honor-preferred-location' }
        )
      );
    }

    try {
      const uri = sessionId ? `${CLAUDE_UI_URI}?session=${encodeURIComponent(sessionId)}` : CLAUDE_UI_URI;
      return (await vscode.env.openExternal(vscode.Uri.parse(uri)))
        ? { kind: 'opened', via: 'uri' }
        : { kind: 'failed', message: 'VS Code did not open the Claude Code UI.' };
    } catch (error) {
      return { kind: 'failed', message: errorMessage(error) };
    }
  }
}
