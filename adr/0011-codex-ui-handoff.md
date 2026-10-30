# 0011 — Hand an existing Codex thread to the Codex extension UI

- **Status:** Accepted
- **Superseded in part by:** [ADR 0012](0012-session-import-and-surface-choice.md) — a new session may now start in the UI; the existing-thread handoff is unchanged.
- **Date:** 2026-10-28

## Context

Agntree opens Codex chats in an editor terminal. The Codex VS Code extension
(`openai.chatgpt`) also ships a conversation UI, and the request was to offer the
same explicit handoff Agntree already has for Claude Code.

The installed extension has two surfaces:

- A sidebar webview (`chatgpt.sidebarView`, or its secondary-sidebar variant).
  Its URI handler is `vscode://openai.chatgpt/<path>`; it forwards the path to
  `navigateToRoute()`, which posts a `navigate-to-route` message to the sidebar.
  It does not create an editor tab.
- A custom editor, `chatgpt.conversationEditor`, with the selector
  `openai-codex:/**/*`. The extension's own **New Codex Agent** command
  (`chatgpt.newCodexPanel`) opens it with `vscode.openWith` and
  `viewColumn: activeTextEditor?.viewColumn ?? ViewColumn.Active`.

The custom editor is the useful handoff surface. The bundle parses resources of
the form `openai-codex://route/<path>`: when the first path segment is `local` or
`remote`, the second segment is the conversation ID. Its chat-session provider
maps a thread to the resource `openai-codex://route/local/<threadId>`
(`XGe()` builds it as `Uri.file('/local/' + id).with({scheme, authority})`).
`resolveCustomEditor()` turns such a resource into `initialRoute = '/local/<id>'`
and the webview's `/local/:conversationId` route loads that thread. Opening the
same resource again reveals the existing panel.

The panel does not need the session's worktree to be the first workspace folder.
`thread/list` is a global app-server query (it takes no cwd), and the webview's
resume path builds `workspaceRoots` from the conversation's own `thread.cwd`. A
Codex thread keeps its cwd, so the Claude first-folder constraint does not apply.

Two constraints remain:

1. **A live writer blocks the panel.** The webview's `thread/resume` retry code
   recognizes "already has an active writer" and "already has a live local
   writer" errors. A running Codex terminal owns the thread, so it must be
   stopped first, exactly as the Claude handoff does.
2. **The sidebar is not tab-addressable.** It is a webview view, not an editor
   tab, so it cannot be placed in the active group or tracked by tab focus. The
   conversation panel is the surface that can be both.

Unlike Claude's `claudeVSCodePanel` webview, a Codex conversation tab is a
`TabInputCustom` whose URI carries the exact thread ID. This makes the tracking
problem different: Claude needs an expectation and a title match, while Codex can
identify every panel directly, including panels restored after a reload or
opened from the Codex extension itself.

## Decision

Add a Codex native-UI handoff and generalize the surface tracker around native
session IDs.

- `CodexHarness` gains the optional `NativeUiCapability`: display name
  **Codex UI**, context-value suffix `CodexUi`, install detection for
  `openai.chatgpt`, and `openSession()` → `CodexUiService`.
- `CodexUiService.checkAvailability()` reports only `not-installed` or
  `available`; it does not inspect the workspace folder.
- `CodexUiService.openSession()` opens
  `openai-codex://route/local/<threadId>` with `vscode.openWith`, view type
  `chatgpt.conversationEditor`, `viewColumn: ViewColumn.Active`,
  `preserveFocus: false`, and `preview: false`. A failure is reported; there is
  no fallback that could start a new conversation.
- Contribute `agntree.openCodexUi` (**Open in Codex UI**) for Codex chat rows.
  The menu is gated on the row's `CodexUi` context token and on
  `agntree.codexUiInstalled`, which activation sets from
  `vscode.extensions.getExtension('openai.chatgpt')` and refreshes on
  `extensions.onDidChange`.
- Keep one command flow for both handoffs. `agntree.openClaudeUi` and
  `agntree.openCodexUi` call the same `openNativeUi()` implementation with the
  expected harness; a command invoked on another harness's row explains the
  mismatch. The running terminal is closed after the same confirmation and the
  command waits for its close event before opening the panel.
- Change `NativeUiSurfaceTracker` from chat IDs to **native session IDs**:
  `expect`, `cancelExpect`, and `settle` take a session ID,
  `activeSessionId()` replaces `activeChatId()`, and `isOpen()` takes a session
  ID. `NativeUiTabSurfaceService` owns the shared tab lifecycle.
  `ClaudeUiSurfaceService` is the Claude policy (webview view type, label
  matching after an expectation); `CodexUiSurfaceService` is the Codex policy
  (`TabInputCustom` + `chatgpt.conversationEditor`, session ID parsed from the
  URI).
