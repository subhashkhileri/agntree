# 0010 — Hand an existing Claude session to the Claude Code UI

- **Status:** Accepted
- **Superseded in part by:** [ADR 0012](0012-session-import-and-surface-choice.md) — a new session may now start in the UI; the existing-session handoff is unchanged.
- **Date:** 2026-10-27
- **Related:** [0011](0011-codex-ui-handoff.md) generalizes the surface tracker from
  chats to native session IDs; the Claude decision here is unchanged.

## Context

Agntree opens every chat in an editor terminal through the harness adapter. Claude
Code also ships a VS Code extension with a native chat surface, and the extension
already has a terminal mode and a UI mode. The request was to make the UI available
from Agntree, following whatever surface the extension is configured to use.

The extension exposes two relevant surfaces:

- The documented URI `vscode://anthropic.claude-code/open?session=<id>&prompt=<text>`.
  Its handler calls `claude-vscode.primaryEditor.open`, which always opens a full
  editor and ignores `claudeCode.preferredLocation`.
- The command `claude-vscode.editor.open(sessionId, prompt, viewColumn, groupId,
  fullEditor, options)`. Passing `{ programmatic: 'honor-preferred-location' }`
  selects the sidebar when `claudeCode.preferredLocation` is `sidebar` and a panel
  otherwise. This command is not documented, but it is the extension's own command
  and its signature was read from the installed bundle.

Three constraints make this a handoff rather than a second launch path.

1. **The UI runs in the first workspace folder.** The extension's panel setup uses
   `workspaceFolders[0]` (falling back to the home directory). The documentation
   says the session must belong to the workspace currently open. A synthetic
   cross-cwd resume loaded the history but recorded new work under the launch cwd.
   Agntree chats can belong to any worktree, and `agntree.autoSwitchWorkspaceFolder`
   is off by default, so the session's worktree is often not that first folder.
2. **The extension assigns the session ID for a new UI chat.** Agntree's Claude
   linkage chooses the ID before launch (`--session-id`) and links that exact
   transcript. The extension offers no way to supply that ID, so a UI-created chat
   would need a claim watcher and a different linkage rule.
3. **The UI tab exposes no session ID.** VS Code can report when a webview tab
   opens, changes, or closes, but the Claude tab's input is only
   `viewType: claudeVSCodePanel`, and its label is the session title. Agntree can
   map a tab only after a handoff it initiated; it cannot discover arbitrary Claude
   tabs. The tab tells us that the surface is open or active, not the session's
   turn state.

The extension also has a placement default that is easy to miss. When
`claude-vscode.editor.open` receives no `viewColumn`, `createPanel()` calls
`startClaudeGroup()`, which runs `workbench.action.newGroupRight` (or
`newGroupBelow` when `workbench.editor.openSideBySideDirection` is `down`) and then,
with `claudeCode.lockEditorGroups` on, locks the new group. The first handoff
therefore appeared in a separate right-hand group, not where the terminal or the
user's files were. Passing `ViewColumn.Active` reuses the active editor group
instead of creating one.

The profile problem that originally made the UI look different is separate and
already resolved: EnMaaS now lives in the shared `~/.claude/settings.json`, which
both the terminal CLI and the extension's bundled CLI read. The UI still has one
global profile; per-chat profiles remain a terminal-only feature.

## Decision

Ship a narrow, explicit handoff for an **existing** Claude session:

- Add an optional `NativeUiCapability` to `HarnessAdapter`, with `openSession()`
  on the capability. `ClaudeHarness` implements it with `ClaudeUiService`;
  commands and providers stay harness-agnostic.
- Contribute `agntree.openClaudeUi` (**Open in Claude Code UI**) for Claude chat
  rows. The row's context value gets a `ClaudeUi` suffix from the adapter, and the
  menu is gated on `agntree.claudeUiInstalled`, which activation sets from
  `vscode.extensions.getExtension('anthropic.claude-code')` and refreshes on
  `extensions.onDidChange`.
- Require a resumable native session. A new chat, a fork before its first prompt,
  or a missing transcript stays in the terminal; the extension would otherwise
  start a fresh conversation with no row linking back to it.
- Require `canonicalPath(workspaceFolders[0])` to equal `canonicalPath(worktree)`.
  On a mismatch, explain both paths and offer to open the worktree in a new window;
  do not silently resume in the wrong folder.
- Preflight the extension and the first-folder match before touching a running
  terminal. If the session has a live terminal, ask first, dispose it, and wait for
  its close event before opening the UI. The confirmation says the running process
  stops and the conversation is preserved. `openSession()` checks the folder
  again after the close, so a folder change in between cannot open the wrong tree.
- Register the expected Claude tab before opening. `ClaudeUiSurfaceService` binds
  the next Claude webview tab (or the active one after the command resolves) to the
  chat and watches `tabGroups.onDidChangeTabs` / `onDidChangeTabGroups`. The mapping
  is in-memory and only covers tabs from Agntree's own handoff.
- Treat a mapped native-UI tab as an open chat. The tree uses `isOpen()` for the
  active mark, and the attention service polls UI chats alongside
  terminal chats. Editor-tab focus selects the matching chat: a terminal tab
  resolves through `activeTerminal` or its title, and a Claude tab resolves through
  the tracker. The title fallback covers returning from a Claude tab to a CLI
  terminal tab when `activeTerminal` did not change.
