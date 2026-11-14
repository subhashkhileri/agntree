# Notifications

Agntree tells you when a coding agent finishes a turn and, for Claude Code, when it is waiting on a permission prompt or a question. With several agents running, you can stay in one session and let the others call you back.

There are three signals: the mark on each session row, a notification, and a shortcut that takes you to the agent that has waited longest.

## The mark on a session row

The agent's mark on each row is live:

| Mark | Meaning |
| --- | --- |
| The mark pulses | The agent is working |
| The mark with a green dot | The turn finished |
| A grey mark | The session is closed |
| The mark with a hollow ring | New, no prompt sent yet |

A glance at the tree shows which agents are busy and which are done. The pulse respects your system's reduced-motion setting.

## Notifications

When an open session that you are not looking at needs attention, VS Code shows a notification with an **Open** button that takes you to the session.

| Notification | When | Agents |
| --- | --- | --- |
| `<session> finished` | The agent ended its turn | Claude Code, Codex, opencode, Pi |
| `<session> needs your input` | The agent is waiting on a permission prompt or a question | Claude Code |

The notification names the repository and worktree, so you know which agent is calling.

Notifications are deliberately quiet:

- You are never notified about the session you are looking at.
- A session that is waiting on you sends "needs your input", not a second "finished".
- "Needs your input" is sent at most once a minute per session.
- A finished turn notifies once. The next prompt re-arms it.
- After a window reload, sessions that were already waiting do not notify again.

On macOS, Agntree can also show a system banner while VS Code is in the background. The banner is not clickable; the notification inside VS Code has the **Open** button.

## Go to the next session that needs you

Press `Ctrl+Alt+N` (`Ctrl+Cmd+N` on macOS), or choose **Go to Next Session That Needs You** in the Agntree `…` menu.

Agntree opens the session that has waited longest since it finished a turn or asked you something while you were elsewhere. Visiting a session clears it from the queue, so pressing the shortcut again walks through the rest. When nothing is waiting, it says so.

The shortcut works with notifications turned off, which makes it a good replacement if you find them distracting. One exception: Agntree checks whether Claude Code is waiting on you only while `agntree.notifications.onNeedsInput` is on.

## Turn notifications on or off

Open **Agntree Settings…** from the Agntree `…` menu. Under **Notifications**:

| Setting | Default | Controls |
| --- | --- | --- |
| [`agntree.notifications.enabled`](reference/settings.md#notifications) | On | Every notification. Turn it off and the three below have no effect |
| `agntree.notifications.onTurnEnd` | On | "Finished" notifications |
| `agntree.notifications.onNeedsInput` | On | "Needs your input" notifications for Claude Code |
| `agntree.notifications.nativeBanner` | On | The macOS system banner |

## How Agntree knows

Agntree installs no hooks and does not edit any agent's configuration.

- **Claude Code:** the end of the session transcript shows whether a turn is running, and `claude agents --json` reports a session that is waiting on you. A background subagent that is still running keeps the session marked as working.
- **Codex:** the session's rollout file records when a task starts, completes, or is aborted.
- **opencode:** its API reports when a session last went idle.
- **Pi:** the last entry in the session record shows whether the agent is mid-turn.

Only sessions that are open in a terminal or panel are watched, every few seconds, and only the new end of each file is read.

opencode, Codex, and Pi do not expose a "waiting for permission" state, so "needs your input" is Claude Code only for now.

## Related

- [Sessions](sessions.md)
- [Troubleshooting: no notification](troubleshooting.md#i-get-no-notifications)
