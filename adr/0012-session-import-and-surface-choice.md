# 0012 — Import native sessions, name them from the harness, and let the user choose the surface

- **Status:** Accepted
- **Date:** 2026-10-29

## Context

The Claude Code and Codex extensions both offer a chat UI beside their CLIs. Agntree
already had an explicit handoff for an **existing** session (ADR 0010 and ADR 0011), but
three requests remained:

1. Start a **new** session in the UI from a worktree row.
2. Let a user choose the default surface for row clicks and new sessions, with explicit
   overrides on the row.
3. Show sessions started outside Agntree in the tree, named the way the agent names them,
   without keeping an ever-growing list.

The first request is constrained by what the extensions expose:

- **Claude Code (extension 2.1.312).** `claude-vscode.editor.open` accepts a session ID,
  but `resolveSession` only finds an existing transcript. Passing a fresh UUID falls
  through to `createSession()`, which mints a different ID. A new conversation runs in the
  first VS Code workspace folder and writes no resumable transcript until the first
  prompt. The agent records its display name as `ai-title` entries in the transcript; the
  first user prompt is only a fallback.
- **Codex (extension 26.1021.22027, CLI 0.165.0).** `chatgpt.newCodexPanel` opens the
  `/extension/panel/new` resource. Its workspace project comes from the VS Code workspace
  folders; there is no per-panel cwd argument. A real app-server probe showed that
  `thread/start` with a cwd returns an ID and `thread/read` works while that server is
  alive, but after a restart `thread/read` fails with `no rollout found`, `thread/list`
  omits the thread until the first message, and there is no session to resume. The
  extension writes the thread name that `/status` calls **Thread name**.

Neither extension can adopt an Agntree-chosen session ID for a new conversation. Anything
that offers "new session in the UI" must therefore create the row first and discover the
real native session after the first prompt. That is a deliberate trade: the row exists
immediately, but its native identity is claimed later.

The existing watchers remain the right mechanism for a session Agntree launches. Claude
knows the chosen ID up front, and Codex/opencode can claim the oldest new session in the
worktree because the terminal launch is the only thing that just happened there.

## Decision

Add a session importer alongside the watchers rather than replacing them, and make the
surface a capability with an explicit default.

- **`SessionImportService` owns the cases no watcher owns.**
  - A chat started in an agent's UI carries `pendingUiLaunch` and no native ID. The
    command snapshots the worktree's sessions **before** opening the conversation; the
    importer links the first session that appears afterwards. The snapshot is what
    prevents an older session in the same worktree from being claimed.
  - Recent native sessions with no Agntree chat are imported as `autoImported` chats.
  - A session an unlinked CLI placeholder is about to claim is reserved for that
    placeholder's watcher, so the importer cannot create a duplicate first.
  - Linked chats whose name is still automatic follow `HarnessSession.summary`
    (`ai-title` for Claude, thread name for Codex, title for opencode). Claude's
    `ClaudeSessionService` now parses `ai-title`; the first prompt remains a fallback.
    The user's rename sets `customName`, which stops automatic renames.
- **Retention is policy, not deletion.** Every row, whether Agntree started it or the
  importer created it, is removed from the tree after `agntree.autoImport.retentionDays`
  (default 7) quiet days, based on the later of the native session's last activity and the
  chat's `lastAccessedAt`. A star is the only user-controlled exemption; an open terminal
  or native-UI tab is also kept. The native session is never touched, and retention is not
  a tombstone, so a session that becomes active again can return. A user removal is
  tombstoned so the next scan cannot resurrect it; a manual import clears the tombstone
  and starts a fresh retention window.
- **One surface capability.** `NativeUiCapability` gains `extensionId`,
  `checkNewSessionAvailability()`, and `openNewSession()`. Availability is stricter for a
  new session than for an existing one: Claude uses its first folder, while Codex requires
  the worktree to be the only workspace folder.
- **The default is a preference with a safe fallback.** `agntree.defaultSessionSurface`
  (`terminal` or `ui`, default `terminal`) decides what a row click and the default New
  Session command prefer. If the UI cannot open that session or worktree, the row click
  and the default command fall back to the terminal. The explicit UI commands explain the
  reason instead and do not start a CLI.
- **The row can override the default.** The hover row gains **Open Session in Terminal**
  and, for Claude/Codex rows whose extension is installed, the UI action. The context
  menu always shows the UI action, even when the extension is missing, and the
  explanation offers **Find Extension**. Switching an open UI session back to a terminal
  asks before closing its tab, so two agent processes never share a session.

## Alternatives considered

- **Pass a chosen ID to a new UI conversation.** Rejected: Claude ignores an unknown ID
  and creates its own; Codex has no equivalent. A transcript cannot be written by Agntree
  without reading or faking the agent's private storage.
- **Pre-create a Codex thread with `thread/start` and open it in the panel.** Rejected:
  the empty thread is not resumable after the creating app-server exits; the panel would
  have no rollout.
- **Replace every watcher with the importer.** Rejected for this change: exact-ID
  linkage is cheaper and more precise for a session Agntree launches, and removing the
  watcher subsystem would also touch terminal restore, attention, and their tests. The
  importer is deliberately additive; the watchers can be folded in later if the importer
  proves sufficient.
- **Importer creates the chat only after the session appears.** Rejected: the user asked
  for an immediate placeholder row, and it matches how a new terminal chat behaves.
  The cost is that the identity is claimed later; the snapshot and reservation rules keep
  that claim bounded.
- **Delete every existing row in one migration and let auto-import rebuild the tree.**
  Rejected: it would drop recent chats, stars, user names, and manual imports at once.
  Retention reaches the same end gradually, keeps stars, and never removes a row that is
  still active.

## Consequences

- A new UI session is usable only when the extension's own working folder matches the
  worktree. Claude uses the first workspace folder; Codex uses the single-folder
  workspace. Other worktrees explain the limitation and offer a new window; the terminal
  start remains available.
- The placeholder shows `new` until the first prompt creates the native session. If the
  placeholder is opened in a terminal first, the importer expectation is canceled and the
  terminal's own watcher takes over.
- The importer scans every 3 seconds while a UI placeholder is in its first five minutes,
  then every 2 minutes while auto-import is enabled, and stops when auto-import is off and
  no placeholder is waiting. The scan is asynchronous and never runs on the tree render
  path.
- A user-removed session stays out of auto-import for 90 days or until a manual import.
  Chats removed by retention are not tombstoned, so a session that becomes active again —
  or a manual import — can bring one back.
- Claude's `ai-title` is the authoritative name. If a transcript has no title yet, the
  existing summary and first-prompt fallbacks still apply.

## Evidence

- The Claude extension bundle's `resolveSession()` and `activateSessionFromServer()`
  create a new session with a different ID when an unknown session is requested.
- The Codex extension's `createNewPanel()` calls
  `vscode.openWith(F1('/extension/panel/new'), ...)`; `getWorkspaceProject()` builds the
  workspace project from `workspace.workspaceFolders`.
- A probe against `codex app-server` with a throwaway `CODEX_HOME` returned a thread ID
  from `thread/start`, read it while the server lived, and then failed after restart with
  `no rollout found`; `thread/list` returned zero rows until a message existed.
- The Claude transcript for the user's example session contains repeated
  `{"type":"ai-title","aiTitle":"Codex integration"}` entries.

## References

- [ADR 0010](0010-claude-ui-handoff.md)
- [ADR 0011](0011-codex-ui-handoff.md)
- [`ARCHITECTURE.md`](../ARCHITECTURE.md#session-import-naming-and-retention)
