import * as vscode from 'vscode';
import {
  NativeUiTabSurfaceOptions,
  NativeUiTabSurfaceService,
} from './NativeUiTabSurfaceService';
import { codexSessionIdForTab } from './codexUiUri';

export type CodexUiSurfaceServiceOptions = Omit<
  Partial<NativeUiTabSurfaceOptions>,
  'matchByLabel'
>;

/**
 * Tracks Codex conversation panels by their thread ID.
 *
 * The custom editor resource is `openai-codex://route/local/<threadId>`, so a
 * tab identifies its session exactly. That also maps panels opened directly
 * from the Codex extension or restored after a reload; a thread that is not in
 * Agntree simply has no chat to select.
 */
export class CodexUiSurfaceService extends NativeUiTabSurfaceService {
  constructor(options: CodexUiSurfaceServiceOptions = {}) {
    super({
      ...options,
      isUiTab:
        options.isUiTab ??
        ((tab) => codexSessionIdForTab(tab) !== undefined),
      sessionIdForTab: options.sessionIdForTab ?? codexSessionIdForTab,
      matchByLabel: false,
    });
  }
}
