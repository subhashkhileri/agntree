# Agntree - Claude Code Session Manager

[![VS Code Extension](https://img.shields.io/badge/VS%20Code-Extension-blue?logo=visualstudiocode)](https://github.com/subhashkhileri/agntree)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub issues](https://img.shields.io/github/issues/subhashkhileri/agntree)](https://github.com/subhashkhileri/agntree/issues)
[![GitHub stars](https://img.shields.io/github/stars/subhashkhileri/agntree)](https://github.com/subhashkhileri/agntree/stargazers)

> **Supercharge your Claude Code workflow** - Manage multiple AI coding sessions across git repositories and worktrees with ease.

A powerful VS Code extension for developers using [Claude Code CLI](https://claude.ai/code) who work across multiple projects, branches, and repositories. Agntree provides a unified interface to manage, fork, and switch between Claude Code sessions seamlessly.

## Why Agntree?

- **Context Switching Made Easy** - Jump between different coding sessions without losing context
- **Git Worktree Integration** - Perfect for developers who use git worktrees for parallel development
- **Session Forking** - Branch your AI conversations just like you branch your code
- **One-Click Actions** - Run common Claude prompts or shell commands instantly

## Features

- **Multi-Repository Management** - Add and organize multiple git repositories in one place
- **Worktree Support** - Automatically detects and displays git worktrees for each repository
- **Session Management** - Create, resume, rename, and remove Claude Code sessions
- **Fork Sessions** - Fork an ongoing session to branch the conversation, with or without creating a new worktree
- **Session Import** - Import existing Claude Code sessions from `~/.claude/projects/` with multi-select support
- **Changes Panel** - View staged/unstaged changes with inline diffs, stage/unstage/discard actions
- **Quick Actions** - Run Claude prompts or shell commands with one click (configurable)
- **Auto-Naming** - Sessions are automatically named based on their first prompt or summary
- **Workspace Switching** - Optionally switches VS Code workspace when selecting a worktree (configurable)
- **State Persistence** - Active worktree and session selection persists across VS Code restarts
- **Session Previews** - Hover over sessions to see the last 3 messages in a tooltip
- **Terminal Sync** - Switching between session terminals auto-selects the corresponding session in the tree
- **Inline Actions** - Quick action icons appear on hover for common operations
- **Worktree Merge** - Merge branches between worktrees directly from the extension
- **Dynamic View Titles** - Changes and Quick Actions panels show active worktree and repo name

## Installation

### From VSIX (Recommended)

1. Download or build the `.vsix` file
2. In VS Code, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Run `Extensions: Install from VSIX...`
4. Select the `agntree-x.x.x.vsix` file

### From Source

```bash
git clone https://github.com/subhashkhileri/agntree.git
cd agntree
npm install
npm run compile
npx @vscode/vsce package
code --install-extension agntree-*.vsix
```

## Requirements

- VS Code 1.85.0 or higher
- [Claude Code CLI](https://claude.ai/code) installed and configured
- Git installed and available in PATH

## Usage

### Getting Started

1. Click the **Agntree** icon in the Activity Bar (left sidebar)
2. Click **Add Local Repository** or **Clone from GitHub** to add your first repository
3. The extension will automatically detect worktrees in the repository

### Managing Repositories

| Action | How To |
|--------|--------|
| Add Local Repository | Click the folder icon in the Workspaces panel title bar |
| Clone from GitHub | Click the cloud icon in the Workspaces panel title bar |
| Create Worktree | Hover over repository → Click `+` icon, or right-click → Create Worktree |
| Remove Repository | Hover over repository → Click `✕` icon, or right-click → Remove from Extension |

**Clone from GitHub**: Enter a GitHub URL (`https://github.com/owner/repo`) or shorthand (`owner/repo`), select a parent folder, and the repository will be cloned and added automatically.

### Working with Worktrees

| Action | How To |
|--------|--------|
| Create Worktree | Right-click a repository → Create Worktree |
| New Session | Hover over worktree → Click session icon, or right-click → New Session |
| Open Terminal | Hover over worktree → Click terminal icon (opens terminal at worktree path) |
| Copy Path | Right-click a worktree → Copy Path |
| Activate Workspace | Right-click a worktree → Activate Workspace (when auto-switch is OFF) |
| Open in New Window | Right-click a worktree → Open in New Window |
| Merge Branch | Right-click a worktree → Merge Branch Into This |
| Clear All Sessions | Right-click a worktree → Clear All Sessions |
| Delete Worktree | Right-click a worktree → Delete Worktree (option to also delete branch) |

**Create Worktree Flow**:
1. Choose "Existing branch" or "New branch"
2. For new branches: select the base branch to branch from, then enter the new branch name
3. Confirm the worktree path (defaults to `<repo>-worktrees/<branch-name>`)

Worktrees are organized in a dedicated folder (e.g., `my-repo-worktrees/`) for cleaner organization.

### Managing Sessions

| Action | How To |
|--------|--------|
| New Session | Hover over worktree → Click `+` icon |
| Open/Resume Session | Click on a session |
| Rename Session | Hover over session → Click edit icon |
| Remove Session | Hover over session → Click `✕` icon |
| Fork Session | Right-click a session → Fork Session (creates branch in same worktree) |
| Fork to New Worktree | Right-click a session → Fork Session to New Worktree (creates worktree with changes) |
| Import Sessions | Right-click a worktree → Import Existing Sessions |

**Note**: Removing a session only removes it from the extension's list. The Claude session files in `~/.claude/` are preserved and can be re-imported later.

**Fork Session to New Worktree**: This creates a new git worktree, copies uncommitted changes from the current worktree, copies the Claude session data, and opens a forked session in the new worktree. This is useful for exploring alternative approaches while preserving your current work.

### Viewing Changes

The **Changes** panel shows uncommitted changes for the currently selected worktree:

- **Staged Changes** section shows files ready to commit
- **Changes** section shows unstaged modifications
- Click on any file to open a diff view (toggle on/off)
- Inline actions: Stage (`+`), Unstage (`-`), Discard changes
- Section headers show file count and total additions/deletions
- Changes are auto-refreshed when files are modified
- Panel title shows active worktree and repository name

### Quick Actions

The **Quick Actions** panel lets you run commands with one click:

- **Claude mode**: Run Claude headlessly with a prompt and allowed tools
- **Command mode**: Run any shell command directly (cross-platform)
- Play/Stop buttons to start and terminate running actions
- Output displayed in "Agntree Quick Actions" output channel
- Panel title shows active worktree and repository name

**Default quick actions:**
- **Commit** - Runs Claude with a commit prompt
- **Git Status** - Runs `git status` command

**Configuration** (Settings → `agntree.quickActions`):

```json
{
  "agntree.quickActions": [
    {
      "name": "Commit",
      "icon": "git-commit",
      "prompt": "Run the /commit-commands:commit slash command",
      "allowedTools": "Bash(git:*),Read,Glob,Grep"
    },
    {
      "name": "Build",
      "icon": "tools",
      "command": "npm run build"
    }
  ]
}
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agntree.autoSwitchWorkspaceFolder` | `true` | Automatically switch VS Code's workspace folder when selecting a worktree. Disable to prevent flickering from extension host restart. |
| `agntree.quickActions` | See below | Array of quick actions. Each action needs `name` and either `command` (shell) or `prompt` + `allowedTools` (Claude). |

You can toggle auto-switch directly from the tree view title bar using the sync icon.

## Tree View Icons

### Title Bar
- Folder icon - Add local repository
- Cloud icon - Clone from GitHub
- Sync icon - Toggle auto-switch workspace (shows current state)
- Refresh - Refresh tree

### Inline Actions (on hover)

| Item | Actions |
|------|---------|
| Repository | Create Worktree (`+`), Remove (`✕`) |
| Worktree | New Session, Open Terminal |
| Session | Rename, Remove (`✕`) |
| Staged Section | Unstage All |
| Unstaged Section | Stage All |
| Staged File | Unstage |
| Unstaged File | Stage, Discard |
| Quick Action | Play (run) or Stop (terminate) |

### Item Icons

**Repositories:**
- Green repo icon

**Worktrees:**
- Yellow folder (opened) - Currently active workspace
- Green git-branch icon - Main branch
- Purple git-merge icon - Other worktrees

**Sessions:**
- Green pulse icon - Active/running session
- Orange history icon - Resumable session (shows relative time)
- Gray comment icon - New session (not started yet)

### Descriptions
- Worktrees show "● open" if current workspace
- Sessions show "● running", relative time, or "new session"
- Hover over items to see full paths in tooltip

## Commands

All commands are available in the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `Agntree: Add Local Repository` | Add an existing git repository |
| `Agntree: Clone from GitHub` | Clone a repository from GitHub and add it |
| `Agntree: Remove from Extension` | Remove repository from extension (files preserved) |
| `Agntree: Create Worktree` | Create a new git worktree |
| `Agntree: Delete Worktree` | Delete a worktree (optionally delete the branch too) |
| `Agntree: Merge Branch Into This` | Merge another branch into the selected worktree |
| `Agntree: New Session` | Start a new Claude Code session |
| `Agntree: Open Session` | Open/resume a session |
| `Agntree: Rename Session` | Rename a session |
| `Agntree: Remove from List` | Remove session from list (Claude session preserved) |
| `Agntree: Fork Session` | Fork a session in the same worktree |
| `Agntree: Fork Session to New Worktree` | Fork session to a new worktree with changes |
| `Agntree: Import Existing Sessions` | Import sessions from ~/.claude |
| `Agntree: Activate Workspace` | Activate VS Code workspace for worktree folder |
| `Agntree: Open in New Window` | Open worktree in new VS Code window |
| `Agntree: Refresh Workspaces` | Refresh the workspaces tree |
| `Agntree: Refresh Changes` | Refresh the changes panel |
| `Agntree: Open Diff` | Open diff view for a changed file |

## Architecture

```
src/
├── extension.ts              # Extension entry point
├── types.ts                  # TypeScript interfaces and types
├── commands/
│   ├── repository.ts         # Repository management commands
│   ├── worktree.ts           # Worktree commands
│   ├── chat.ts               # Session commands
│   └── quickActions.ts       # Quick action commands
├── providers/
│   ├── WorkspacesTreeProvider.ts   # Main sidebar tree view
│   ├── ChangesTreeProvider.ts      # Changes panel tree view
│   └── QuickActionsTreeProvider.ts # Quick actions panel tree view
└── services/
    ├── StorageService.ts     # Persistent storage (globalState)
    ├── GitService.ts         # Git operations (worktrees, diffs)
    ├── TerminalManager.ts    # VS Code terminal management
    ├── ClaudeSessionService.ts    # Claude session discovery & parsing
    └── SessionWatcher.ts     # Watches for new sessions, auto-naming
```

### Data Flow

1. **Repository Added** → Stored in VS Code's globalState
2. **Worktrees Detected** → GitService runs `git worktree list --porcelain`
3. **Session Created** → TerminalManager spawns terminal with `claude` CLI
4. **Session Linked** → Session links to Claude Code's session ID for `--resume`

### Storage

Data is persisted using VS Code's `globalState` API:
- Repositories list
- Sessions with metadata:
  - `claudeSessionId` - Links to Claude Code's session for `--resume`
  - `baseCommit` - Git commit SHA when session started (for change tracking)
  - `createdAt` / `lastAccessedAt` - Timestamps for ordering and display
  - `status` - Session state (`active`, `idle`, `closed`)
- Active worktree ID (persists across extension host restarts)
- Active session ID

## Development

### Setup

```bash
npm install
npm run compile
```

### Development Mode

Press `F5` in VS Code to launch the Extension Development Host with the extension loaded.

### Build Commands

```bash
npm run compile      # Build the extension
npm run watch        # Build with auto-rebuild on changes
npm run lint         # Run ESLint
npx @vscode/vsce package  # Package as .vsix
```

## How It Works

### Session Discovery

Claude Code stores sessions in `~/.claude/projects/<encoded-path>/*.jsonl`. The extension:
1. Encodes the worktree path to match Claude's format (replacing `/` with `-`)
2. Scans for `.jsonl` session files
3. Parses session metadata (ID, summary, timestamps, message count)
4. Allows importing sessions into the extension with multi-select

### Terminal Integration

When opening a session:
1. Extension checks for an existing terminal for this session (reuses if found)
2. If no terminal exists, spawns a new VS Code terminal
3. Terminal runs `claude --resume <sessionId>` (or just `claude` for new sessions)
4. Terminal state is tracked for the "running" indicator
5. Terminal names follow the format: `Agntree: <session-name>`

**Terminal Sync**: When you switch between terminal tabs, the corresponding session is automatically selected in the tree view and the Changes panel updates.

### Workspace Switching

When auto-switch is enabled and you select a worktree from a different repository:
1. Active worktree/session IDs are saved to `globalState` storage
2. VS Code switches the workspace folder via `updateWorkspaceFolders()`
3. Extension host restarts (VS Code limitation)
4. On restart, the extension restores the saved selection from storage
5. The tree item is revealed and selected

**Note**: You can disable auto-switch to prevent the flickering, then use "Activate Workspace" from the context menu when needed.

## Technical Details

### Worktree ID Generation

Worktree IDs are generated deterministically using a hash of `repoId + worktreePath`. This ensures:
- The same worktree always gets the same ID
- IDs are stable across extension restarts
- Sessions can reliably link to their parent worktree

### File Watchers

**Changes Panel**: Uses a file watcher with 500ms debounce to auto-refresh when files change in the active worktree.

**Branch Switch Detection**: The Workspaces panel watches `.git/HEAD` and `.git/worktrees/*/HEAD` files for all registered repositories. When you switch branches (via `git checkout` or `git switch`), the tree automatically refreshes to show the updated branch name.

### Session States

Sessions have three possible status values:
- `active` - Currently running in a terminal
- `idle` - Has a session but not running
- `closed` - Session ended

### Auto-Naming Behavior

When a new session is created:
1. A `SessionWatcher` monitors `~/.claude/projects/` for new session files
2. It waits up to 60 seconds for a session to appear
3. Once found, it extracts the first user message or summary as the session name
4. The session is automatically renamed in the tree view

## Troubleshooting

### Extension Not Showing

- Ensure the extension is installed and enabled
- Check the Output panel for errors (View → Output → select "Log (Extension Host)")

### Claude CLI Not Found

- Ensure Claude Code CLI is installed: `claude --version`
- Ensure it's available in your PATH

### Sessions Not Importing

- Verify sessions exist in `~/.claude/projects/`
- Check that the path encoding matches the worktree path

### Changes Not Updating

- Click the refresh button in the Changes panel
- Ensure you have uncommitted changes in the selected worktree

### Flickering on Worktree Selection

- Disable auto-switch: Settings → `agntree.autoSwitchWorkspaceFolder`
- Use "Switch to Workspace" from context menu when you need to switch

## License

MIT

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run lint` to check for issues
5. Submit a pull request

## Acknowledgments

- Built for use with [Claude Code](https://claude.ai/code) by Anthropic
- Uses VS Code's Extension API for deep IDE integration
