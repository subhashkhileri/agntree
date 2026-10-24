# Agntree architecture

This is the deep reference for how Agntree is put together. Read [`AGENTS.md`](AGENTS.md)
first for the working agreement — where a change belongs, what to investigate before
coding, testing doctrine, and the definition of done. Build and verification commands live
there too.

## Subsystem map

This is a VS Code extension that manages CLI coding-agent sessions (Claude Code,
opencode, and Codex) across git repositories and worktrees. Harness-specific behavior
lives behind the adapter seam in `src/harnesses/`.

### Harness Adapters (`src/harnesses/`)

- **types.ts** - `HarnessId`, `HarnessAdapter`, `HarnessSession`, `SessionMetadata`, capabilities
- **HarnessRegistry** - installed detection (cached) and lookup
- **ClaudeHarness** - wraps `ClaudeSessionService`; forking defers to `claude --fork-session`
- **OpencodeHarness** - wraps `OpencodeSessionService`; native API fork + move
- **CodexHarness** - wraps `CodexAppServer` and `CodexRollout`; `thread/fork` returns a
  linked thread, live turn state comes from the rollout file

`ChatSession.harness` selects the adapter everywhere (terminals, tree rows, watchers).
Adding a new agent means implementing `HarnessAdapter` and registering it in
`extension.ts`; do not add harness conditionals to commands or providers.

### Harness icons

Session rows use custom SVGs from `resources/icons/harness/`, named
`<harness>-<theme>-<state>.svg` where state is `working`, `done`, `closed`, or `new`.
`working` is the whole brand mark beating like a heartbeat (no badge — motion is the
signal, and it is the only thing that reads at 16px), `done` adds the green dot, `closed`
is the grey mark, and `new` adds a hollow ring. `selectHarnessIconState()` in
`harnesses/sessionUtils.ts` maps a chat plus its live turn state (from
`SessionAttentionService.getTurnState()`) to a state; the attention service triggers a
`softRefresh()` when a turn starts or ends. Adapters expose the files through
`HarnessAdapter.treeIcons`; adapters without custom art fall back to state codicons.
Icons are generated from the base marks in `resources/icons/harness/base/` by
`npm run generate:icons` — edit the base marks and regenerate rather than editing the
generated files. The working animation uses CSS inside the SVG (`transform-box:
view-box`), which Chromium plays in tree-icon `background-image`; honor
`prefers-reduced-motion`.

### Core Services (`src/services/`)

- **StorageService** - Persists repositories and sessions to VS Code's globalState; migrates legacy `claudeSessionId` records
- **GitService** - Git operations: worktree listing/creation/deletion, branch merging, commit tracking, diff generation, PR fetching via `gh` CLI
- **TerminalManager** - Opens terminals through the chat's adapter (`buildLaunchCommand`, resumability check, icon)
- **ClaudeSessionService** - Discovers Claude Code sessions from `~/.claude/projects/`, copies sessions between worktrees for forking, repository-wide session search via `findSessionsForRepository()`
- **OpencodeSessionService** - Talks to opencode v2 via its CLI (`opencode api session.*`, `opencode session export`), never its SQLite database
- **CodexAppServer** - Lazy, private `codex app-server --listen stdio://` JSON-RPC client with request matching, timeouts, restart on exit, and idle shutdown
- **CodexRollout** - Incremental reader for `~/.codex/sessions/**/*.jsonl`; supplies live turn state, token usage, and message counts for TUI-owned threads
- **OperationLog** - Append-only audit trail (`Agntree Operations` output channel) for destructive file and worktree operations
- **SessionAttentionService** - Polls chats with open terminals (~4s) and tails `~/.agntree/attention.jsonl`; notifies on a finished turn or a Claude permission/idle prompt. Reads only `HarnessSession.turnState` / `turnEndedAt`, so it stays harness-agnostic
- **NotificationService** - Delivers the VS Code notification (with an Open action) and, on macOS while the window is unfocused, an `osascript` banner. Skips the session you are already typing in
- **ClaudeAttentionHooks** - Pure merge/remove of the optional `Stop` + `Notification` hooks in `~/.claude/settings.json`, with a one-time `.agntree-backup`; refuses to touch invalid JSON. The log path and hook command are defined once in `attentionLog.ts`, which the attention service also imports
- **PendingSessionWatcher** - Shared polling loop for harnesses whose native session ID is assigned in a separate process: snapshot, claim the oldest unseen session, TTL, and auto-naming. Subclasses supply the harness and naming hooks
- **ClaudeSessionWatcher** / **OpencodeSessionWatcher** / **CodexSessionWatcher** - Link newly created native sessions to pending chats and auto-name them. The opencode and Codex watchers extend `PendingSessionWatcher`; Claude watches JSONL files directly
- **HarnessWatcherRegistry** - Dispatches pending-chat registration and name events by `chat.harness`

