# Getting started

Install Agntree from the VS Code Marketplace, add a folder or repository, and click **+** to start a Claude Code, Codex, opencode, or Pi session. This page walks through that, start to finish.

## Requirements

- **VS Code 1.93 or newer**, or an editor built on it such as Cursor.
- **Git**, for worktrees, the Changes panel, and pull requests. A plain folder without git works too.
- **At least one supported agent CLI**, installed and working in a terminal:

  | Agent | Command | Notes |
  | --- | --- | --- |
  | [Claude Code](https://claude.ai/code) | `claude` | Version 2.1.310 or newer |
  | [Codex](https://developers.openai.com/codex) | `codex` | |
  | [opencode](https://opencode.ai) | `opencode` | Version 2 or newer |
  | [Pi](https://pi.dev) | `pi` | |

- **GitHub CLI** (`gh`), optional. Agntree uses it to check out pull requests and to show a PR number on a branch.

Agntree is developed and tested on macOS and Linux. Windows support is partial: commands that Agntree types into a terminal are quoted for POSIX shells.

## Install

**From VS Code:** open the Extensions view (`Ctrl+Shift+X`, `Cmd+Shift+X` on macOS), search for **Agntree**, and select **Install**.

**From a terminal:**

```bash
code --install-extension subhashkhileri.agntree
```

**In Cursor and other VS Code forks:** search for **Agntree** in the Extensions view. If it is not listed there, download the `.vsix` file from the [latest release](https://github.com/subhashkhileri/agntree/releases/latest) and run **Extensions: Install from VSIX…** from the Command Palette.

Agntree needs no account and no configuration.

## Add a folder or repository

1. Select the Agntree icon in the Activity Bar. `Ctrl+Alt+A` (`Ctrl+Cmd+A` on macOS) opens it from anywhere.
2. In the **Workspaces** view, choose **Add Local Folder or Repository…** and pick a folder. To start from GitHub, choose **Clone from GitHub…** and enter a URL or `owner/repo`.

The folder appears as a row. A git repository expands to its worktrees, starting with the one you already have (usually `main`). A folder without git works as well: sessions run directly in it, and if it becomes a repository later, Agntree notices.

Add as many folders and repositories as you like. They do not have to be open in VS Code.

## Start your first session

1. Hover the worktree (or the folder) and select **New Session** (**+**).
2. Choose an agent. Only installed agents are listed.

A terminal opens in that worktree with the agent running, and a row named **New Session** appears with `new` beside it. Type your first prompt. The agent then creates the session, and Agntree renames the row to the name the agent gave it.

To skip the menu next time, choose **Set Default Agent…** in that same menu. From then on **+** starts your agent in one click, and `Ctrl+Alt+Enter` (`Ctrl+Cmd+Enter` on macOS) starts one in the worktree you are working in.

## Come back to a session

Close the terminal, or quit VS Code entirely. The session stays in the sidebar. Click its row and Agntree resumes it in the agent's own CLI, in the right directory, with the full conversation.

Sessions you already had before installing Agntree show up too: Agntree lists recent sessions the agents hold for each folder you add. See [Sessions](sessions.md#sessions-started-outside-agntree).

## Next steps

- [Create a worktree](worktrees.md#create-a-worktree) so a second agent can work on another branch at the same time.
- [Fork a session](fork-sessions.md) to try a different approach.
- [Turn on the notifications you want](notifications.md), then press `Ctrl+Alt+N` to jump to the agent that needs you.
- Learn the [keyboard shortcuts](reference/keyboard-shortcuts.md).

If an agent is missing from the **New Session** menu, see [Troubleshooting](troubleshooting.md#an-agent-is-missing-from-the-new-session-menu).
