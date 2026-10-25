# Agntree — Session & Worktree Manager for Claude Code, Codex & opencode

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/subhashkhileri.agntree?label=VS%20Code%20Marketplace&logo=visual-studio-code&color=blue)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/subhashkhileri.agntree?label=Installs&color=green)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/subhashkhileri.agntree?label=Rating)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**One sidebar for every AI coding session.**

Agntree is a free, open-source VS Code extension that gives [Claude Code](https://claude.ai/code), [OpenAI Codex](https://github.com/openai/codex), and [opencode](https://opencode.ai) a visual workflow across repositories and git worktrees. Resume any conversation with one click, fork it to explore a second approach, and review exactly what the agent changed — without hunting for session IDs or juggling terminals.

Works in **VS Code** and **Cursor**.

[**Install from the VS Code Marketplace**](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree) · [Website](https://subhashkhileri.github.io/agntree) · [Discussions](https://github.com/subhashkhileri/agntree/discussions)

<!-- TODO: add the hero demo GIF here once it is recorded. -->

## Coding agents are great at the work. The workflow around them is not.

- **Sessions are hidden.** Resuming means remembering an ID or digging through app data.
- **Parallel branches are manual.** You create a worktree, open a terminal, start the agent, and keep track of which window is which.
- **Forking loses context.** Trying another approach means starting over or copying session files by hand.
- **Changes are invisible.** You run `git diff` repeatedly to see what the agent actually touched.
- **Finished turns are easy to miss.** You find out by staring at a terminal.

Agntree puts that workflow in the sidebar you already have open.

## What Agntree does

### Keep every session in one place

Every Claude Code, Codex, and opencode session is grouped by repository and worktree. Star the ones you return to, search across the whole repository, or import sessions that already exist on disk.

### Resume without remembering IDs

Click a session and Agntree opens the agent’s native CLI with the right session ID and working directory. Nothing is copied into a proprietary format; resume still belongs to the agent that created the session.

### Fork a conversation, not just a branch

Fork an ongoing session to explore an alternative approach. The full conversation history is preserved, so the agent continues from the same context. Fork in the same worktree, or create a new worktree and carry your uncommitted changes with it.

### Run agents in parallel on real worktrees

Create a worktree from an existing branch or a new one, start a session there, and keep every branch and conversation visible in the same tree. Check out a GitHub pull request into a worktree with one action.

### Review and manage the changes

The **Changes** panel shows staged and unstaged files for the active worktree, with inline diffs, stage/unstage/discard actions, and clear file and line counts. The **All Files** panel lets you browse, create, rename, copy, move, and delete files without leaving the sidebar.

### Know when the agent needs you

Agntree can notify you when a turn finishes, and Claude Code can tell you when it is waiting on a permission prompt or a question. The notification includes an **Open** action that takes you straight back to the session.

## Works with Claude Code, Codex, and opencode

| Agent | New | Resume | Import & search | Fork | Notifications |
| --- | --- | --- | --- | --- | --- |
| [Claude Code](https://claude.ai/code) | ✓ | ✓ | ✓ | ✓ | Finished turns, plus “needs input” alerts |
| [OpenAI Codex](https://github.com/openai/codex) | ✓ | ✓ | ✓ | ✓ | Finished turns |
| [opencode](https://opencode.ai) v2+ | ✓ | ✓ | ✓ | ✓ | Finished turns |

All three keep their native session identity, so conversations remain usable from the CLI and nothing is copied into a proprietary format. Agntree reads each agent through its supported interface rather than taking over its storage.

## Install

1. Install the CLI for at least one supported agent and make sure it runs from a terminal.
2. Install **Agntree** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree), or search for **Agntree** in the Extensions panel.
3. Open the Agntree icon in the Activity Bar, add a repository, and create your first session.

**Requirements:** VS Code 1.93+ or Cursor, Git, and one of the supported agent CLIs. Claude Code support requires **2.1.310 or newer**; older versions are unsupported. The [GitHub CLI](https://cli.github.com/) is optional and only needed for PR checkout.

To install from a VSIX or build from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

1. **Add a repository.** Use **Add Local Repository** or **Clone from GitHub** from the Workspaces panel.
2. **Create a worktree.** Pick an existing branch or create a new one. Worktrees live in a dedicated `<repo>-worktrees/` folder.
3. **Start a session.** Open the worktree’s **New Session** menu and choose Claude Code, Codex, or opencode.
4. **Fork when you want to explore.** Right-click a session and choose **Fork Session** or **Fork to New Worktree**. The original stays intact.

## Everyday workflows

| I want to… | Do this |
| --- | --- |
| Resume a session | Click it in the Agntree sidebar |
| Start a new agent session | Worktree **New Session** menu → choose the agent |
| Find an old session | Use **Search Sessions** or **Import Existing Sessions** |
| Try a different approach | Right-click a session → **Fork Session** |
| Explore without touching my branch | Right-click a session → **Fork to New Worktree** |
| Work on a pull request | Repository **Checkout PR** action |
| See what changed | Open the **Changes** panel for the active worktree |
| Work with files | Open the **All Files** panel |
| Open a plain terminal | Worktree **Open Terminal** action |
| Merge a branch | Right-click a worktree → **Merge Branch Into This** |

Removing a session from Agntree only removes it from the list. The native session remains with the agent and can be imported again.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agntree.autoSwitchWorkspaceFolder` | `false` | Switch VS Code’s workspace folder when you select a worktree. |
| `agntree.focusOnStartup` | `false` | Focus Agntree when VS Code starts. |
| `agntree.harnessCommands` | `{"claude":"claude","opencode":"opencode","codex":"codex"}` | Override the CLI command for each agent. |
| `agntree.notifications.enabled` | `true` | Show session notifications. |
| `agntree.notifications.onTurnEnd` | `true` | Notify when a turn finishes. |
| `agntree.notifications.onNeedsInput` | `true` | Notify when Claude Code waits for input. Reads `claude agents --json`; no hooks are installed. |
| `agntree.notifications.nativeBanner` | `true` | On macOS, also show a system banner while VS Code is unfocused. |

## Commands

The main commands are also available from the Command Palette (`Cmd+Shift+P` /
`Ctrl+Shift+P`):

| Command | What it does |
| --- | --- |
| `Agntree: Add Local Repository…` | Add an existing git repository. |
| `Agntree: Clone from GitHub…` | Clone a repository and add it. |
| `Agntree: Create Worktree…` | Create a worktree from an existing or new branch. |
| `Agntree: Delete Worktree…` | Delete a worktree, optionally with its branch. |
| `Agntree: Checkout PR…` | Check out a GitHub pull request into a new worktree. |
| `Agntree: Merge Branch Into This` | Merge another branch into the selected worktree. |
| `Agntree: New Claude Code Session` | Start a Claude Code session. |
| `Agntree: New Codex Session` | Start a Codex session. |
| `Agntree: New opencode Session` | Start an opencode session. |
| `Agntree: Open Session` | Open or resume a session. |
| `Agntree: Fork Session` | Fork a session in the same worktree. |
| `Agntree: Fork to New Worktree…` | Fork a session and its uncommitted changes into a new worktree. |
| `Agntree: Import Existing Sessions…` | Import sessions from any installed agent. |
| `Agntree: Search Sessions…` | Search sessions across a repository’s worktrees. |
| `Agntree: Rename Session…` | Rename a session. |
| `Agntree: Remove from List…` | Remove a session from Agntree without deleting it natively. |
| `Agntree: Open in New Window` | Open a worktree in a new VS Code window. |
| `Agntree: Open Diff` | Open the diff for a changed file. |

## Notifications

Finished-turn notifications work for every supported agent. **Needs input** alerts are enabled by default for Claude Code and come from `claude agents --json`; Agntree does not install hooks or modify `~/.claude/settings.json`. If you installed the old Agntree hooks, you can delete those entries by hand — Agntree no longer reads or manages them.

Notifications are skipped for the session you are already looking at, re-armed by the next prompt, and rate-limited for input prompts. On macOS, an optional system banner appears while VS Code is unfocused.

## FAQ

### What is Agntree?

Agntree is a free, open-source VS Code extension that manages Claude Code, OpenAI Codex, and opencode sessions across git repositories and worktrees. It gives you one place to create, resume, fork, search, and organize agent conversations.

### How do I resume a Claude Code session?

Open Agntree, find the session in its repository and worktree, and click it. Agntree resumes it with the Claude Code CLI using the session’s native ID. The same workflow works for Codex and opencode.

### How do I find an old Claude Code session?

Use **Search Sessions** to browse native sessions across every worktree in a repository, or **Import Existing Sessions** to add one you already have on disk. Imported sessions keep their native identity, so they still resume from the CLI. Agntree reads Claude transcripts from `~/.claude/projects/`, or from the directory set in `CLAUDE_CONFIG_DIR` if you use a custom Claude profile.

### Which Claude Code versions are supported?

Agntree requires Claude Code **2.1.310 or newer**, the version its session, fork, and live-state interfaces are built on. Older versions are unsupported and are not detected or adapted to.

### Does Agntree replace the Claude Code CLI?

No. Agntree is a front end for the CLIs you already use. Starting or resuming a session opens the agent’s own terminal UI with the right session ID and working directory, and every session remains usable outside VS Code.

### Can I fork a Claude Code, Codex, or opencode conversation?

Yes. Forking preserves the conversation history in a new session, so the agent continues with the original context. Claude Code forks natively with `--fork-session`, so the fork stays in the destination worktree without copying transcripts. You can fork in the same worktree or create a new worktree for the fork.

### How do I run multiple AI coding agents in parallel?

Create a worktree for each branch or task, then start a session in each one. Agntree keeps the worktrees, sessions, and terminals grouped together so you can switch without losing track of which agent is doing what.

### Does Agntree work with Cursor?

Yes. Cursor supports VS Code extensions, and Agntree works there without modification.

### Does Agntree work with GitHub Copilot, Cline, or Aider?

Not yet. Claude Code, Codex, and opencode have full support today. Agntree is open source and built so new agents can be added — contributions for other agents are welcome.

### Does Agntree send my code or sessions anywhere?

No. Agntree has no telemetry and stores its own state locally in VS Code. Network work happens only through tools you already use: `git`, `gh`, and the agent CLIs themselves.

### Is Agntree free?

Yes. Agntree is free and open-source under the MIT license. You still need your own account or subscription for the agent you use.

## Contributing

Agntree is open source and contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the PR process, [AGENTS.md](AGENTS.md) for the working agreement, and [ARCHITECTURE.md](ARCHITECTURE.md) for the subsystem map.

The [roadmap](ROADMAP.md) tracks direction and deferred experiments. Ideas and questions belong in [GitHub Discussions](https://github.com/subhashkhileri/agntree/discussions) or [issues](https://github.com/subhashkhileri/agntree/issues).

## License

[MIT](LICENSE) — free for personal and commercial use.

---

Agntree is an independent open-source project and is not affiliated with or endorsed by Anthropic, OpenAI, or opencode.
