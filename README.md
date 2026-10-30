# Agntree — Session & Worktree Manager for Claude Code, Codex & opencode

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/subhashkhileri.agntree?label=VS%20Code%20Marketplace&logo=visual-studio-code&color=blue)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/subhashkhileri.agntree?label=Installs&color=green)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/subhashkhileri.agntree?label=Rating)](https://marketplace.visualstudio.com/items?itemName=subhashkhileri.agntree)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**One sidebar for every AI coding session.**

Agntree is a free, open-source VS Code extension that gives [Claude Code](https://claude.ai/code), [OpenAI Codex](https://github.com/openai/codex), and [opencode](https://opencode.ai) a visual workflow across folders, repositories, and git worktrees. Resume any conversation with one click, fork it to explore a second approach, and review exactly what the agent changed — without hunting for session IDs or juggling terminals.

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

Every Claude Code, Codex, and opencode session is grouped by the folder or repository it runs in, and by worktree when there is one. Rows stay in creation order — opening, resuming, or starring a session never moves it — so the list under your cursor stays put. Star the ones you return to, search across the whole repository, or import sessions that already exist on disk.

### Resume without remembering IDs

Click a session and Agntree opens the agent’s native CLI with the right session ID and working directory. If the session is already open in its agent’s VS Code UI, the click focuses that panel instead of starting a second CLI. The **Open Session in Terminal** and **Open in … UI** hover actions override the click, and `agntree.defaultSessionSurface` chooses which surface the click prefers. Nothing is copied into a proprietary format; resume still belongs to the agent that created the session.

### Keep sessions started elsewhere in view

Agntree watches the native sessions for each folder and worktree. A session started outside Agntree — from a plain terminal, another window, or an agent’s own VS Code UI — appears in the tree by itself, named with the name the agent assigned it (Claude’s session title, Codex’s thread name, or opencode’s title). The first prompt is only a fallback when the agent has not named the session yet.

Every session row — imported or started in Agntree — ages out of the tree after `agntree.autoImport.retentionDays` quiet days (7 by default). A star keeps one indefinitely, and a chat that is open in a terminal or a native UI tab is never removed. Removing a session from the list also stops it from being imported again; a manual import clears that and starts a fresh window. Turn importing and retention off with `agntree.autoImport.enabled`; sessions Agntree launches are still linked.

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
3. Open the Agntree icon in the Activity Bar, add a folder or repository, and create your first session.

**Requirements:** VS Code 1.93+ or Cursor, Git, and one of the supported agent CLIs. Claude Code support requires **2.1.310 or newer**; older versions are unsupported. The [GitHub CLI](https://cli.github.com/) is optional and only needed for PR checkout.

To install from a VSIX or build from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

1. **Add a folder or repository.** Use **Add Local Folder or Repository…** — any folder works, even before it is a git repository — or **Clone from GitHub** from the Workspaces panel.
2. **Create a worktree.** Pick an existing branch or create a new one. Worktrees live in a dedicated `<repo>-worktrees/` folder. In a plain folder, skip this step; sessions run directly in the folder.
3. **Start a session.** Open the **New Session** menu on the worktree, or on the folder itself, and choose Claude Code, Codex, or opencode.
4. **Fork when you want to explore.** Right-click a session and choose **Fork Session** or **Fork to New Worktree**. The original stays intact.

Claude Code sessions can also open in the Claude Code extension’s native UI. Click the UI icon on a row, or choose **Open in Claude Code UI**; Agntree closes the terminal after confirmation and hands the exact session to the extension in the active editor group, where the terminal or your files are, instead of creating a new right-hand group. The matching row is selected and shown as active while its Claude UI tab is open, and switching back to a CLI terminal tab selects the CLI session again. The extension UI always runs in the first folder open in VS Code, so the handoff works when that folder is the session’s worktree. For another worktree, Agntree offers to open it in a new window. The UI action stays visible when the extension is missing so the menu can explain what to install.

Claude sessions can also be **started** in the UI from the New Session menu when the worktree is the first folder. Agntree creates the row immediately, opens a new conversation, and links the real session after the first prompt; until then the row says `new`. Starting in the terminal and switching to the UI after the first prompt remains the most direct path for another worktree.

Codex sessions can open the same way with **Open in Codex UI**. Agntree closes the terminal after confirmation and opens the thread in the Codex extension’s conversation panel in the active editor group. Codex panels carry their thread ID, so a panel restored after a reload or opened directly from the Codex extension is tracked too. Clicking the session’s row while that panel is open focuses it rather than starting a CLI. The panel resumes the thread in its own worktree, so there is no first-folder restriction.

A **new** Codex session in the UI is different: the extension starts it in the VS Code workspace project, so Agntree offers it when the worktree is the only folder in the window. The placeholder row links to the thread after the first prompt. For another worktree, start in the terminal and switch to the UI afterwards, or open that worktree in its own window.

## Everyday workflows

| I want to… | Do this |
| --- | --- |
| Resume a session | Click it in the Agntree sidebar (uses `agntree.defaultSessionSurface`) |
| Open a session in the terminal | Click the terminal icon, or right-click → **Open Session in Terminal** |
| Open a Claude Code session in the extension UI | Click the UI icon, or right-click → **Open in Claude Code UI** |
| Open a Codex session in the extension UI | Click the UI icon, or right-click → **Open in Codex UI** |
| Start a new agent session | Worktree or folder **New Session** menu → choose the agent and surface |
| Find an old session | Use **Search Sessions** or **Import Existing Sessions** |
| Try a different approach | Right-click a session → **Fork Session** |
| Explore without touching my branch | Right-click a session → **Fork to New Worktree** |
| Work on a pull request | Repository **Checkout PR** action |
| See what changed | Open the **Changes** panel for the active worktree |
| Work with files | Open the **All Files** panel |
| Open a plain terminal | Worktree or folder **Open Terminal** action |
| Merge a branch | Right-click a worktree → **Merge Branch Into This** |
| Reorder my workspace list | Right-click a repository or folder → **Move Up** / **Move Down** |

Removing a session from Agntree only removes it from the list. The native session remains with the agent and can be imported again.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `agntree.autoSwitchWorkspaceFolder` | `false` | Switch VS Code’s workspace folder when you select a worktree. |
| `agntree.focusOnStartup` | `false` | Focus Agntree when VS Code starts. |
| `agntree.defaultSessionSurface` | `terminal` | Where clicking a row opens a session, and which surface a New Session command prefers. `ui` uses the agent’s VS Code UI when it can and falls back to the terminal. |
| `agntree.autoImport.enabled` | `true` | Add recent native sessions started outside Agntree, including sessions started in an agent’s VS Code UI. |
| `agntree.autoImport.retentionDays` | `7` | Remove session rows from the tree after this many quiet days. Starred sessions are kept; native sessions are never deleted. |
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
| `Agntree: Add Local Folder or Repository…` | Add a folder or an existing git repository. |
| `Agntree: Clone from GitHub…` | Clone a repository and add it. |
| `Agntree: Create Worktree…` | Create a worktree from an existing or new branch. |
| `Agntree: Delete Worktree…` | Delete a worktree, optionally with its branch. |
| `Agntree: Checkout PR…` | Check out a GitHub pull request into a new worktree. |
| `Agntree: Merge Branch Into This` | Merge another branch into the selected worktree. |
| `Agntree: New Claude Code Session` | Start a Claude Code session in the configured surface. |
| `Agntree: New Claude Code Session in Terminal` | Start a Claude Code session in a terminal. |
| `Agntree: New Claude Code Session in Claude Code UI` | Start a Claude Code session in the extension UI. |
| `Agntree: New Codex Session` | Start a Codex session in the configured surface. |
| `Agntree: New Codex Session in Terminal` | Start a Codex session in a terminal. |
| `Agntree: New Codex Session in Codex UI` | Start a Codex session in the extension UI. |
| `Agntree: New opencode Session` | Start an opencode session. |
| `Agntree: Open Session` | Open or resume a session, or focus its open terminal or native UI. |
| `Agntree: Open Session in Terminal` | Open or focus a session in its terminal. |
| `Agntree: Open in Claude Code UI` | Open a linked Claude Code session in the Claude Code extension UI. |
| `Agntree: Open in Codex UI` | Open a linked Codex session in the Codex extension’s conversation panel. |
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

### Can I add a folder that is not a git repository?

Yes. **Add Local Folder or Repository…** accepts any folder, so you can start a scratch project, notes folder, or an empty directory and begin a session right away. Sessions run directly in the folder. If it later becomes a git repository — say you or an agent runs `git init` — Agntree notices, upgrades the row to a repository, and keeps its sessions bound to the new main worktree. Actions that need a repository — creating a worktree, merge, rebase, PR checkout — stay off the folder until then; **Fork to New Worktree** explains that there is no branch to fork into.

### How do I resume a Claude Code session?

Open Agntree, find the session in its repository and worktree, and click it. Agntree resumes it with the Claude Code CLI using the session’s native ID. The same workflow works for Codex and opencode.

### How do I find an old Claude Code session?

Use **Search Sessions** to browse native sessions across every worktree in a repository, or **Import Existing Sessions** to add one you already have on disk. Imported sessions keep their native identity, so they still resume from the CLI. Agntree reads Claude transcripts from `~/.claude/projects/`, or from the directory set in `CLAUDE_CONFIG_DIR` if you use a custom Claude profile.

### Which Claude Code versions are supported?

Agntree requires Claude Code **2.1.310 or newer**, the version its session, fork, and live-state interfaces are built on. Older versions are unsupported and are not detected or adapted to.

### Can I use the Claude Code extension’s chat UI instead of a terminal?

Yes, for an existing Claude Code session when its worktree is the first folder open in VS Code. Click the UI icon or right-click and choose **Open in Claude Code UI**. Agntree closes its terminal first, then opens the same session in the extension using your `claudeCode.preferredLocation`, in the active editor group rather than a new right-hand group. The matching Agntree row is selected and shown as active while the Claude UI tab is open; switching back to a CLI terminal tab selects the CLI session again. If the worktree is a different folder, Agntree offers to open it in a new window. A session without a transcript still starts in the terminal; after its first prompt it can move to the UI. The action stays visible when the extension is missing so it can explain what to install. Agntree maps the UI tabs it opened itself; a tab opened directly from the Claude extension is not mapped.

You can also start a new Claude session in the UI from the New Session menu when the worktree is the first folder. Agntree creates a placeholder row, opens a new conversation, and links the real session after the first prompt; the row keeps the harness-assigned session name.

### Can I use the Codex extension’s UI instead of a terminal?

Yes, for an existing Codex thread, when the Codex extension is installed. Click the UI icon or right-click the session and choose **Open in Codex UI**. Agntree closes its terminal after confirmation, then opens the thread in the Codex extension’s conversation panel in the active editor group. The thread keeps its own working directory, so it does not matter which folder is first in the VS Code window. The matching row is selected and shown as active while the panel is open, and Agntree tracks Codex panels by their thread ID, including panels restored after a reload or opened from the Codex extension itself. The Codex sidebar view is not an editor tab and is not tracked. The action stays visible when the extension is missing so it can explain what to install.

A new Codex session in the UI starts in the extension’s VS Code workspace project. Agntree offers it from the New Session menu when the worktree is the only folder in the window; the placeholder row links to the thread after the first prompt. For any other worktree, start in the terminal and switch to the UI after the first prompt.

### Do sessions started outside Agntree appear automatically?

Yes. Agntree scans the native sessions for each folder and worktree and adds recent ones it has not seen, named with the agent’s own session title (the first prompt is only a fallback). This covers a session started in a plain terminal, another VS Code window, or an agent’s own UI. Every row ages out after `agntree.autoImport.retentionDays` quiet days; a star keeps it indefinitely, and a chat open in a terminal or UI tab is never removed. You can turn importing and retention off with `agntree.autoImport.enabled`.

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
