import * as vscode from 'vscode';
import {
  NativeUiTabSurfaceOptions,
  NativeUiTabSurfaceService,
} from './NativeUiTabSurfaceService';

/** The webview view type the Claude Code extension registers. */
const CLAUDE_TAB_VIEW_TYPE = 'claudeVSCodePanel';

/**
 * Tracks Claude Code webview tabs by session ID.
 *
 * The tab carries the session title, not the session ID, so tabs cannot be
 * discovered from their URI. The handoff registers an expectation, and the
 * next Claude tab (or the active one after the command resolves) is bound to
 * that session. Focus changes then select the matching row.
 */
export type ClaudeUiSurfaceServiceOptions = Omit<
  Partial<NativeUiTabSurfaceOptions>,
  'matchByLabel'
>;

export class ClaudeUiSurfaceService extends NativeUiTabSurfaceService {
  constructor(options: ClaudeUiSurfaceServiceOptions = {}) {
    super({
      ...options,
      isUiTab:
        options.isUiTab ??
        ((tab) =>
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.includes(CLAUDE_TAB_VIEW_TYPE)),
      matchByLabel: true,
    });
  }
}
