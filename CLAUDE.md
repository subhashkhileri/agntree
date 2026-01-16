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

- **StorageService** - Persists repositories and chat sessions to VS Code's globalState
- **GitService** - Git operations: worktree listing/creation, commit tracking, diff generation
- **TerminalManager** - Spawns and manages VS Code terminals running `claude` CLI
- **ClaudeSessionService** - Discovers existing Claude Code sessions from `~/.claude/projects/`

### Tree Providers (`src/providers/`)

- **WorkspacesTreeProvider** - Main sidebar tree: Repository → Worktree → Chat hierarchy
- **ChangesTreeProvider** - Shows git diff for the active chat session

### Commands (`src/commands/`)

Commands are registered in `package.json` under `contributes.commands` and implemented in:
- `repository.ts` - Add/hide/remove repositories
- `worktree.ts` - Create worktrees, open in new window
- `chat.ts` - Create/open/rename/delete chats, import existing sessions

### Data Flow

1. User adds a repository → stored in globalState
2. GitService detects worktrees via `git worktree list --porcelain`
3. User creates a chat → TerminalManager spawns terminal with `claude --resume <sessionId>`
4. Chat sessions link to Claude Code's session files for resumption

### Key Types (`src/types.ts`)

- `Repository` - Git repo with optional `hidden` flag for soft-delete
- `Worktree` - Branch checked out in a directory
- `ChatSession` - Links to Claude Code's `claudeSessionId` for `--resume`

## Claude Code Session Discovery

Sessions are stored in `~/.claude/projects/<encoded-path>/*.jsonl`. The `ClaudeSessionService` parses these files to extract session IDs, summaries, and timestamps for import into the extension.
