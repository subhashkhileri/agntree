# Claude Workspaces

A VS Code extension for managing Claude Code CLI sessions across multiple git repositories and worktrees.

## Features

- **Multi-Repository Management** - Add and organize multiple git repositories in one place
- **Worktree Support** - Automatically detects and displays git worktrees for each repository
- **Chat Session Management** - Create, resume, rename, and remove Claude Code chat sessions
- **Session Import** - Import existing Claude Code sessions from `~/.claude/projects/` with multi-select support
- **Changes Panel** - View uncommitted changes for the selected worktree with inline diffs
- **Auto-Naming** - Chat sessions are automatically named based on their first prompt or summary
- **Workspace Switching** - Optionally switches VS Code workspace when selecting a worktree (configurable)
- **State Persistence** - Active worktree and chat selection persists across VS Code restarts
- **Session Previews** - Hover over chats to see the last 3 messages in a tooltip
- **Terminal Sync** - Switching between chat terminals auto-selects the corresponding chat in the tree
- **Inline Actions** - Quick action icons appear on hover for common operations

## Installation

### From VSIX (Recommended)

1. Download or build the `.vsix` file
2. In VS Code, open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Run `Extensions: Install from VSIX...`
4. Select the `claude-workspaces-x.x.x.vsix` file

### From Source

```bash
git clone <repository-url>
cd claude-workspaces
npm install
npm run compile
npx @vscode/vsce package
code --install-extension claude-workspaces-*.vsix
```

## Requirements

