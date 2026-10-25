# Agntree architecture

This is the deep reference for how Agntree is put together. Read [`AGENTS.md`](AGENTS.md)
first for the working agreement — where a change belongs, what to investigate before
coding, testing doctrine, and the definition of done. Build and verification commands live
there too.

Decisions that are expensive to reverse, and the evidence behind them, are recorded in
[`adr/`](adr/README.md). Read the matching record before changing a subsystem's shape; this
file describes what the code does today, the ADR explains why.

## Subsystem map

This is a VS Code extension that manages CLI coding-agent sessions (Claude Code,
opencode, and Codex) across git repositories and worktrees. Harness-specific behavior
lives behind the adapter seam in `src/harnesses/`.

### Harness Adapters (`src/harnesses/`)

- **types.ts** - `HarnessId`, `HarnessAdapter`, `HarnessSession`, `SessionMetadata`, capabilities
- **HarnessRegistry** - installed detection (cached) and lookup
- **ClaudeHarness** - wraps `ClaudeSessionService` and `ClaudeAgentsService`; new chats
  choose their session ID up front, forks use `--resume … --fork-session --session-id …`,
  and live turn state comes from a transcript tail
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
- **ClaudeSessionService** - Discovers Claude Code sessions under `<configDir>/projects/`,
  parses the lean metadata surface (summary, preview, last exchange, last activity, turn
  state, `hasMessages`) and resolves session IDs to transcript paths; repository-wide
  session search via `findSessionsForRepository()`
- **ClaudeAgentsService** - Caches `claude agents --json` for 10s (sharing one in-flight
  call), merges duplicate session IDs, and supplies `waitingFor` to the attention path.
  Disabled when `agntree.notifications.onNeedsInput` is off; a failure logs once and
  disables the interface until restart.
- **ClaudeTurnState** - Shared turn-state derivation plus the progressive tail reader used
  by `getLiveStates()`; reads 16 KB, then grows 4× until the deciding entries are found or
  the window reaches the start of the file.
- **OpencodeSessionService** - Talks to opencode v2 via its CLI (`opencode api session.*`, `opencode session export`), never its SQLite database
- **CodexAppServer** - Lazy, private `codex app-server --listen stdio://` JSON-RPC client with request matching, timeouts, restart on exit, and idle shutdown
- **CodexRollout** - Incremental reader for `~/.codex/sessions/**/*.jsonl`; supplies live turn state, token usage, and message counts for TUI-owned threads
- **OperationLog** - Append-only audit trail (`Agntree Operations` output channel) for destructive file and worktree operations
- **SessionAttentionService** - Polls chats with open terminals (~4s) through
  `HarnessAdapter.getLiveStates()` when the adapter implements it, otherwise through
  `listSessionsForWorktree()`; notifies on a finished turn or a non-empty `waitingFor`
- **NotificationService** - Delivers the VS Code notification (with an Open action) and, on macOS while the window is unfocused, an `osascript` banner. Skips the session you are already typing in
- **PendingSessionWatcher** - Shared polling loop for harnesses whose native session ID is assigned in a separate process: snapshot, claim the oldest unseen session, TTL, and auto-naming. Subclasses supply the harness and naming hooks
- **ClaudeSessionWatcher** / **OpencodeSessionWatcher** / **CodexSessionWatcher** - Link newly created native sessions to pending chats and auto-name them. Claude watches `<configDir>/projects` for a transcript named by the chat's expected pending ID, so there is no claim-the-newest step and no directory matching; it reuses `ClaudeSessionService` for transcript lookup and the cached parse for auto-naming, while opencode and Codex extend `PendingSessionWatcher`
- **HarnessWatcherRegistry** - Dispatches pending-chat registration and name events by `chat.harness`

### Tree Providers (`src/providers/`)

