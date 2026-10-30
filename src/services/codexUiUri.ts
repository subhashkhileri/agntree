import * as vscode from 'vscode';

/** The extension that owns the Codex chat UI. */
export const CODEX_EXTENSION_ID = 'openai.chatgpt';

/** The custom editor the extension registers for a conversation panel. */
export const CODEX_CONVERSATION_VIEW_TYPE = 'chatgpt.conversationEditor';

const CODEX_URI_SCHEME = 'openai-codex';
const CODEX_URI_AUTHORITY = 'route';

/**
 * The resource the Codex extension uses for a local conversation. This is the
 * URI its own `createNewPanel()` opens with `vscode.openWith`, and the one its
 * chat-session provider lists, so opening it is the same operation the
 * extension performs itself.
 */
export function codexConversationUri(sessionId: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: CODEX_URI_SCHEME,
    authority: CODEX_URI_AUTHORITY,
    path: `/local/${sessionId}`,
    query: '',
  });
}

/** Read the thread ID from a Codex conversation resource, if it has one. */
export function codexSessionIdFromUri(
  uri: vscode.Uri
): string | undefined {
  if (uri.scheme !== CODEX_URI_SCHEME || uri.authority !== CODEX_URI_AUTHORITY) {
    return undefined;
  }
  const segments = uri.path.split('/').filter(Boolean);
  if (segments.length < 2) {
    return undefined;
  }
  const [scope, sessionId] = segments;
  if ((scope !== 'local' && scope !== 'remote') || !sessionId) {
    return undefined;
  }
  return sessionId;
}

/** Whether this tab is a Codex conversation panel, and which thread it shows. */
export function codexSessionIdForTab(tab: vscode.Tab): string | undefined {
  const input = tab.input;
  if (
    !(input instanceof vscode.TabInputCustom) ||
    input.viewType !== CODEX_CONVERSATION_VIEW_TYPE
  ) {
    return undefined;
  }
  return codexSessionIdFromUri(input.uri);
}
