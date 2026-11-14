# Agent panels

A Claude Code or Codex session can run in two places: the agent's CLI in a terminal, or the chat panel of the agent's own VS Code extension. Agntree lets you open a session in either, move it between them, and choose which one a click prefers. The session is the same in both places.

opencode and Pi sessions open in a terminal.

## What you need

| Panel | Extension | Extension ID |
| --- | --- | --- |
| Claude Code UI | [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) | `anthropic.claude-code` |
| Codex UI | [Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) | `openai.chatgpt` |

The panel actions are shown even when the extension is not installed, so they can tell you what to install.

## Open an existing session in a panel

Hover a Claude Code or Codex session and select the panel icon, or right-click and choose **Open in Claude Code UI** or **Open in Codex UI**.

If the session is running in a terminal, Agntree asks before closing it, waits for the process to stop, and then opens the same session in the panel. Two processes never write to one session.

The panel opens in the editor group you are in, where the terminal or your files are, rather than in a new group on the right. While it is open, the session's row is selected and marked as active, and its turn state and [notifications](notifications.md) keep working.

A session needs at least one prompt before a panel can open it. A session that is still `new` starts in the terminal first.

## Go back to the terminal

Choose **Open Session in Terminal** on the row. Agntree asks before closing the panel tab, then resumes the session in the CLI.

## Start a new session in a panel

In the **New Session** menu, choose **New Claude Code Session in Claude Code UI** or **New Codex Session in Codex UI**. Agntree adds a row straight away, opens a new conversation, and links the row to the real session after your first prompt.

## Choose what a click does

By default, clicking a session opens its terminal. To prefer the panel, set [`agntree.defaultSessionSurface`](reference/settings.md#sessions) to **Agent's VS Code panel**.

| Setting | A click on a session |
| --- | --- |
| **Terminal** (default) | Opens or focuses its terminal |
| **Agent's VS Code panel** | Opens the panel when it can, otherwise the terminal |

Whatever the setting, a click on a session that is already open goes to where it is open: a live terminal is focused, an open panel is revealed. The **Open Session in Terminal** and panel actions always do what they say.

## Which folder the panel runs in

The two extensions decide where a conversation runs, which sets what Agntree can offer.

| | Claude Code UI | Codex UI |
| --- | --- | --- |
| Open an existing session | The session's worktree must be the **first folder** open in the VS Code window | Any worktree; the thread keeps its own directory |
| Start a new session | The worktree must be the first folder | The worktree must be the **only folder** in the window |
| Otherwise | Agntree offers **Open in New Window** for that worktree | Agntree offers **Open in New Window** for that worktree |

When a panel cannot run in the right folder, Agntree explains why and offers to open the worktree in its own window. It never starts a conversation in the wrong directory. Starting in the terminal and moving to the panel after the first prompt always works for Codex, and works for Claude Code once the worktree is the window's first folder.

## Which panels Agntree follows

- **Codex:** every Codex conversation panel is recognized, including panels restored after a reload and panels you opened from the Codex extension itself. The Codex sidebar view is not an editor tab and is not followed.
- **Claude Code:** panels that Agntree opened are recognized. A Claude Code tab that you opened from the extension directly, or that VS Code restored after a reload, is not matched to its row.

## Related

- [Claude Code](agents/claude-code.md)
- [Codex](agents/codex.md)
- [Sessions](sessions.md)
