# Claude Workspaces

A VS Code extension for managing Claude Code CLI sessions across multiple git repositories and worktrees.

## Features

- **Multi-Repository Management** - Add and organize multiple git repositories in one place
- **Worktree Support** - Automatically detects and displays git worktrees for each repository
- **Chat Session Management** - Create, resume, rename, and delete Claude Code chat sessions
- **Session Import** - Import existing Claude Code sessions from `~/.claude/projects/` with multi-select support
- **Changes Panel** - View uncommitted changes for the selected worktree with inline diffs
- **Auto-Naming** - Chat sessions are automatically named based on their first prompt or summary (60-second timeout)
- **Workspace Switching** - Automatically switches VS Code workspace when selecting a worktree
- **State Persistence** - Active worktree selection persists across VS Code restarts
- **Session Previews** - Hover over chats to see the last 3 messages in a tooltip
- **Stable Chat Ordering** - Chats are sorted by creation time (newest first) and don't re-order on selection

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
| Hide Repository | Right-click a repository → Hide Repository |
| Show Hidden | Click the eye icon in the title bar |
| Remove Permanently | Right-click a repository → Remove Repository Permanently |

### Working with Worktrees

| Action | How To |
|--------|--------|
| Add Worktree | Right-click a repository → Add Worktree |
| Open in New Window | Right-click a worktree → Open in New Window |
| Switch Workspace | Click on any worktree to switch VS Code's workspace folder |

### Managing Chat Sessions

| Action | How To |
|--------|--------|
| New Chat | Right-click a worktree → New Chat |
| Open/Resume Chat | Click on a chat session |
| Rename Chat | Right-click a chat → Rename Chat |
| Delete Chat | Right-click a chat → Delete Chat |
| Import Sessions | Right-click a worktree → Import Existing Sessions |

### Viewing Changes

The **Changes** panel shows uncommitted changes for the currently selected worktree:

- Click on any file to open a side-by-side diff view
- Changes are auto-refreshed when files are modified
- Summary shows total files, additions, and deletions

## Tree View Icons

### Repositories
- Blue folder icon for repositories

### Worktrees
- Yellow folder (opened) - Currently active workspace
- Green git-branch icon - Main branch
- Purple git-merge icon - Other worktrees

### Chats
- Green comment-discussion - Active/running chat
- Orange history icon - Resumable session (shows relative time: "5m ago", "2h ago")
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
| `Claude Workspaces: Hide Repository` | Hide a repository from view |
| `Claude Workspaces: Show Hidden Repositories` | Restore hidden repositories |
| `Claude Workspaces: Remove Repository Permanently` | Delete a repository |
| `Claude Workspaces: Add Worktree` | Create a new git worktree |
| `Claude Workspaces: New Chat` | Start a new Claude Code session |
| `Claude Workspaces: Open Chat` | Open/resume a chat session |
| `Claude Workspaces: Rename Chat` | Rename a chat session |
| `Claude Workspaces: Delete Chat` | Delete a chat session |
| `Claude Workspaces: Import Existing Sessions` | Import sessions from ~/.claude |
| `Claude Workspaces: Refresh Workspaces` | Refresh the workspaces tree |
| `Claude Workspaces: Refresh Changes` | Refresh the changes panel |
| `Claude Workspaces: Open Diff` | Open diff view for a changed file |
| `Claude Workspaces: Open in New Window` | Open worktree in new VS Code window |

### Context Menus

Right-click context menus show different options based on the item type:

| Context | Available Actions |
|---------|------------------|
| Repository | Hide, Remove Permanently, Add Worktree |
| Worktree | New Chat, Import Sessions, Open in New Window |
| Chat | Rename, Delete |
| Changed File | Open Diff |

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
- Repositories and their visibility state (`hidden` flag)
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

### Project Structure

```
claude-workspaces/
├── src/                  # TypeScript source files
├── out/                  # Compiled JavaScript (generated)
├── resources/icons/      # Extension icons
├── .claude/skills/       # Claude Code skills for this project
├── package.json          # Extension manifest
├── tsconfig.json         # TypeScript configuration
├── esbuild.js            # Build script
└── CLAUDE.md             # Instructions for Claude Code
```

## How It Works

### Session Discovery

Claude Code stores sessions in `~/.claude/projects/<encoded-path>/*.jsonl`. The extension:
1. Encodes the worktree path to match Claude's format (replacing `/` with `-`)
2. Scans for `.jsonl` session files
3. Parses session metadata (ID, summary, timestamps, message count)
4. Allows importing sessions into the extension with multi-select

#### Session File Format

Each `.jsonl` file contains one JSON object per line:
- `type: "summary"` - Contains session summary and title
- `type: "user"` / `type: "assistant"` - Conversation messages
- Session ID is derived from the filename (without `.jsonl` extension)

### Terminal Integration

When opening a chat:
1. Extension checks for an existing terminal for this chat (reuses if found)
2. If no terminal exists, spawns a new VS Code terminal
3. Terminal runs `claude --resume <sessionId>` (or just `claude` for new sessions)
4. Terminal state is tracked for the "running" indicator
5. Terminal names follow the format: `Claude: <chat-name>`

#### Terminal Reuse Logic

- Terminals are tracked by chat ID
- If a terminal already exists for a chat, it's shown instead of creating a new one
- When a terminal is closed, it's removed from tracking
- Active terminals show a green "running" indicator in the tree view

### Workspace Switching

When selecting a worktree from a different repository:
1. Active worktree ID is saved to `globalState` storage
2. VS Code switches the workspace folder via `updateWorkspaceFolders()`
3. Extension host restarts (unavoidable VS Code behavior)
4. On restart, the extension restores the saved worktree ID from storage
5. Changes panel is automatically updated to show the correct worktree's changes

**Note**: The extension host restart is a VS Code limitation when switching workspace folders. All in-memory state is lost, which is why the active worktree ID is persisted to storage.

## Technical Details

### Worktree ID Generation

Worktree IDs are generated deterministically using a hash of `repoId + worktreePath`. This ensures:
- The same worktree always gets the same ID
- IDs are stable across extension restarts
- Chat sessions can reliably link to their parent worktree

### File Watcher

The Changes panel uses a file watcher with 500ms debounce to auto-refresh when files change. This prevents excessive refreshes during rapid file modifications.

### Chat Session States

Chat sessions have three possible status values:
- `active` - Currently running in a terminal
- `idle` - Has a session but not running
- `closed` - Session ended

### Path Normalization

The extension normalizes paths to handle:
- Symlinks (resolved to real paths)
- Subdirectory detection (finds parent git root)
- Cross-platform path separators

### Repository Deletion

- **Hide (Soft Delete)**: Repository is hidden from view but data is preserved. Can be restored via "Show Hidden Repositories".
- **Remove Permanently (Hard Delete)**: Repository is removed from storage. Note: Associated chat sessions are preserved and can be re-imported if the repository is added again.

### Auto-Naming Behavior

When a new chat is created:
1. A `SessionWatcher` monitors `~/.claude/projects/` for new session files
2. It waits up to 60 seconds for a session to appear
3. Once found, it extracts the first user message or summary as the chat name
4. The chat is automatically renamed in the tree view

### Configuration

This extension currently has no user-configurable settings. All behavior is automatic.

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