- Prefer `claude-vscode.editor.open` with `ViewColumn.Active` and
  `{ programmatic: 'honor-preferred-location' }`. The active group is where the
  session's terminal was, or where the user's files are; it also avoids the
  extension's new-right-group-and-lock path. If the command is not registered,
  fall back to the documented URI. If the command is registered but fails, report
  the error instead of falling back, because the URI starts a fresh conversation
  when the session is not found.
- Do not emulate a terminal or persist a second open-state field. The tracker's
  `isOpen()` is the only native-UI open signal; when its tab closes, the row
  returns to the terminal-derived state.

## Alternatives considered

- **Use only the documented URI.** Simpler and uses the supported surface, but it
  always opens a full editor and ignores `claudeCode.preferredLocation`. The
  command plus URI fallback keeps the extension's configured surface and still has
  a documented path for older builds.
- **Switch the workspace folder, then open.** Correct for any worktree, but
  `updateWorkspaceFolders()` restarts the extension host. The pending intent would
  have to be persisted and replayed after activation; that is a separate flow.
- **Create new chats in the UI.** Requires a claim watcher, a launch-mode setting,
  storage migration, and a change to the exact-ID linkage rule. Deferred.
- **Track every UI surface.** The tab API is enough for tabs Agntree opened, but
  the tab does not carry the session ID. Discovering arbitrary or restored Claude
  tabs would need title matching or an extension API that does not exist today.
  Deferred.

## Consequences

- The action is hidden when the Claude Code extension is not installed. The command
  still reports a clear message if invoked from the palette.
- The handoff succeeds only when the session's worktree is the first workspace
  folder. A user who keeps several worktrees open in one window will use **Open in
  New Window** for the rest.
- The UI opens in the active editor group. If the session is already open in an
  older right-hand panel or in the sidebar, the extension reveals that surface
  instead of moving it; close that tab once to get the new placement.
- The matching row is selected and shown as active while the UI tab is open.
  Turn-state polling includes UI chats, so the row can animate while Claude works.
  Notifications are suppressed while that UI tab is the active editor tab.
- Only tabs Agntree opened are mapped. A tab restored after a reload or opened
  directly from the Claude extension does not select the row or mark it active
  until the chat is handed off through Agntree again.
- New sessions and unprompted forks still launch in the terminal. This is a UI
  handoff, not a replacement launch mode.
- The Claude UI uses one profile. A chat cannot switch between EnMaaS and the old
  Vertex profile inside the UI.
- The preferred-location command is internal to the extension. A future extension
  version can change it; the documented URI remains the fallback, and the handoff
  reports a command failure rather than guessing.
- Closing the terminal stops an in-flight turn. The confirmation states that, and
  the session transcript is preserved.

## Evidence

- Claude Code extension 2.1.311 and 2.1.312 (macOS) manifest and bundle: the URI
  handler calls `claude-vscode.primaryEditor.open`; the
  `claude-vscode.editor.open` handler is
  `(sessionId, prompt, viewColumn, groupId, fullEditor, options)`; the open-surface
  selector maps `{ programmatic: 'honor-preferred-location' }` plus a `sidebar`
  preference to the sidebar and everything else to a panel; panel setup reads
  `workspaceFolders[0]`. `createPanel()` uses the supplied `viewColumn`; without
  one, `startClaudeGroup()` creates a new group to the right (or below), and the
  handler calls `workbench.action.lockEditorGroup` when
  `claudeCode.lockEditorGroups` is on.
- The VS Code extension documentation states that `session` must belong to the
  workspace currently open and that a missing session starts a fresh conversation.
- A synthetic resume probe with a throwaway `CLAUDE_CONFIG_DIR` accepted a
  cross-cwd `--resume` and recorded the new turn under the launch cwd, which is why
  the worktree/first-folder guard is exact rather than a warning.
- `claude-ui.test.ts` covers extension detection, the preflight and empty-window
  and worktree-mismatch paths, the preferred-location command, the URI fallback with
  an encoded ID, and command/URI failures. `chat-commands.test.ts` covers the
  preflight refusing a mismatch without closing a running terminal, the terminal
  close confirmation, waiting for the close event, binding the tab, selecting the
  row, and refusing an unstarted chat. `claude-ui-surface.test.ts` covers expectation
  binding, open state, title preference, active tab/group transitions, settle and
  cancel, close cleanup, and ignoring non-Claude tabs. `tree.test.ts` covers the
  active mark for a native-UI-open row; `attention.test.ts` covers polling a UI chat
  without a terminal; `terminal.test.ts` covers resolving a chat by terminal title.
- The EnMaaS migration was verified separately for a login-shell `claude` and its
  `apiKeyHelper`. The extension's bundled CLI reads the same shared settings, so the
  terminal and UI no longer depend on a shell wrapper for the profile.

## Deferred work

A later phase can add a launch mode (`terminal`, `extension-ui`, or follow the
extension's own setting) for new chats and a claim watcher for UI-created sessions.
Tabs opened directly in the extension or restored after a reload remain unmapped,
and the notification **Open** action still reveals the row rather than focusing the
UI tab. Those changes alter session identity and stored state, so they need their own
ADR rather than extending this handoff.