- Resolve a session ID back to a chat in `extension.ts`, where stored chats
  live. A chat matches either its linked `harnessSessionId` or its pending ID.
  The tree, attention service, notification suppression, and active-row
  selection all use that resolution; the trackers themselves never read storage.

## Alternatives considered

- **Use the sidebar deep link (`vscode://openai.chatgpt/thread/<id>`).** It
  navigates the sidebar, not a panel. The sidebar is not an editor tab, so it has
  no exact tab identity and cannot be placed in the active group. Rejected.
- **Open a fresh panel with `chatgpt.newCodexPanel`.** That command calls
  `createNewPanel()`, which always opens `/extension/panel/new`; it starts a new
  conversation instead of revealing the existing thread. Rejected.
- **Require the worktree to be the first workspace folder.** Unnecessary: the
  panel resumes the thread in its stored cwd, and the app-server thread list is
  global. Rejected.
- **Keep the tracker keyed by chat ID and inject a storage resolver into the
  adapter.** It would make the adapter depend on stored state and would leave
  Codex tabs unmapped until an expectation. Native session identity is the
  correct key for both harnesses. Rejected.
- **Track the Codex sidebar by title.** The tab API cannot see a webview view and
  the sidebar does not expose a session ID. Deferred.
- **Create new Codex chats in the UI.** The extension assigns thread IDs, so it
  would need a claim watcher and a launch-mode setting, the same deferred work as
  the Claude UI. Out of scope.

## Consequences

- A linked Codex session can open in the Codex conversation panel in the active
  editor group. The matching row is selected and marked active while the panel
  is open; turn-state polling and notification suppression include it.
- The Codex panel is the extension's internal custom editor and URI route, not a
  documented API. A future extension version can change the view type, URI
  scheme, or path shape. The command reports an open failure instead of guessing,
  and the CLI terminal remains the fallback launch path.
- Codex panels are mapped by exact thread ID, so panels restored after a reload
  or opened from the Codex extension also select their Agntree row when the
  thread is imported. A thread with no Agntree chat is ignored.
- The Codex sidebar view is not tracked. Opening a thread there does not mark
  the row active.
- Closing the terminal stops an in-flight turn. The confirmation says so, and the
  thread is preserved.
- New Codex sessions still start in the terminal.
- Reopening an already-open panel reveals it. If it lives in another editor
  group, VS Code reveals it there rather than moving it to the active group.
- The panel uses the Codex extension's own Codex home and authentication. A
  terminal launched with a different `CODEX_HOME` can show a thread that the
  panel cannot find; the handoff does not switch Codex profiles.
- The tracker refactor changes an internal interface only. Stored chats and
  existing Claude behavior are unchanged; Claude still maps only the webview tabs
  Agntree opened because those tabs carry no session ID.

## Evidence

- Installed extension `openai.chatgpt` 26.1021.22027 (macOS) manifest and
  bundle:
  - `contributes.customEditors`: viewType `chatgpt.conversationEditor`, selector
    `openai-codex:/**/*`.
  - `contributes.chatSessions`: type `openai-codex`; its provider lists each
    thread with resource `openai-codex://route/local/<threadId>`.
  - URI parser: scheme `openai-codex`, authority `route`, conversation ID from
    the second path segment when the first is `local` or `remote`.
  - `resolveCustomEditor()`: `initialRoute` is the resource path when it starts
    with `/local/`, otherwise `/local/<conversationId>`.
  - `createNewPanel()`: `vscode.openWith` with `chatgpt.conversationEditor`,
    active column, no preview.
  - `thread/list` request: `limit`, `cursor`, `sortKey`, `modelProviders`,
    `archived`, `sourceKinds`, `useStateDbOnly`; there is no cwd parameter.
  - Webview resume: `workspaceRoots` comes from `getConversationCwd()`, and
    `thread/resume` retries recognize "active writer" / "live local writer".
- `codex-ui.test.ts` covers extension detection, the no-workspace preflight, the
  `openai-codex://route/local/<id>` resource, the conversation view type, active
  group/focus/preview options, and failures.
- `codex-ui-surface.test.ts` covers restored-tab identity, exact session mapping,
  active tab/group changes, settle and close cleanup, and ignoring other custom
  editors and webviews.
- `chat-commands.test.ts` covers the Codex command handing the thread and cwd to
  the adapter, registering and settling by session ID, selecting the row, and
  refusing a Codex session from the Claude command. `claude-ui-surface.test.ts`
  covers the refactored tracker's Claude policy. `tree.test.ts` covers the
  native-UI open provider with chat objects; `attention.test.ts` covers polling a
  UI chat without a terminal; `menus.test.ts` and the integration suite cover
  command registration and menu gating.
