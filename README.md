# Agntree — AI Coding Agent Session Manager for VS Code & Cursor

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/subhashkhileri.agntree?label=VS%20Code%20Marketplace&logo=visual-studio-code&color=blue)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/subhashkhileri.agntree?label=Installs&color=green)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/subhashkhileri.agntree?label=Rating)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/subhashkhileri/agntree?style=social)](https://github.com/subhashkhileri/agntree)

> Manage AI coding agent sessions across git repositories and worktrees.
> Supports Claude Code on VS Code & Cursor. Extensible architecture — contributions for Copilot, Cline, Aider, and more are welcome.

<!-- TODO: Add hero GIF showing full workflow demo -->
<!-- ![Agntree — Managing AI coding sessions across multiple git repositories](media/hero-demo.gif) -->

## Table of Contents

- [Why Agntree?](#why-agntree)
- [Features](#features)
- [Demo](#demo)
- [Quick Start](#quick-start)
- [Installation](#installation)
- [Agntree vs Manual Workflow](#agntree-vs-manual-workflow)
- [Supported AI Coding Agents](#supported-ai-coding-agents)
- [Usage Guide](#usage-guide)
- [Settings](#settings)
- [Commands](#commands)
- [Architecture](#architecture)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Why Agntree?

Working with AI coding agents across multiple projects and branches is painful:

- **Context switching** between AI sessions means losing track of conversations and progress
- **Parallel development** with AI assistants requires juggling multiple terminals and session IDs
- **Multi-repo AI workflows** have no unified interface — each project is isolated
- **Session forking** to explore alternatives means manually copying session files and worktrees
- **Tracking changes** across AI-assisted branches requires constant `git diff` commands

Agntree solves all of this with a single VS Code sidebar panel.

## Features

### AI Agent Session Management

Create, resume, rename, and organize AI coding sessions. Every session links to a Claude Code session ID for seamless `--resume` support. Import existing sessions from `~/.claude/projects/` with multi-select. Search all sessions across a repository's worktrees with the repository-level Search Sessions command.

### Git Worktree Integration

Automatically detects git worktrees for each repository. Create new worktrees with one click — choose an existing branch or create a new one from any base branch. Worktrees are organized in a dedicated `<repo>-worktrees/` folder.

### Session Forking — Branch Your AI Conversations

Fork an ongoing AI session to explore alternative approaches — just like branching your code. Fork within the same worktree or create a new worktree with all uncommitted changes carried over. The full conversation history is preserved so the AI can resume from the forked point.

### PR Checkout

Check out any GitHub pull request into a new worktree with one click. Works for PRs from both same-repo branches and forks — the `gh` CLI handles remote resolution automatically. Available from the repository's inline actions or context menu.

### One-Click Quick Actions

Run Claude prompts or shell commands with a single click from the sidebar. Configure custom actions in settings — use Claude's headless mode with specific tools, or run any shell command. Play/stop controls with output displayed in a dedicated channel.

### Built-in Changes Tracking

View staged and unstaged changes for the active worktree without leaving the sidebar. Inline stage, unstage, and discard actions. Click any file to open a side-by-side diff. Section headers show file count and total additions/deletions.

## Demo

<!-- TODO: Add GIF demos -->
<!-- ![Managing AI coding sessions across multiple git repositories](media/demo-sessions.gif) -->
<!-- ![Fork AI agent conversation to new git worktree](media/demo-fork.gif) -->
<!-- ![Run AI coding prompts with one click using quick actions](media/demo-quick-actions.gif) -->

## Quick Start

1. Install [Agntree](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree) from the VS Code Marketplace
2. Click the Agntree icon in the Activity Bar and add a repository
3. Create a session on any worktree and start coding with AI

## Installation

### From VS Code Marketplace

Install directly from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree) — search for **"Agntree"** in the Extensions panel, or click the link.

Works on both **VS Code** and **Cursor** (Cursor is a VS Code fork and supports VS Code extensions).

### From VSIX

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

### Requirements

- VS Code 1.85.0+ or Cursor
- [Claude Code CLI](https://claude.ai/code) installed and configured
- Git installed and available in PATH
- [GitHub CLI (`gh`)](https://cli.github.com/) for PR checkout feature (optional)

## Agntree vs Manual Workflow

| Task | Without Agntree | With Agntree |
|------|----------------|--------------|
| Switch AI sessions | Manually find session IDs, run `claude --resume <id>` | Click a session in the sidebar |
| Parallel branches | Juggle terminals, manually create worktrees | One-click worktree creation |
| Fork a conversation | Copy session files, create worktree, set up manually | Right-click → Fork Session |
| Track changes | Run `git diff` repeatedly | Built-in changes panel with inline diffs |
| Common prompts | Retype or search history | One-click quick actions |
| Multi-repo management | Separate windows per project | All repositories in one sidebar |

## Supported AI Coding Agents

Agntree currently supports Claude Code with full session management. The architecture is open-source and extensible — contributions to add support for other AI coding agents are welcome.

| Agent | IDE Support | Session Management | Status |
|-------|-------------|-------------------|--------|
| [Claude Code](https://claude.ai/code) | VS Code, Cursor | Full support | Available |
| [GitHub Copilot](https://github.com/features/copilot) | — | — | Contributions welcome |
| [Cline](https://github.com/cline/cline) | — | — | Contributions welcome |
| [Aider](https://aider.chat) | — | — | Contributions welcome |
| [Windsurf](https://codeium.com/windsurf) | — | — | Contributions welcome |
| [Continue.dev](https://continue.dev) | — | — | Contributions welcome |

See [CONTRIBUTING.md](CONTRIBUTING.md) for a guide on adding support for new agents.

## Usage Guide

### Getting Started

1. Click the **Agntree** icon in the Activity Bar (left sidebar)
2. Click **Add Local Repository** or **Clone from GitHub** to add your first repository
3. The extension automatically detects worktrees in the repository

### Managing Repositories

| Action | How To |
|--------|--------|
| Add Local Repository | Click the folder icon in the Workspaces panel title bar |
| Clone from GitHub | Click the cloud icon in the Workspaces panel title bar |
| Create Worktree | Hover over repository → Click `+` icon, or right-click → Create Worktree |
| Remove Repository | Hover over repository → Click `×` icon, or right-click → Remove from Extension |

**Clone from GitHub**: Enter a GitHub URL (`https://github.com/owner/repo`) or shorthand (`owner/repo`), select a parent folder, and the repository will be cloned and added automatically.

### Working with Worktrees

| Action | How To |
|--------|--------|
| Create Worktree | Right-click a repository → Create Worktree |
| Checkout PR | Hover over repository → Click PR icon, or right-click → Checkout PR |
| New Session | Hover over worktree → Click session icon, or right-click → New Session |
| Open Terminal | Hover over worktree → Click terminal icon |
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
| Remove Session | Hover over session → Click `×` icon |
| Fork Session | Right-click a session → Fork Session (creates branch in same worktree) |
| Fork to New Worktree | Right-click a session → Fork Session to New Worktree (creates worktree with changes) |
| Import Sessions | Right-click a worktree → Import Existing Sessions |
| Search Sessions | Hover over repository → Click search icon, or right-click → Search Sessions |

**Note**: Removing a session only removes it from the extension's list. The Claude session files in `~/.claude/` are preserved and can be re-imported later.

**Fork Session to New Worktree**: Creates a new git worktree, copies uncommitted changes from the current worktree, copies the Claude session data, and opens a forked session in the new worktree. Useful for exploring alternative approaches while preserving your current work.

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
- **Commit** — Runs Claude with a commit prompt
- **Git Status** — Runs `git status` command

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
| `agntree.autoSwitchWorkspaceFolder` | `false` | Automatically switch VS Code's workspace folder when selecting a worktree. Disable to prevent flickering from extension host restart. |
| `agntree.quickActions` | See above | Array of quick actions. Each action needs `name` and either `command` (shell) or `prompt` + `allowedTools` (Claude). |

You can toggle auto-switch directly from the tree view title bar using the sync icon.

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
| `Agntree: Search Sessions` | Search all sessions across a repository's worktrees |
| `Agntree: Checkout PR` | Check out a GitHub PR into a new worktree |
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

### Extensibility

The architecture separates agent-specific logic (currently in `ClaudeSessionService`) from the core session management. Adding support for a new AI coding agent involves implementing a new session service that conforms to the same interface. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## FAQ

### What is Agntree?

Agntree is a free, open-source VS Code extension that provides a unified interface to manage AI coding agent sessions across git repositories and worktrees. It lets you create, resume, fork, and organize AI conversations alongside your git workflow.

### Does Agntree work with Cursor?

Yes. Cursor is a fork of VS Code and supports VS Code extensions. Agntree works on both VS Code and Cursor without any modification.

### Can I use Agntree with Copilot, Cline, or Aider?

Agntree currently supports Claude Code. The architecture is extensible and open-source — contributions to add support for GitHub Copilot, Cline, Aider, Windsurf, Continue.dev, and other AI coding agents are welcome. See the [Contributing](#contributing) section.

### What are git worktrees and why use them with AI coding?

Git worktrees let you check out multiple branches of the same repository into separate directories simultaneously. This is useful with AI coding agents because you can have separate AI sessions on separate branches, running in parallel, without conflicts. Agntree makes creating and managing worktrees effortless.

### How is session forking different from starting a new session?

When you fork a session, the full conversation history is copied to the new session. The AI agent retains all context from the original conversation and can continue from that point. Starting a new session means the AI has no memory of previous work. Forking is ideal for exploring alternative approaches while keeping the original session intact.

### Is Agntree free?

Yes. Agntree is free and open-source under the MIT license. You need your own Claude Code subscription to use the AI session features.

## Roadmap

Agntree's roadmap is community-driven. Key areas of interest:

- **Multi-agent support** — Extensible architecture for Copilot, Cline, Aider, Windsurf, and other AI coding agents (contributions welcome)
- **Custom workflow templates** — Sharable quick action configurations for teams
- **Team collaboration features** — Shared session management across team members
- **Session analytics** — Track AI-assisted development metrics across projects

Have ideas? [Open an issue](https://github.com/subhashkhileri/agntree/issues) or [start a discussion](https://github.com/subhashkhileri/agntree/discussions).

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines, including a section on adding support for new AI coding agents.

Quick start:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run `npm run lint` to check for issues
5. Submit a pull request

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=subhashkhileri/agntree&type=Date)](https://star-history.com/#subhashkhileri/agntree&Date)

## License

[MIT](LICENSE) — free for personal and commercial use.

---

Built for use with [Claude Code](https://claude.ai/code) by Anthropic. Agntree is an independent open-source project and is not affiliated with Anthropic.