- **WorkspacesTreeProvider** - Main sidebar tree: Repository → Worktree → Session hierarchy, with a plain folder standing in for a repository that has no worktrees of its own. Quiet by design: session rows show only a short relative time (`16m`, `2h`, `3d`) or `new`, a star, and the harness mark; the tooltip carries the session brief (last exchange, then message count/model/agent/tokens/cost, skipping fields the harness does not provide — Claude supplies only summary, last exchange, and last activity). Repository icons are neutral — `repo` for a git repository, `folder` for a plain folder; worktree color marks state only — amber for the open workspace, blue for a PR checkout, green for the main worktree, neutral otherwise. Worktrees show `↑n`/`↓n` ahead/behind from `GitService.getAheadBehind()` (15s cache). Repository rows follow the stored array order; **Move Up** / **Move Down** swap a row with its nearest visible neighbor, so the order needs no field of its own.
- **ChangesTreeProvider** - Shows staged/unstaged git changes for the active worktree. Section headers use a green check (staged) or yellow edit icon plus `n files · +a -d`; nested rows show their directory (`src/utils · M +2 -1`) because the list is flat; rows sort by status then path. A plain folder shows “Not a git repository” instead of a clean-tree message.
- **FilesTreeProvider** - All Files browser for the active worktree. Directories sort first, names sort naturally, rows tooltip their worktree-relative path, and an unselected panel returns a placeholder row.

### Commands (`src/commands/`)

Commands are registered in `package.json` under `contributes.commands` and implemented in:
- `repository.ts` - Add/remove/clone workspace roots (plain folders or git repositories)
- `worktree.ts` - Create/delete worktrees, merge branches, open in new window, checkout PRs
- `chat.ts` - Create/open/rename/delete/fork sessions, import existing sessions, search sessions across all worktrees

### Data Flow

1. User adds a folder or repository → stored in globalState
2. GitService detects worktrees via `git worktree list --porcelain`; a plain folder is reported as its own single worktree
3. User runs "New Claude Code Session", "New opencode Session", or "New Codex Session" → `createSession()` creates a chat with that harness, registers it with the matching watcher, and opens a terminal (`claude`, `opencode`, or `codex`). Claude chats choose a UUID first and launch `claude --session-id <uuid>`.
4. The watcher links the chat to the native session ID when the harness creates it; Claude already knows the expected ID and waits for that exact transcript
5. Resume, fork, and previews dispatch through `registry.get(chat.harness)`

Forks are named with numeric suffixes by `nextForkName()` in `src/utils/text.ts`:
forking `Fix icons` creates `Fix icons (1)`, and forking that creates
`Fix icons (1) (1)`; sibling forks increment until the name is unique in the target
worktree. There is no `Fork of …` prefix.

### Key Types (`src/types.ts`)

- `Repository` - Workspace root (a git repository or a plain folder) with name and root path
- `Worktree` - Branch checked out in a directory
- `ChatSession` - `harness` + `harnessSessionId` for resume/fork in the owning harness,
  plus `pendingHarnessSessionId` and `forkedFromSessionId` while a Claude launch has not
  produced a transcript yet

## Claude Code Sessions

Claude Code 2.1.310 or newer is required. There is no version probe or legacy path: an
older CLI is unsupported and surfaces its own error when launched. Agntree uses the
`claude` CLI, its transcripts, and `claude agents --json`; it never edits
`~/.claude/settings.json`.