### Tree Providers (`src/providers/`)

- **WorkspacesTreeProvider** - Main sidebar tree: Repository → Worktree → Session hierarchy. Quiet by design: session rows show only a short relative time (`16m`, `2h`, `3d`) or `new`, a star, and the harness mark; the tooltip carries the session brief (recap or last exchange, then message count/model/agent/tokens/cost). Repository icons are neutral; worktree color marks state only — amber for the open workspace, blue for a PR checkout, green for the main worktree, neutral otherwise. Worktrees show `↑n`/`↓n` ahead/behind from `GitService.getAheadBehind()` (15s cache).
- **ChangesTreeProvider** - Shows staged/unstaged git changes for the active worktree. Section headers use a green check (staged) or yellow edit icon plus `n files · +a -d`; nested rows show their directory (`src/utils · M +2 -1`) because the list is flat; rows sort by status then path.
- **FilesTreeProvider** - All Files browser for the active worktree. Directories sort first, names sort naturally, rows tooltip their worktree-relative path, and an unselected panel returns a placeholder row.

### Commands (`src/commands/`)

Commands are registered in `package.json` under `contributes.commands` and implemented in:
- `repository.ts` - Add/remove/clone repositories
- `worktree.ts` - Create/delete worktrees, merge branches, open in new window, checkout PRs
- `chat.ts` - Create/open/rename/delete/fork sessions, import existing sessions, search sessions across all worktrees

### Data Flow

1. User adds a repository → stored in globalState
2. GitService detects worktrees via `git worktree list --porcelain`
3. User runs "New Claude Code Session", "New opencode Session", or "New Codex Session" → `createSession()` creates a chat with that harness, registers it with the matching watcher, and opens a terminal (`claude`, `opencode`, or `codex`)
4. The watcher links the chat to the native session ID when the harness creates it
5. Resume, fork, and previews dispatch through `registry.get(chat.harness)`

Forks are named with numeric suffixes by `nextForkName()` in `src/utils/text.ts`:
forking `Fix icons` creates `Fix icons (1)`, and forking that creates
`Fix icons (1) (1)`; sibling forks increment until the name is unique in the target
worktree. There is no `Fork of …` prefix.

### Key Types (`src/types.ts`)

- `Repository` - Git repo with name and root path
- `Worktree` - Branch checked out in a directory
- `ChatSession` - `harness` + `harnessSessionId` for resume/fork in the owning harness

## Claude Code Sessions

Sessions are stored in `~/.claude/projects/<encoded-path>/*.jsonl`. The `ClaudeSessionService` parses these files to extract session IDs, summaries, and timestamps for import into the extension.

### Path Encoding