- VS Code 1.85.0 or higher
- [Claude Code CLI](https://claude.ai/code) installed and configured
- Git installed and available in PATH

## Usage

### Getting Started

1. Click the **Claude Workspaces** icon in the Activity Bar (left sidebar)
2. Click **Add Repository** to add your first git repository
3. The extension will automatically detect worktrees in the repository

### Managing Repositories

| Action | How To |
|--------|--------|
| Add Repository | Click the `+` button in the Workspaces panel title bar |
| Create Worktree | Hover over repository → Click `+` icon, or right-click → Create Worktree |
| Remove Repository | Hover over repository → Click `✕` icon, or right-click → Remove from Extension |

### Working with Worktrees

| Action | How To |
|--------|--------|
| Create Worktree | Right-click a repository → Create Worktree |
| New Chat | Hover over worktree → Click chat icon, or right-click → New Chat |
| Switch Workspace | Right-click a worktree → Switch to Workspace (when auto-switch is OFF) |
| Open in New Window | Right-click a worktree → Open in New Window |

### Managing Chat Sessions

| Action | How To |
|--------|--------|
| New Chat | Hover over worktree → Click `+` icon |
| Open/Resume Chat | Click on a chat session |
| Rename Chat | Hover over chat → Click edit icon |
| Remove Chat | Hover over chat → Click `✕` icon |
| Import Sessions | Right-click a worktree → Import Existing Sessions |

**Note**: Removing a chat only removes it from the extension's list. The Claude session files in `~/.claude/` are preserved and can be re-imported later.

### Viewing Changes

The **Changes** panel shows uncommitted changes for the currently selected worktree:

- Click on any file to open a side-by-side diff view
- Changes are auto-refreshed when files are modified
- Summary shows total files, additions, and deletions

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claude-workspaces.autoSwitchWorkspaceFolder` | `true` | Automatically switch VS Code's workspace folder when selecting a worktree. Disable to prevent flickering from extension host restart. |

You can toggle this setting directly from the tree view title bar using the sync icon.

## Tree View Icons

### Title Bar
- `+` - Add repository
- Sync icon - Toggle auto-switch workspace (shows current state)
- Refresh - Refresh tree

### Inline Actions (on hover)

| Item | Actions |
|------|---------|
| Repository | Create Worktree (`+`), Remove (`✕`) |
| Worktree | New Chat, Switch to Workspace (when auto-switch OFF) |
| Chat | Rename, Remove (`✕`) |

### Item Icons

**Repositories:**
- Blue folder icon

**Worktrees:**
- Yellow folder (opened) - Currently active workspace
- Green git-branch icon - Main branch
- Purple git-merge icon - Other worktrees

**Chats:**
- Green comment-discussion - Active/running chat
- Orange history icon - Resumable session (shows relative time)
- Gray comment icon - New chat (no session yet)

### Descriptions
- Repositories show total chat count or relative path
- Worktrees show "● open" if current workspace, plus chat counts
- Chats show "running", relative time, or "new"

## Commands

All commands are available in the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

| Command | Description |
|---------|-------------|
| `Claude Workspaces: Add Repository` | Add a git repository |
| `Claude Workspaces: Remove from Extension` | Remove repository from extension (files preserved) |
| `Claude Workspaces: Create Worktree` | Create a new git worktree |
| `Claude Workspaces: New Chat` | Start a new Claude Code session |
| `Claude Workspaces: Open Chat` | Open/resume a chat session |
| `Claude Workspaces: Rename Chat` | Rename a chat session |
| `Claude Workspaces: Remove from List` | Remove chat from list (session preserved) |
| `Claude Workspaces: Import Existing Sessions` | Import sessions from ~/.claude |
| `Claude Workspaces: Switch to Workspace` | Switch VS Code to worktree folder |
| `Claude Workspaces: Open in New Window` | Open worktree in new VS Code window |
| `Claude Workspaces: Refresh Workspaces` | Refresh the workspaces tree |
| `Claude Workspaces: Refresh Changes` | Refresh the changes panel |
| `Claude Workspaces: Open Diff` | Open diff view for a changed file |

## Architecture

```
src/
├── extension.ts              # Extension entry point
├── types.ts                  # TypeScript interfaces and types
├── commands/
│   ├── repository.ts         # Repository management commands
│   ├── worktree.ts           # Worktree commands
│   └── chat.ts               # Chat session commands
├── providers/
│   ├── WorkspacesTreeProvider.ts  # Main sidebar tree view
│   └── ChangesTreeProvider.ts     # Changes panel tree view
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
3. **Chat Created** → TerminalManager spawns terminal with `claude` CLI
4. **Session Linked** → Chat links to Claude Code's session ID for `--resume`

### Storage

Data is persisted using VS Code's `globalState` API:
- Repositories list
- Chat sessions with metadata:
  - `claudeSessionId` - Links to Claude Code's session for `--resume`
  - `baseCommit` - Git commit SHA when session started (for change tracking)
  - `createdAt` / `lastAccessedAt` - Timestamps for ordering and display
  - `status` - Session state (`active`, `idle`, `closed`)
- Active worktree ID (persists across extension host restarts)
- Active chat ID

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

When opening a chat:
1. Extension checks for an existing terminal for this chat (reuses if found)
2. If no terminal exists, spawns a new VS Code terminal
3. Terminal runs `claude --resume <sessionId>` (or just `claude` for new sessions)
4. Terminal state is tracked for the "running" indicator
5. Terminal names follow the format: `Claude: <chat-name>`

**Terminal Sync**: When you switch between terminal tabs, the corresponding chat is automatically selected in the tree view and the Changes panel updates.

### Workspace Switching

When auto-switch is enabled and you select a worktree from a different repository:
1. Active worktree/chat IDs are saved to `globalState` storage
2. VS Code switches the workspace folder via `updateWorkspaceFolders()`
3. Extension host restarts (VS Code limitation)
4. On restart, the extension restores the saved selection from storage
5. The tree item is revealed and selected

**Note**: You can disable auto-switch to prevent the flickering, then use "Switch to Workspace" from the context menu when needed.

## Technical Details

### Worktree ID Generation

Worktree IDs are generated deterministically using a hash of `repoId + worktreePath`. This ensures:
- The same worktree always gets the same ID
- IDs are stable across extension restarts
- Chat sessions can reliably link to their parent worktree

### File Watcher

The Changes panel uses a file watcher with 500ms debounce to auto-refresh when files change.

### Chat Session States

Chat sessions have three possible status values:
- `active` - Currently running in a terminal
- `idle` - Has a session but not running
- `closed` - Session ended

### Auto-Naming Behavior

When a new chat is created:
1. A `SessionWatcher` monitors `~/.claude/projects/` for new session files
2. It waits up to 60 seconds for a session to appear
3. Once found, it extracts the first user message or summary as the chat name
4. The chat is automatically renamed in the tree view

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

- Disable auto-switch: Settings → `claude-workspaces.autoSwitchWorkspaceFolder`
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
