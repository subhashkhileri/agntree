# Claude Code session manager for VS Code

Agntree gives Claude Code a session manager inside VS Code. Every Claude Code session is listed under its repository and git worktree, resumes with one click, forks into a new branch, and tells you when it finishes or is waiting on a permission prompt. Agntree drives the `claude` CLI you already have; it does not replace it.

## Requirements

- **Claude Code 2.1.310 or newer.** Older versions are not supported. Check with `claude --version`.
- The `claude` command on your `PATH`. If it is somewhere else, or you start it through a wrapper, set [`agntree.harnessCommands.claude`](../reference/settings.md#agent-commands).
- Optional: the [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), to open sessions in its chat panel.

## What works

| Feature | Claude Code |
| --- | --- |
| Start and resume sessions | Yes |
| Sessions started outside Agntree appear automatically | Yes |
| Fork, here or into a new worktree | Yes, with Claude Code's own `--fork-session` |
| Working and finished marks, finished-turn notifications | Yes |
| "Needs your input" notifications | Yes, for permission prompts and questions |
| Find Session | Searched, and can run the search |
| Open in the agent's VS Code panel | Yes, the Claude Code extension |

## Run Claude Code sessions in parallel

Claude Code works on one directory at a time, so two sessions in the same checkout edit the same files. Give each task a git worktree instead:

1. Hover your repository in Agntree and select **Create Worktree…**.
2. Hover the new worktree and select **New Session**, then **New Claude Code Session**.
3. Repeat for the next task.

Each session now has its own branch and directory, and the sidebar shows which are working and which have finished. The full walkthrough is in [Run multiple agents in parallel with git worktrees](../guides/parallel-agents-git-worktrees.md).

## Resume a Claude Code session

Click the session. Agntree runs `claude --resume <session-id>` in the session's worktree. To do the same by hand, right-click the session and choose **Copy Resume Command**.

To find a session you cannot place, use [Find Session](../find-session.md) and describe what you did in it.

## Know when Claude Code needs you

Agntree notifies you when Claude Code finishes a turn, and when it stops to ask for a permission or to ask you a question. `Ctrl+Alt+N` (`Ctrl+Cmd+N` on macOS) jumps to the session that has waited longest.

A session with a background subagent still running stays marked as working until that subagent is done.

Agntree installs no hooks and never edits `~/.claude/settings.json`. It reads the end of the session transcript and asks `claude agents --json` which sessions are waiting.

## Use the Claude Code panel

A Claude Code session can move between its terminal and the Claude Code extension's chat panel. Select the panel icon on a session, or choose **Open in Claude Code UI**. The extension runs conversations in the first folder open in the VS Code window, so the session's worktree must be that folder; otherwise Agntree offers to open the worktree in a new window. See [Agent panels](../agent-panels.md).

## What Agntree runs

| Action | Command |
| --- | --- |
| New session | `claude --session-id <new-uuid>` |
| Resume | `claude --resume <session-id>` |
| Fork | `claude --resume <source-id> --fork-session --session-id <new-uuid>` |
| Sessions waiting on you | `claude agents --json` |
| Find Session | `claude --print` with only the `Read`, `Grep`, and `Glob` tools, no MCP servers, and no saved session |

Agntree chooses the session ID before it starts Claude Code, so a row is always linked to exactly the session it launched, even with several new sessions in one worktree.

## Where sessions come from

Agntree reads Claude Code's own transcripts under `~/.claude/projects/`, or under the directory in `CLAUDE_CONFIG_DIR` if you use a custom profile. It writes nothing there.

- A session is named with Claude Code's own title for it. Your first prompt is the fallback until Claude Code has named it.
- A worktree opened through a symlink finds its sessions.
- Claude Code writes a transcript only after the first prompt, so a session shows `new` until then.

The session tooltip shows your last prompt, Claude Code's last reply, and when the session was last active.

## Related

- [Sessions](../sessions.md)
- [Fork a session](../fork-sessions.md)
- [Notifications](../notifications.md)
- [Troubleshooting](../troubleshooting.md)
