# Agntree — Agent Session & Worktree Manager for VS Code & Cursor

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/subhashkhileri.agntree?label=VS%20Code%20Marketplace&logo=visual-studio-code&color=blue)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/subhashkhileri.agntree?label=Installs&color=green)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/subhashkhileri.agntree?label=Rating)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub stars](https://img.shields.io/github/stars/subhashkhileri/agntree?style=social)](https://github.com/subhashkhileri/agntree)

> **The missing session manager for coding agents.** Resume, fork, search, and organize your [Claude Code](https://claude.ai/code) and [opencode](https://opencode.ai) sessions across git worktrees — all from a single VS Code sidebar.
> Works with VS Code & Cursor. Extensible architecture — contributions for Codex, Copilot, Cline, Aider, and more are welcome.

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

If you use Claude Code or opencode across multiple projects and branches, you know the pain:

- **Lost sessions** — finding and resuming sessions means digging through `~/.claude/projects/` or a local database, or remembering session IDs
- **No session overview** — there's no way to see all your conversations across repos and branches at a glance
- **Manual worktree juggling** — running parallel sessions on different branches requires manually creating worktrees and terminals
- **No session forking** — exploring an alternative approach means manually copying session data and setting up a new worktree
- **Blind changes** — tracking what the agent modified requires constant `git diff` commands

Agntree gives Claude Code and opencode a visual session manager inside VS Code — resume any session with one click, fork conversations to explore alternatives, and see all changes across worktrees in a single sidebar.

## Features

### Agent Session Management

Create, resume, rename, and organize sessions for Claude Code and opencode side by side. Each session links to its harness's native session ID, so resume, forking, and auto-naming keep working exactly as they do in the CLI. Import existing sessions with multi-select, or search every session across a repository's worktrees.

- **Claude Code** — sessions discovered from `~/.claude/projects/`; resume with `claude --resume <id>`, fork with `--fork-session`.
- **opencode v2** — sessions discovered through the `opencode` CLI/API (`ses_...` IDs); resume with `opencode --session <id>`, fork and move natively through the API.

### Git Worktree Integration

Automatically detects git worktrees for each repository. Create new worktrees with one click — choose an existing branch or create a new one from any base branch. Worktrees are organized in a dedicated `<repo>-worktrees/` folder.

### Session Forking — Branch Your Conversations

Fork an ongoing session to explore alternative approaches — just like branching your code. Fork within the same worktree or create a new worktree with all uncommitted changes carried over. The full conversation history is preserved so the agent can resume from the forked point. Claude copies its session files; opencode uses its native fork + move API.

### PR Checkout

Check out any GitHub pull request into a new worktree with one click. Works for PRs from both same-repo branches and forks — the `gh` CLI handles remote resolution automatically. Available from the repository's inline actions or context menu.

### Built-in Changes Tracking

View staged and unstaged changes for the active worktree without leaving the sidebar. Inline stage, unstage, and discard actions. Click any file to open a side-by-side diff. Section headers show file count and total additions/deletions. Discarding names the worktree and spells out what will be deleted; the confirmation for untracked files is explicit because `git clean` is permanent.

### All Files Panel

Browse, create, rename, delete, copy, cut, and paste files and folders for the active worktree — all from the sidebar. Directories sort before files, and names sort naturally (`file2` before `file10`). Hover a row for its worktree-relative path. Click the search icon in the panel toolbar to open VS Code's native Search scoped to that worktree's directory.

Every file operation is scoped to the active worktree: paths outside it are refused, deletes go to the Trash, creating never overwrites an existing file, and pasting a folder into itself is rejected. Destructive actions are recorded with a timestamp in the **Agntree Operations** output channel.

## Demo

<!-- TODO: Add GIF demos -->
<!-- ![Managing AI coding sessions across multiple git repositories](media/demo-sessions.gif) -->
<!-- ![Fork AI agent conversation to new git worktree](media/demo-fork.gif) -->

## Quick Start

1. Install [Claude Code CLI](https://claude.ai/code) and/or [opencode](https://opencode.ai) if you haven't already
2. Install [Agntree](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree) from the VS Code Marketplace
3. Click the Agntree icon in the Activity Bar, add a repository, and start managing your Claude Code and opencode sessions

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
- At least one supported harness:
  - [Claude Code CLI](https://claude.ai/code) installed and configured, or
  - [opencode v2+](https://opencode.ai) installed and on `PATH`
- Git installed and available in PATH
- [GitHub CLI (`gh`)](https://cli.github.com/) for PR checkout feature (optional)

## Agntree vs Manual Agent Workflow

| Task | Without Agntree | With Agntree |
|------|----------------|--------------|
| Resume a session | Find the session ID, run `claude --resume <id>` or `opencode --session <id>` | Click a session in the sidebar |
| Find old sessions | Browse `~/.claude/projects/` or the opencode database | Search Sessions across all worktrees |
| Run an agent on a new branch | Manually create worktree, cd, run the CLI | One-click worktree + session creation |
| Fork a conversation | Copy session data or use CLI flags, create worktree, set up manually | Right-click → Fork Session |
| Track what the agent changed | Run `git diff` repeatedly | Built-in changes panel with inline diffs |
| Common prompts | Search shell history | Star sessions and resume them in one click |
| Manage sessions across repos | Separate windows per project | All repositories in one sidebar |

## Supported AI Coding Agents

Agntree treats each CLI agent as a **harness**. Two harnesses are supported today, with full session management for both: launch/resume, import, repository search, fork (same worktree and to a new worktree), auto-naming, and tooltips.

| Agent | Session Storage | Session Management | Status |
|-------|-----------------|--------------------|--------|
| [Claude Code](https://claude.ai/code) | `~/.claude/projects/` (JSONL) | Full support | Available |
| [opencode](https://opencode.ai) v2+ | opencode's local database, accessed via CLI/API | Full support (no recap) | Available |
| [Codex](https://github.com/openai/codex) | — | — | Adapter seam ready, contributions welcome |
| [GitHub Copilot](https://github.com/features/copilot) | — | — | Contributions welcome |
| [Cline](https://github.com/cline/cline) | — | — | Contributions welcome |
| [Aider](https://aider.chat) | — | — | Contributions welcome |

### opencode setup

1. Install opencode v2 and make sure `opencode` runs from a terminal.
2. Open the worktree in Agntree and use **New Session → New opencode Session**.
3. Agntree links the chat to the new `ses_...` ID automatically after your first prompt and renames the chat from the opencode title.

Agntree talks to opencode through `opencode api` / `opencode session export` rather than reading its SQLite database, so opencode upgrades don't break it. If the opencode background service is unavailable, Agntree retries with `--standalone`.

If a CLI is not on `PATH`, set its command in `agntree.harnessCommands` (for example a wrapper script path).

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
| New Session (Claude Code or opencode) | Hover over worktree → Click `+` icon → choose harness |
| Open/Resume Session | Click on a session |
| Rename Session | Hover over session → Click edit icon |
| Remove Session | Right-click a session → Remove from List |
| Fork Session | Right-click a session → Fork Session (creates branch in same worktree) |
| Fork to New Worktree | Right-click a session → Fork to New Worktree (creates worktree with changes) |
| Import Sessions | Right-click a worktree → Import Existing Sessions |
| Search Sessions | Click the search icon in the Workspaces view title, or right-click a repository → Search Sessions |

**Note**: Removing a session only removes it from the extension's list. The native session (Claude JSONL or opencode session) is preserved and can be re-imported later.

**Fork Session to New Worktree**: Creates a new git worktree, copies uncommitted changes from the current worktree, prepares the fork in the new directory, and opens it. Claude copies its session files; opencode forks and moves the session through its API. Useful for exploring alternative approaches while preserving your current work.

Forks are numbered rather than prefixed: forking `Fix icons` creates `Fix icons (1)`, and forking that session creates `Fix icons (1) (1)`. Sibling forks increment the suffix so names stay unique.

Session rows stay quiet: the harness mark identifies the agent, a short relative time (`16m`, `2h`, `3d`) or `new` shows recency, and a star marks pins. Hover a session for its brief — the latest recap or last exchange, plus message count, model, agent, tokens, and cost.

**Search Sessions** lists every session across the repository's worktrees, grouped by worktree with the main worktree first. Rows are one line — harness mark, title, recency, and size; imported sessions carry a check. Highlighting a row expands it with a brief: the latest recap or last exchange, then message count, model, agent, tokens, and cost. On opencode that preview comes from one `session export`, fetched only for rows you inspect.

### Session Notifications

Agntree tells you when a session stops working, so you do not have to hunt through terminals:

- **Finished** — the session completed its turn. Works for every harness: Claude is read from the transcript's `stop_reason`, opencode from the `time.idle` field in `session.list`.
- **Needs you** — Claude paused on a permission prompt or an idle question. This needs a one-time opt-in: run **Agntree: Enable 'Needs Input' Notifications (Install Claude Code Hooks)** (also in the Workspaces `…` menu). It adds a `Stop` and a `Notification` hook to `~/.claude/settings.json` next to your existing hooks, backs the file up once, and appends events to `~/.agntree/attention.jsonl`. Remove them again with **Agntree: Remove Claude Code Notification Hooks**.

Delivery is hybrid. A VS Code notification with an **Open** button always appears (unless you are typing in that very session); on macOS a system banner is also shown while VS Code is not focused. The banner cannot be clicked and macOS attributes it to the helper, so the VS Code notification remains the actionable one. opencode has no equivalent hook, so it reports finished turns only.

The hook command is POSIX shell, so the opt-in is intended for macOS and Linux. Windows still gets finished-turn notifications without any setup.

Notifications are per turn (a new prompt re-arms them), sessions with closed terminals are ignored, and each session is reported at most once a minute for input prompts.

### Viewing Changes

The **Changes** panel shows uncommitted changes for the currently selected worktree:

- **Staged Changes** section shows files ready to commit; **Changes** shows unstaged modifications
- Section headers carry a green check (staged) or yellow edit icon, a file count, and total `+/-` line counts
- Nested files show their directory in the row (`src/utils · M +2 -1`), so same-named files stay distinguishable; hover for the full path and status
- Click on any file to open a diff view (toggle on/off)
- Inline actions: Stage (`+`), Unstage (`-`), Discard changes
- Changes are auto-refreshed when files are modified
- Panel title shows active worktree and repository name

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agntree.autoSwitchWorkspaceFolder` | `false` | Automatically switch VS Code's workspace folder when selecting a worktree. Disable to prevent flickering from extension host restart. |
| `agntree.focusOnStartup` | `false` | Focus the Agntree panel automatically when VS Code starts, instead of the default File Explorer. |
| `agntree.harnessCommands` | `{"claude":"claude","opencode":"opencode"}` | Override the CLI command for each harness (PATH wrappers, custom installs). |
| `agntree.notifications.enabled` | `true` | Show notifications when a session stops working. |
| `agntree.notifications.onTurnEnd` | `true` | Notify when a session finishes responding. |
| `agntree.notifications.onNeedsInput` | `true` | Notify when a Claude session waits on a permission prompt or question (requires the attention hooks). |
| `agntree.notifications.nativeBanner` | `true` | On macOS, also show a system banner while VS Code is not focused. |

Toggle `autoSwitchWorkspaceFolder` and `focusOnStartup` directly from the Workspaces panel toolbar — no need to open Settings.

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
| `Agntree: New Claude Code Session` | Start a new Claude Code session |
| `Agntree: New opencode Session` | Start a new opencode session |
| `Agntree: Open Session` | Open/resume a session |
| `Agntree: Rename Session` | Rename a session |
| `Agntree: Remove from List` | Remove session from list (native session preserved) |
| `Agntree: Fork Session` | Fork a session in the same worktree |
| `Agntree: Fork Session to New Worktree` | Fork session to a new worktree with changes |
| `Agntree: Import Existing Sessions` | Import sessions from any installed harness |
| `Agntree: Search Sessions` | Search all sessions across a repository's worktrees |
| `Agntree: Enable 'Needs Input' Notifications (Install Claude Code Hooks)` | Add the optional Claude hooks for permission/idle alerts |
| `Agntree: Remove Claude Code Notification Hooks` | Remove only the Agntree hook entries |
| `Agntree: Checkout PR` | Check out a GitHub PR into a new worktree |
| `Agntree: Activate Workspace` | Activate VS Code workspace for worktree folder |
| `Agntree: Open in New Window` | Open worktree in new VS Code window |
| `Agntree: Refresh Workspaces` | Refresh the workspaces tree |
| `Agntree: Refresh Changes` | Refresh the changes panel |
| `Agntree: Open Diff` | Open diff view for a changed file |
| `Agntree: Search in Files` | Open VS Code Search scoped to the active worktree directory |

## Architecture

```
src/
├── extension.ts              # Extension entry point
├── types.ts                  # TypeScript interfaces and types
├── harnesses/
│   ├── types.ts              # HarnessAdapter contract (sessions, fork)
│   ├── ClaudeHarness.ts      # Claude Code adapter
│   ├── OpencodeHarness.ts    # opencode v2 adapter
│   ├── HarnessRegistry.ts    # Installed detection, lookup, default harness
│   └── commandUtils.ts       # CLI resolution and shell quoting
├── commands/
│   ├── repository.ts         # Repository management commands
│   ├── worktree.ts           # Worktree commands
│   └── chat.ts               # Session commands
├── providers/
│   ├── WorkspacesTreeProvider.ts   # Main sidebar tree view
│   ├── ChangesTreeProvider.ts      # Changes panel tree view
│   └── FilesTreeProvider.ts        # All Files panel tree view
└── services/
    ├── StorageService.ts           # Persistent storage (globalState)
    ├── GitService.ts               # Git operations (worktrees, diffs)
    ├── TerminalManager.ts          # VS Code terminal management
    ├── ClaudeSessionService.ts     # Claude session discovery & parsing
    ├── ClaudeSessionWatcher.ts     # Watches for new Claude sessions, auto-naming
    ├── OpencodeSessionService.ts   # opencode CLI/API client (list, fork, move, export)
    ├── OpencodeSessionWatcher.ts   # Links new opencode sessions, auto-naming
    └── HarnessWatcherRegistry.ts   # Routes watcher events by harness
```

### Data Flow

1. **Repository Added** → Stored in VS Code's globalState
2. **Worktrees Detected** → GitService runs `git worktree list --porcelain`
3. **Session Created** → TerminalManager asks the chat's harness adapter for a launch command (`claude` or `opencode --session <id>`)
4. **Session Linked** → The harness watcher captures the native session ID and auto-names the chat
5. **Metadata/Tooltip** → Read through the adapter (Claude JSONL parsing, opencode API/list with cached previews)

### Extensibility

Every harness implements `HarnessAdapter` (`src/harnesses/types.ts`): installed detection, launch command, resumability, discovery, metadata, previews, and fork/move. Adding a new agent means implementing that interface, registering an adapter in `extension.ts`, and adding a watcher for new-session linkage. No core session-management code needs to change. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## FAQ

### What is Agntree?

Agntree is a free, open-source VS Code extension that serves as a session manager for CLI coding agents. It provides a visual sidebar to create, resume, fork, search, and organize your Claude Code and opencode sessions across git repositories and worktrees — replacing the need to manually track session IDs or browse native session storage.

### Does Agntree work with Cursor?

Yes. Cursor is a fork of VS Code and supports VS Code extensions. Agntree works on both VS Code and Cursor without any modification.

### Can I use Agntree with Copilot, Cline, or Aider?

Agntree currently provides full session management for Claude Code and opencode. The architecture is extensible and open-source — contributions to add support for Codex, GitHub Copilot, Cline, Aider, Windsurf, Continue.dev, and other AI coding agents are welcome. See the [Contributing](#contributing) section.

### What are git worktrees and why use them with coding agents?

Git worktrees let you check out multiple branches of the same repository into separate directories simultaneously. This is powerful with CLI agents because you can run separate sessions on separate branches in parallel, without conflicts. Agntree makes creating worktrees and launching agent sessions on them effortless.

### How is session forking different from starting a new session?

When you fork a session, the full conversation history is copied to the new session. The agent retains all context from the original conversation and can continue from that point. Starting a new session means the agent has no memory of previous work. Forking is ideal for exploring alternative approaches while keeping the original session intact.

### Is Agntree free?

Yes. Agntree is free and open-source under the MIT license. You need your own harness subscription/credentials — for example a [Claude Code](https://claude.ai/code) plan (Claude Pro, Max, or Team) or an opencode provider configuration — to use the session management features.

## Roadmap

Agntree's roadmap is community-driven. Key areas of interest:

- **Multi-agent support** — Extensible architecture for Copilot, Cline, Aider, Windsurf, and other AI coding agents (contributions welcome)
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

Built for use with [Claude Code](https://claude.ai/code), [opencode](https://opencode.ai), and other CLI coding agents. Agntree is an independent open-source project and is not affiliated with or endorsed by Anthropic or opencode.