Sessions are stored in `<configDir>/projects/<encoded-path>/<session-id>.jsonl`, where
`<configDir>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. `CLAUDE_CODE_PROJECT_DIR_NAME`, when
set together with an explicit `CLAUDE_CONFIG_DIR`, adds a project directory under
`<configDir>/projects`; without the config dir it is ignored, matching Claude.

`ClaudeSessionService` parses transcripts for discovery, naming, previews, the last
exchange, last activity, turn state, and `hasMessages` (used by `isSessionResumable`). A
`relocated` entry's `relocatedCwd` replaces the cwd stamped on earlier entries, because a
moved session's transcript can stay in its old project dir. The surface is deliberately
lean: recap (`away_summary`), model/token usage, `gitBranch`, and message count are not
extracted; `HarnessSession` reports `gitBranch: null`, `messageCount: 0`, and omits
model/tokens.

### Path Encoding

Every character outside `[A-Za-z0-9]` becomes `-`:

- `/Users/dev/my-project` → `-Users-dev-my-project`

Encoding runs on the physical, NFC-normalized path (`canonicalPath`), so a worktree opened
through a symlink resolves to the same project directory Claude writes. Directories longer
than 200 encoded characters truncate to the first 200 and append a hash Claude does not
document. Discovery matches the 200-character prefix (`claudeProjectDirMatches`) and
verifies each session's `cwd` with `isWithin`, which disambiguates paths that share the
prefix. If the same session ID appears in more than one project directory (a relocated
session), discovery keeps the newest transcript.

### New sessions and pending IDs

A transcript appears only after the first prompt. `createSession()` generates a UUID,
persists it as `ChatSession.pendingHarnessSessionId`, registers the chat with
`ClaudeSessionWatcher`, and launches `claude --session-id <uuid>`. Pending chats are
derived from stored chats on each check, so there is no second pending map to keep in
sync. The watcher checks immediately and every 5s while any remain, matching
`<id>.jsonl` by exact basename anywhere under `<configDir>/projects`; a project-dir watch
event links the named transcript directly, with the poll as the fallback. The in-memory
pending-ID set gates those events, so appends to already-linked transcripts do no storage
work. A transcript with no messages is not linked yet (it cannot be resumed); the chat
keeps its pending ID until the first prompt. A pending chat whose terminal is closed and
whose transcript never gains messages stops being polled after 5 minutes. There is no
snapshot, claim-the-newest rule, or directory matching. On a match it sets
`harnessSessionId`, clears `pendingHarnessSessionId`, and starts the name monitor. A chat
closed before the first prompt keeps its pending ID and reopens with the same
`--session-id`. A pre-change chat with neither ID gets one when it is opened *and a
terminal is actually launched*; focusing an existing terminal mints nothing. That
migration is temporary (see `ROADMAP.md`).

### Forks

`forkSession()` and `prepareForkToNewWorktree()` validate that the source transcript is
still resumable before generating a new UUID and returning
`{ kind: 'terminal', pendingSessionId }`; nothing is copied. The terminal runs
`claude --resume <source> --fork-session --session-id <new>`, which writes the fork
transcript in the destination `cwd`. The watcher links the new ID when the first prompt
creates the transcript, so the chat stores `forkedFromSessionId` until then. Claude writes
nothing before that prompt: reopening such a fork repeats the command against the source's
current state, not the state it was forked from. Closing the terminal before the first
prompt therefore drops the chat (`TerminalManager.dropUnusedFork()`) instead of leaving a
row that would silently fork from a later point. Once the transcript exists, the pending ID
is resumable, so reopening resumes it rather than forking again.

### Live turn state

`ClaudeHarness.getLiveStates()` resolves each session ID to its transcript through a
cached ID → path catalog (a miss is remembered for 30s so a session whose transcript has
not appeared does not rescan every project dir), then `readTurnStateTail()` reads the end
of the file: 16 KB, then 64 KB, 256 KB, 1 MB, … until the deciding entries appear or the
window reaches the start of the file. `ClaudeSessionService` caches the reading by
mtime+size, so the 4-second attention tick only re-reads transcripts that changed. It
tracks the latest `turn_duration` (`pendingBackgroundAgentCount`) and the last
non-sidechain user/assistant entry. A user entry, a `tool_use`/null stop reason, or a
positive pending count means working; any other assistant stop reason with zero pending
means done, with `turnEndedAt` from that entry. `agents --json` is process-level, so it only
supplies `waitingFor`; it cannot replace the transcript for turn state. The priming tick
seeds both `waitingFor` and the turn-end baseline, so a state that predates the extension
host starts silently.


## opencode Sessions

opencode v2 stores sessions in `~/.local/share/opencode/opencode.db` (SQLite). **Never read that database directly.** `OpencodeSessionService` goes through the CLI:

- Discovery: `opencode api session.list --param limit=… [--param directory=…]` (paginated; filter out `parentID` children)
- Lookup / resume check: `opencode api session.get --param sessionID=<id>`
- Fork: `opencode api session.fork --param sessionID=<id> --data '{}'` → new top-level `ses_…` ID
- Move: `opencode api session.move --param sessionID=<id> --data '{"directory":"<abs path>"}'`
- Previews: `opencode session export <id>`, parsed for user messages; cached in-memory (LRU, 5 min)
- Resume in terminal: `opencode --session <id>`; new session: `opencode`

`opencode session export` truncates large JSON when stdout is a pipe. `execToFile()` works around this by redirecting stdout to a temp file before parsing. Keep list pages small for the same reason.

Forking to a new worktree uses the native fork + move path (`prepareForkToNewWorktree()`); on a move failure the orphan fork is deleted best-effort.

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
  or `turn_aborted`. Do not add harness conditionals to the attention service. Claude's
  attention path reads only the transcript tail; the full parser and the tail reader share
  one derivation so they cannot drift.
- **Background agents keep a Claude session working.** A subagent launched with the async
  shape returns "Async agent launched successfully" and the parent may end its turn while it
  runs. The authoritative signal is the `turn_duration` system entry Claude writes at every
  turn end: `pendingBackgroundAgentCount` is present only while agents run, so its absence
  means zero. There is no fallback for transcripts that predate that field.
- **"Needs you" comes from `claude agents --json`.** `ClaudeAgentsService` reads the
  process-level `status` and `waitingFor` for active sessions, cached for 10s. When
  `agntree.notifications.onNeedsInput` is off it returns nothing without spawning the CLI.
  Claude-only today: opencode and Codex expose no pending-permission state through their
  implementations. `waitingFor` is passed to the notifier as-is; `status: waiting` without
  a reason becomes `input needed`.
- **No spam.** Notifications are skipped for the terminal you are looking at, re-armed by the
  next prompt, and rate-limited to one "needs you" per session per minute. A waiting
  session suppresses its turn-end notification.

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

### Folders without git

Adding a folder never rejects it for lacking git. `Repository` stores only the root path —
git-ness is derived on every render by `GitService.listRepositoryWorktrees()`, so there is
no stored flag to migrate and no downgrade state if the repository is removed.

- `listRepositoryWorktrees()` returns `{ isGit, worktrees }`. When the root is not a git
  working tree, it synthesizes one root worktree using the deterministic id
  `generateWorktreeId(repoId, canonicalPath(rootPath))` — the same id the porcelain parse
  produces after `git init`, so chats keep their worktree binding across the conversion.
  A path only counts as git when the porcelain output lists it as a worktree; git also
  answers from a subdirectory of a repository, and that ancestor's worktrees are not this
  root. Bare repositories report `isGit: true` with no worktrees.
- The tree renders that folder as a `folderRepository` row and its chats directly beneath
  it, with no synthetic worktree row. `getWorktreeForItem()` resolves the folder row to the
  root worktree, so New Session, Open Terminal, the file panels, and restored terminals
  all work from the folder. `getTreeItemForWorktree()` returns the folder row for reveal,
  and the Changes panel asks `isGitWorktree()` so both panels share one derived answer.
  A plain folder returns its placeholder before running any git command.
- Watchers add a `vscode.RelativePattern(rootPath, '.git')` watcher per repository. When
  `.git` appears or is removed, the provider rebuilds the watchers and refreshes, so `git init` upgrades the row — and deleting `.git` returns it to a plain
  folder — with no manual refresh.
- Menus widen shared actions to `folderRepository`; git-only row actions (worktree
  create/delete, merge, rebase, PR checkout) stay exact-match on `repository` and
  `worktree`. A session in a plain folder keeps **Fork to New Worktree** in its menu and
  explains that there is no branch to fork into.

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
4. Rows stay compact: harness mark (`iconPath`), summary, relative time, and message count when the harness provides one. The branch is in the group header; the harness name is not repeated.
5. Only the highlighted row carries `detail` — a brief with the last exchange, then message count, model, agent, tokens, and cost. Claude fills it from `getSessionMetadata()` (local JSONL) but contributes only the last exchange, because its parsed surface no longer includes recap or usage; opencode fetches one `session export` (`getPreview()`) and re-reads the cached metadata. Results are cached per `harness:sessionId`.
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

VS Code preserves different things across a window reload and a quit, so an Agntree
terminal has two identities.

**The custom title is the identity across a quit.** Every terminal mapped to a chat
carries exactly `Agntree: <chat name> [<shortId>]`. `TerminalManager.getTerminalName()`
is the only formatter, and `parseTerminalShortId()` accepts a name only when it starts
with `Agntree: ` and ends with a six-character id, so a terminal Agntree did not create
is never matched. A rename is persisted only after the pty exists and the command has
started: until then shell integration reports the cwd, which makes VS Code re-tag the
title as a config title and lets the shell's own title win on the next restore.
`openChat()` therefore awaits the PID and, when shell integration is enabled, the
command start, activates the tab, and calls `applyTitle()`. With
`terminal.integrated.shellIntegration.enabled: false` no command-start event can arrive
and no cwd report re-tags the title, so the wait is skipped. The focus and
shell-integration listeners re-apply the title when VS Code or the user changes it. The
rename command targets only the active terminal, so every caller must activate its tab
first. Title writes are serialized and re-check the active tab when they run, so
overlapping focus changes cannot rename one chat's tab with another chat's title.

**Background title work is not a user focus change.** Re-applying titles to revived
tabs needs each tab active for the rename. `TerminalManager` records the tab it is about
to activate and `consumeBackgroundActivation()` lets the extension's
`onDidChangeActiveTerminal` handler ignore that activation, so the tree selection, the
Changes and All Files worktree, and `autoSwitchWorkspaceFolder` react only to the user.
The retitle pass restores the previously active tab when it finishes and stops as soon
as the user takes over.

**The process ID is the identity across a reload.** `globalState` holds
`agntree.terminalPids: Record<workspacePath, Record<chatId, pid>>`
(`StorageService.getTerminalPids()` and `rememberTerminalPid()`). It is written when a
launched terminal's PID resolves and is kept when the tab closes — VS Code fires close
events on quit, and the record is the proof the next activation needs. It is removed
only when the chat is deleted, in every workspace that recorded it. The record is
scoped by workspace folder rather than stored in `workspaceState`, because
`autoSwitchWorkspaceFolder` replaces the folder and gives VS Code a fresh workspace
store; a workspace-scoped record would erase the identity of the terminals Agntree left
running. A record written by an earlier development build in `workspaceState` is
migrated on first read. A reload keeps the pty and its PID, so activation adopts matching
terminals without sending anything into them. A quit revives each tab as a new shell
with a new PID, so a tab whose title maps to a chat this workspace recorded and whose
PID differs is a revived shell: activation changes into the chat's worktree and types
the resume command into that tab. Every restored tab is resumed in the background; no
tab is focused.

`TerminalManager.beginRestoreSync(getWorktree)` runs during `activate()` and returns
`{ adopted, complete }`. Adoption is the first step and is bounded; the rest runs in
`complete` after the views and commands exist.

1. `adopted` reads the recorded PIDs once and reads each relevant terminal's PID,
   bounded to two seconds; unrelated user terminals are skipped. It adopts terminals
   whose PID belongs to a chat (the reload path), restoring the chat map, status, title,
   and PID record, and never sends input to an adopted terminal. Activation awaits this
   phase before commands exist, so a click cannot open a second agent for an adopted
   chat.
2. `complete` resumes restored tabs (the quit path) after the views and commands exist:
   match `[shortId]`, require a recorded PID for that chat and a different current PID,
   skip ambiguous ids, unlinked forks, and missing worktrees, then resolve the launch
   commands concurrently and send
   `cd <worktree> && <launch command>` sequentially. Resumability is a native call
   (Codex's app-server can take 30 seconds to time out), so it must not run before the
   UI is registered. Until a candidate finishes its check, `openChat` treats that tab as
   the chat's terminal: a click focuses it instead of starting a second agent. Only the
   first tab per chat is resumed; a duplicate title is left untouched. Missing-session
   warnings are suppressed at startup.
3. While resuming, every restored chat that has no native session is registered with
   its harness watcher. The watcher's in-memory registration died with the previous
   extension host; registering again lets it link the session the next prompt creates.
   Chats with a native session are not registered.
4. Re-applies titles for revived tabs whose shell reports integration, after their
   commands start. The pass is serialized with other title writes and marked as
   background activation (see above).
5. Marks owned chats that are still `active` but have no live terminal as `idle`.

Worktree lookups during restore go through `WorkspacesTreeProvider`, which caches each
repository's `git worktree list` result, so a cold lookup lists each repository at most
once instead of once per restored chat.

Limits:

- A tab renamed by hand before a quit has no matching short id and is not resumed.
  Focusing it re-applies the Agntree title.
- If two tabs carry the same short id, only the first is resumed; the duplicate stays a
  plain shell and is not managed by Agntree.
- A shell that never reports integration with the setting still enabled (for example
  `cmd`) cannot produce a command-start event, so opening a chat waits out the bounded
  command-start timeout before skipping the rename. With the setting disabled the wait
  is skipped immediately.
- `terminal.integrated.enablePersistentSessions: false` keeps no tabs across a quit, and
  `terminal.integrated.persistentSessionReviveProcess: never` restores plain shells
  without Agntree titles. Neither leaves anything to resume.
- The PID record is scoped to the workspace folder; restore assumes one window per
  workspace. A second window does not share the first window's terminals, and records
  for workspaces that are no longer open stay in `globalState` until their chats are
  deleted.
- The restore `cd` uses POSIX quoting like the harness launch commands, so Windows
  shells need the platform-specific quoting tracked in `ROADMAP.md`.

See [ADR 0009](adr/0009-restored-terminals-keep-their-chat.md).