Claude Code encodes directory paths by replacing `/`, `\`, and `.` with `-`. For example:
- `/Users/dev/my-project` → `-Users-dev-my-project`

The `ClaudeSessionService.encodeProjectPath()` method handles this encoding when copying sessions between worktrees.

### Session Forking

When forking a session to a new worktree, the extension copies the entire project directory from `~/.claude/projects/<source>` to `~/.claude/projects/<dest>`. This preserves conversation history so Claude can resume from the forked point.

## opencode Sessions

opencode v2 stores sessions in `~/.local/share/opencode/opencode.db` (SQLite). **Never read that database directly.** `OpencodeSessionService` goes through the CLI:

- Discovery: `opencode api session.list --param limit=… [--param directory=…]` (paginated; filter out `parentID` children)
- Lookup / resume check: `opencode api session.get --param sessionID=<id>`
- Fork: `opencode api session.fork --param sessionID=<id> --data '{}'` → new top-level `ses_…` ID
- Move: `opencode api session.move --param sessionID=<id> --data '{"directory":"<abs path>"}'`
- Previews: `opencode session export <id>`, parsed for user messages; cached in-memory (LRU, 5 min)
- Resume in terminal: `opencode --session <id>`; new session: `opencode`

`opencode session export` truncates large JSON when stdout is a pipe. `execToFile()` works around this by redirecting stdout to a temp file before parsing. Keep list pages small for the same reason.

Forking to a new worktree uses the native fork + move path (`prepareForkToNewWorktree()`); on a move failure the orphan fork is deleted best-effort. There is no recap for opencode; `capabilities.recap` is false.

`OpencodeSessionWatcher` polls `session.list` (bypassing the cache) every 3s while chats are pending, claims the oldest new top-level session in the worktree, links it, and renames the chat from the title (falling back to the first prompt after 30s). It gives up after 5 minutes. The poll/claim/TTL rules live in `PendingSessionWatcher`, which the Codex watcher shares.

The opencode command is configurable via `agntree.harnessCommands.opencode` (default `opencode`). Prefer `opencode api …` over the TUI/`--fork` flags; `--fork` exists only on `opencode run`, not the TUI.

## Codex Sessions

Codex threads are discovered through the Codex app-server; never read its state database
directly. `CodexAppServer` starts a private `codex app-server --listen stdio://` lazily,
performs one `initialize` + `initialized` handshake, and stops it after an idle period.
The transport is newline-delimited JSON-RPC with per-request timeouts.

- Discovery: `thread/list { useStateDbOnly: true, limit, cursor, sortDirection }`.
  **Always** pass `useStateDbOnly: true`; the default scan-and-repair path is slower,
  returns duplicates, and can block pagination. Filter to `!ephemeral &&
  !parentThreadId` and `isWithin(thread.cwd, worktreePath)`.
- Read: `thread/read { threadId, includeTurns: false }` works even for legacy threads
  missing from `thread/list`.
- Previews/metadata: `thread/items/list` (newest-first with `sortDirection: "desc"`).
  `userMessage.content` is an array of `UserInput` blocks; `agentMessage.text` is text.
- Resume: `codex resume <id> --cd <worktree>`; terminal fork fallback:
  `codex fork <id> --cd <worktree>`.
- Fork: `thread/fork { threadId, cwd, excludeTurns: true }` returns `result.thread.id`
  synchronously and materializes the fork in `cwd`. Both fork paths return
  `{ kind: 'linked' }`; the client then calls `thread/unsubscribe` so the app-server
  unloads the fork and releases its writer lock. The private server starts with
  `thread_unload_delay_secs=0`; without that, a terminal opening the fork immediately
  reports the conversation as already open in another app. There is no move or orphan
  cleanup.
- New sessions: `thread/start` does not materialize a thread until the first user
  message, so a separate `codex resume` cannot open it. New chats launch `codex` in a
  terminal; `CodexSessionWatcher` polls for the first new thread in the worktree (3s,
  5-minute TTL) and renames the chat from the thread name or first prompt.
