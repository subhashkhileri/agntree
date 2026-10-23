# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm install                      # Install dependencies
npm run compile                  # Build the extension
npm run watch                    # Build with auto-rebuild on changes
npm run lint                     # Run ESLint
npm run test:dry                 # Fast tests in plain Node (stubbed vscode, no install)
npm run test:integration         # Activate the extension in a real VS Code host
npx @vscode/vsce package         # Package as .vsix for installation
code --install-extension *.vsix  # Install the packaged extension
```

To test during development: Press F5 in VS Code to launch the Extension Development Host.

See `test/README.md` for per-file coverage and test environment variables.

## Architecture

This is a VS Code extension that manages CLI coding-agent sessions (Claude Code and
opencode) across git repositories and worktrees. Harness-specific behavior lives behind
the adapter seam in `src/harnesses/`.

### Harness Adapters (`src/harnesses/`)

- **types.ts** - `HarnessId`, `HarnessAdapter`, `HarnessSession`, `SessionMetadata`, capabilities
- **HarnessRegistry** - installed detection (cached), lookup, `defaultHarness()` from settings
- **ClaudeHarness** - wraps `ClaudeSessionService`; forking defers to `claude --fork-session`
- **OpencodeHarness** - wraps `OpencodeSessionService`; native API fork + move

`ChatSession.harness` selects the adapter everywhere (terminals, tree rows, quick actions,
watchers). Adding Codex means implementing `HarnessAdapter` and registering it in
`extension.ts`; do not add harness conditionals to commands or providers.

### Harness icons

Session rows use custom SVGs from `resources/icons/harness/`, named
`<harness>-<theme>-<state>.svg` where state is `running`, `closed`, or `new`.
Adapters expose them through `HarnessAdapter.treeIcons`; adapters without custom art fall
back to state codicons. Icons are generated from the base marks in
`resources/icons/harness/base/` by `npm run generate:icons` — edit the base marks and
regenerate rather than editing the generated files.

### Core Services (`src/services/`)

- **StorageService** - Persists repositories and sessions to VS Code's globalState; migrates legacy `claudeSessionId` records
- **GitService** - Git operations: worktree listing/creation/deletion, branch merging, commit tracking, diff generation, PR fetching via `gh` CLI
- **TerminalManager** - Opens terminals through the chat's adapter (`buildLaunchCommand`, resumability check, icon)
- **ClaudeSessionService** - Discovers Claude Code sessions from `~/.claude/projects/`, copies sessions between worktrees for forking, repository-wide session search via `findSessionsForRepository()`
- **OpencodeSessionService** - Talks to opencode v2 via its CLI (`opencode api session.*`, `opencode session export`), never its SQLite database
- **OperationLog** - Append-only audit trail (`Agntree Operations` output channel) for destructive file and worktree operations
- **ClaudeSessionWatcher** / **OpencodeSessionWatcher** - Link newly created native sessions to pending chats and auto-name them
- **HarnessWatcherRegistry** - Dispatches pending-chat registration and name events by `chat.harness`

### Tree Providers (`src/providers/`)

- **WorkspacesTreeProvider** - Main sidebar tree: Repository → Worktree → Session hierarchy. Quiet by design: session rows show only a short relative time (`16m`, `2h`, `3d`) or `new`, a star, and the harness mark; the tooltip carries the session brief (recap or last exchange, then message count/model/agent/tokens/cost). Repository icons are neutral; worktree color marks state only — amber for the open workspace, blue for a PR checkout, green for the main worktree, neutral otherwise. Worktrees show `↑n`/`↓n` ahead/behind from `GitService.getAheadBehind()` (15s cache).
- **ChangesTreeProvider** - Shows staged/unstaged git changes for the active worktree. Section headers use a green check (staged) or yellow edit icon plus `n files · +a -d`; nested rows show their directory (`src/utils · M +2 -1`) because the list is flat; rows sort by status then path.
- **FilesTreeProvider** - All Files browser for the active worktree. Directories sort first, names sort naturally, rows tooltip their worktree-relative path, and an unselected panel returns a placeholder row.
- **QuickActionsTreeProvider** - Quick actions panel with process tracking for run/stop functionality

### Commands (`src/commands/`)

Commands are registered in `package.json` under `contributes.commands` and implemented in:
- `repository.ts` - Add/remove/clone repositories
- `worktree.ts` - Create/delete worktrees, merge branches, open in new window, checkout PRs
- `chat.ts` - Create/open/rename/delete/fork sessions, import existing sessions, search sessions across all worktrees
- `quickActions.ts` - Run/stop quick actions (Claude prompts or shell commands)

### Data Flow

1. User adds a repository → stored in globalState
2. GitService detects worktrees via `git worktree list --porcelain`
3. User runs "New Claude Code Session" or "New opencode Session" → `createSession()` creates a chat with that harness, registers it with the matching watcher, and opens a terminal (`claude` or `opencode`)
4. The watcher links the chat to the native session ID when the harness creates it
5. Resume, fork, previews, and quick actions dispatch through `registry.get(chat.harness)`

Forks are named with numeric suffixes by `nextForkName()` in `src/utils/text.ts`:
forking `Fix icons` creates `Fix icons (1)`, and forking that creates
`Fix icons (1) (1)`; sibling forks increment until the name is unique in the target
worktree. There is no `Fork of …` prefix.

### Key Types (`src/types.ts`)

- `Repository` - Git repo with name and root path
- `Worktree` - Branch checked out in a directory
- `ChatSession` - `harness` + `harnessSessionId` for resume/fork in the owning harness

## Claude Code Session Discovery

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

`OpencodeSessionWatcher` polls `session.list` (bypassing the cache) every 3s while chats are pending, claims the oldest new top-level session in the worktree, links it, and renames the chat from the title (falling back to the first prompt after 30s). It gives up after 5 minutes.

The opencode command is configurable via `agntree.harnessCommands.opencode` (default `opencode`). Prefer `opencode api …` over the TUI/`--fork` flags; `--fork` exists only on `opencode run`, not the TUI.

## Destructive Operations

Deletion is narrow by design. Keep it that way:

- File operations in `commands/files.ts` must stay inside the active worktree (`isInside`), validate names to one path segment, and delete through `vscode.workspace.fs.delete(..., { useTrash: true })`.
- Creating or pasting never overwrites: `writeFile`/`rename`/`copy` use `overwrite: false` (or an explicit existence check) so a stale tree cannot truncate a file.
- `GitService` runs git through `runGit()` (argument arrays, no shell) and never runs a command with interpolated user input.
- `GitService.forceRemoveWorktree()` is the only Node directory delete. It refuses the filesystem root, the repository, the user's home, ancestors of those, and any path git does not list as a worktree.
- Log user-triggered destructive actions and refusals with `logOperation()`.

## Quick Actions

Quick Actions allow running agent prompts or shell commands with one click from the sidebar.

### Two Modes

1. **Prompt mode** - Harness-aware, built by the adapter:
   - Claude: requires `allowedTools`, then
     ```typescript
     spawn('claude', ['-p', prompt, '--allowedTools', allowedTools], { cwd: worktreePath })
     ```
   - opencode:
     ```typescript
     spawn('opencode', ['run', prompt, '--auto', '--agent', agent, '--model', model], { cwd: worktreePath })
     ```
   The action's `harness` wins; otherwise `agntree.defaultHarness` (default `claude`).

2. **Command mode** - Uses `command` to run any shell command cross-platform:
   ```typescript
   spawn(command, { cwd: worktreePath, shell: true })
   ```

### Process Management

The `QuickActionsTreeProvider` tracks running processes in a `Map<number, ChildProcess>`. This enables:
- Displaying a spinning sync icon for running actions
- Stop button to terminate running processes via `process.kill()`
- Preventing duplicate runs of the same action

### Dynamic View Titles

Both Changes and Quick Actions panels show the active worktree and repository in their titles (e.g., "Changes (feature-branch ~ my-repo)"). This is updated in `extension.ts` via the `updateViewTitles()` helper whenever the selection changes.

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

## Testing

- `npm run test:dry` — bundles each `test/dry/*.test.ts` with esbuild, aliasing `vscode` to `test/dry/vscode-stub.js`, and runs it under plain Node. No extension install. Filter with `npm run test:dry -- <substring>`.
  - Claude/opencode discovery tests inspect real local sessions. Set `AGNTREE_TEST_CLAUDE_REPO` / `AGNTREE_TEST_OPENCODE_WORKTREE`, or they use the current directory and skip when no sessions exist.
  - The opencode watcher test creates and deletes a scratch session; the adapter test forks a real session and deletes the fork. No model turns are run.
- `npm run test:integration` — starts a real VS Code Extension Development Host with a throwaway profile and asserts activation, registered commands, contributed settings, and menu gating. Set `VSCODE_EXECUTABLE` if VS Code is not in a standard location.

See `test/README.md` for the full matrix.

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

## Available Skills

This project includes Claude Code skills in `.claude/skills/`:

- **build-extension** - Build, package, install the extension, and tell the user to reload the window (`Cmd+Shift+P` → Developer: Reload Window)
- **add-feature** - Guide for adding new features following project architecture
- **debug-extension** - Troubleshoot extension issues

Skills are auto-discovered by Claude Code when working in this project.
