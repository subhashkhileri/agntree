# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm install                      # Install dependencies
npm run compile                  # Build the extension
npm run watch                    # Build with auto-rebuild on changes
npm run lint                     # Run ESLint
npx @vscode/vsce package         # Package as .vsix for installation
code --install-extension *.vsix  # Install the packaged extension
```

To test during development: Press F5 in VS Code to launch the Extension Development Host.

## Architecture

This is a VS Code extension that manages Claude Code CLI sessions across git repositories and worktrees.

### Core Services (`src/services/`)

- **StorageService** - Persists repositories and sessions to VS Code's globalState
- **GitService** - Git operations: worktree listing/creation/deletion, branch merging, commit tracking, diff generation, PR fetching via `gh` CLI
- **TerminalManager** - Spawns and manages VS Code terminals running `claude` CLI
- **ClaudeSessionService** - Discovers existing Claude Code sessions from `~/.claude/projects/`, copies sessions between worktrees for forking, repository-wide session search via `findSessionsForRepository()`

### Tree Providers (`src/providers/`)

- **WorkspacesTreeProvider** - Main sidebar tree: Repository → Worktree → Session hierarchy
- **ChangesTreeProvider** - Shows staged/unstaged git changes for the active worktree
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
3. User creates a session → TerminalManager spawns terminal with `claude --resume <sessionId>`
4. Sessions link to Claude Code's session files for resumption

### Key Types (`src/types.ts`)

- `Repository` - Git repo with name and root path
- `Worktree` - Branch checked out in a directory
- `ChatSession` - Links to Claude Code's `claudeSessionId` for `--resume` and `--fork-session`

## Claude Code Session Discovery

Sessions are stored in `~/.claude/projects/<encoded-path>/*.jsonl`. The `ClaudeSessionService` parses these files to extract session IDs, summaries, and timestamps for import into the extension.

### Path Encoding

Claude Code encodes directory paths by replacing `/`, `\`, and `.` with `-`. For example:
- `/Users/dev/my-project` → `-Users-dev-my-project`

The `ClaudeSessionService.encodeProjectPath()` method handles this encoding when copying sessions between worktrees.

### Session Forking

When forking a session to a new worktree, the extension copies the entire project directory from `~/.claude/projects/<source>` to `~/.claude/projects/<dest>`. This preserves conversation history so Claude can resume from the forked point.

## Quick Actions

Quick Actions allow running Claude prompts or shell commands with one click from the sidebar.

### Two Modes

1. **Claude mode** - Uses `prompt` + `allowedTools` to run Claude headlessly:
   ```typescript
   spawn('claude', ['-p', prompt, '--allowedTools', allowedTools], { cwd: worktreePath })
   ```

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

The `agntree.searchSessions` command finds all Claude Code sessions related to a repository across all worktrees.

### Flow

1. `ClaudeSessionService.findSessionsForRepository()` collects sessions whose `cwd` matches the repo root or any worktree path
2. Sessions are grouped by worktree using QuickPick separators
3. Already-imported sessions are marked with a checkmark and cannot be re-imported
4. Each session shows: summary, relative time, message count, branch name, and a preview of recent user prompts
5. On selection, the session is imported and assigned to the matching worktree (or main worktree if no match)

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

- **build-extension** - Build and package the VS Code extension
- **add-feature** - Guide for adding new features following project architecture
- **debug-extension** - Troubleshoot extension issues

Skills are auto-discovered by Claude Code when working in this project.