- Live turn state/tokens: `thread/list` reports `status.type = "notLoaded"` for
  TUI-owned threads. `CodexRollout` reads the latest rollout incrementally and uses the
  last `task_started` / `task_complete` / `turn_aborted` event plus `token_count`.
  `thread/items/list` remains authoritative for content; the rollout is only for live
  state and usage.
- Archived threads are excluded by default. `.zst` rollouts are skipped for live state;
  app-server content still works.
- The protocol is experimental. Surface unknown-method errors from the app-server instead
  of guessing, and assume the binary version can change between sessions.
- The shared user daemon (`codex app-server daemon` + `codex app-server proxy --sock`) is
  native to Codex but deferred; see `ROADMAP.md`.

## Session Notifications

`SessionAttentionService` decides *when* to notify; `NotificationService` decides *how*.

- **Turn state lives on the adapter.** `HarnessSession.turnState` is `done` when Claude's last
  non-sidechain entry is an assistant message with a stop reason other than `tool_use`
  (a `user` entry may be a tool result, so it means working), when opencode reports
  `time.idle >= time.updated`, or when Codex's latest rollout event is `task_complete`
  or `turn_aborted`. Do not add harness conditionals to the attention service.
- **Background agents keep a Claude session working.** A subagent launched with the async
  shape returns "Async agent launched successfully" and the parent may end its turn while it
  runs. The authoritative signal is the `turn_duration` system entry Claude writes at every
  turn end: `pendingBackgroundAgentCount` is present only while agents run, so its absence
  means zero. `ClaudeSessionService` falls back to the launch result, `<task-notification>`
  (one per agent, or one listing several stopped agents), and the agent's
  `<agent-message from=…>` hand-back for transcripts that predate that field.
- **"Needs you" is opt-in and Claude-only today.** `agntree.installAttentionHooks` merges a
  `Stop` and a `Notification` hook (`permission_prompt|idle_prompt|elicitation_dialog`) into
  `~/.claude/settings.json`, preserving existing hooks and writing `.agntree-backup` once.
  The hook appends its JSON payload to `~/.agntree/attention.jsonl`; the service matches
  `session_id` against `ChatSession.harnessSessionId` for any harness and never replays lines
  that predate startup. opencode exposes no pending-permission state through its CLI.
- **No spam.** Notifications are skipped for the terminal you are looking at, re-armed by the
  next prompt, and rate-limited to one "needs you" per session per minute. The log is capped
  at 1 MB and truncated.

## Destructive Operations

Deletion is narrow by design; the rules are in
[`AGENTS.md`](AGENTS.md#non-negotiables). This is where each guard lives:

- File operations in `commands/files.ts` use `isWithin` / `isStrictlyWithin` from
  `utils/paths.ts`, validate names to one path segment, and delete through
  `vscode.workspace.fs.delete(..., { useTrash: true })`.
- Creating or pasting never overwrites: `writeFile`/`rename`/`copy` use `overwrite: false`
  (or an explicit existence check) so a stale tree cannot truncate a file.
- `GitService` runs git through `runGit()` (argument arrays, no shell) and never runs a
  command with interpolated user input.
- `GitService.forceRemoveWorktree()` is the only Node directory delete. It refuses the
  filesystem root, the repository, the user's home, ancestors of those, and any path git does
  not list as a worktree.
- User-triggered destructive actions and refusals are recorded with `logOperation()`.

## Dynamic View Titles

The Changes and All Files panels show the active worktree and repository in their titles (e.g., "Changes (feature-branch ~ my-repo)"). This is updated in `extension.ts` via the `updateViewTitles()` helper whenever the selection changes.

## Worktree Management

### Worktree Path Convention

Worktrees are created in a dedicated folder for cleaner organization:
```
/path/to/my-repo/                    # main repository
/path/to/my-repo-worktrees/          # dedicated worktrees folder
  ├── feature-login/                 # worktree for feature/login branch
  └── bugfix-header/                 # worktree for bugfix/header branch
```

### New Branch Creation

When creating a worktree with a new branch, the user selects:
1. Base branch to create the new branch from
2. New branch name
3. Worktree path (defaults to `<repo>-worktrees/<branch-name>`)

### Auto-Refresh on Branch Switch

The `WorkspacesTreeProvider` watches `.git/HEAD` and `.git/worktrees/*/HEAD` files using `vscode.RelativePattern` with absolute paths. This allows detecting branch changes even for repositories outside the current workspace. The tree auto-refreshes within 300ms of a branch switch.

## PR Checkout

The `agntree.checkoutPR` command creates a worktree from a GitHub pull request. It uses `gh` CLI for both PR discovery and fetching.

### Flow

1. User selects a PR from a list (via `gh pr list`) or enters a PR number/URL manually
2. The PR's branch name (`headRefName`) is extracted via `gh pr view`
3. A local branch `pr-<number>` is created using `gh pr checkout <number> --branch pr-<number>` (handles remote resolution for forks automatically)
4. The checkout is immediately reverted with `git checkout -` — the local branch remains
5. A worktree is created from `pr-<number>`, stored in `<repo>-worktrees/<branch-name-with-hyphens>/`
6. The PR number is associated with the worktree via `storageService.setPRWorktree()`

### Why `pr-<number>` branch names?

Using `pr-<number>` (e.g., `pr-4267`) instead of the PR's actual branch name avoids collisions with existing local branches. The worktree directory still uses the original branch name for readability.

## Search Sessions

The `agntree.searchSessions` command finds sessions from every installed harness related to a repository across all worktrees.

### Flow

1. Each installed adapter lists sessions whose `cwd` matches the repo root or a worktree path (`listSessionsForRepository()`)
2. Sessions are grouped by worktree using QuickPick separators (main worktree first, then by name)
3. Already-imported sessions are matched by `harness:sessionId` and get a `$(check)` prefix
4. Rows stay compact: harness mark (`iconPath`), summary, relative time, message count. The branch is in the group header; the harness name is not repeated.
5. Only the highlighted row carries `detail` — a brief with the recap or last exchange, then message count, model, agent, tokens, and cost. Claude fills it from `getSessionMetadata()` (local JSONL); opencode fetches one `session export` (`getPreview()`) and re-reads the cached metadata. Results are cached per `harness:sessionId`.
6. On selection, the session is imported with the owning harness and assigned to the matching worktree (or main worktree if no match)

`QuickPickItem` has no custom tooltip; the highlighted row's `detail` is the equivalent surface. Do not set `detail` on every row — five-line previews per row made the picker several screens tall.

## Important VS Code Extension Gotchas

### Extension Host Restarts on Workspace Switch

Calling `vscode.workspace.updateWorkspaceFolders()` to switch to a different repository **terminates and restarts the extension host**. All in-memory state is lost. To persist state across these restarts:

1. Save critical state to `globalState` before the switch (e.g., `storageService.setActiveWorktreeId()`)
2. Restore state in `activate()` after restart
3. Don't rely on in-memory maps/caches surviving

### Tree View reveal() Requirements

To use `treeView.reveal()` on nested items:

1. **Stable IDs** - Tree items must have consistent `id` properties (e.g., `this.id = \`${itemType}-${data.id}\``)
2. **getParent()** - Must implement `TreeDataProvider.getParent()` method
3. **Visibility** - Wait for tree to be visible before revealing:
   ```typescript
   if (treeView.visible) {
     treeView.reveal(item);
   } else {
     treeView.onDidChangeVisibility(e => { if (e.visible) treeView.reveal(item); });
   }
   ```

### Terminal Persistence Across Restarts

Terminals survive extension host restarts, but the mapping (sessionId → terminal) is lost. The `TerminalManager.syncWithExistingTerminals()` method re-establishes mappings by matching terminal names with the pattern `Agntree: <sessionName>`.
