# opencode session manager for VS Code

Agntree gives opencode a session manager inside VS Code. Every opencode session is listed under its repository and git worktree, resumes with one click, forks into a new branch, and notifies you when a turn finishes. Agntree drives the `opencode` CLI you already have, through its documented CLI and API.

## Requirements

- [opencode](https://opencode.ai) **version 2 or newer**, working in a terminal.
- The `opencode` command on your `PATH`. If it is somewhere else, set [`agntree.harnessCommands.opencode`](../reference/settings.md#agent-commands).

## What works

| Feature | opencode |
| --- | --- |
| Start and resume sessions | Yes |
| Sessions started outside Agntree appear automatically | Yes |
| Fork, here or into a new worktree | Yes, with opencode's own fork |
| Working and finished marks, finished-turn notifications | Yes |
| "Needs your input" notifications | Not available. opencode exposes no pending-permission state |
| Find Session | Its sessions are searched. opencode cannot run the search |
| Open in the agent's VS Code panel | No. Sessions open in a terminal |

## Run opencode sessions in parallel

Give each task its own git worktree, and start an opencode session in each:

1. Hover your repository in Agntree and select **Create Worktree…**.
2. Hover the new worktree and select **New Session**, then **New opencode Session**.
3. Repeat for the next task.

See [Run multiple agents in parallel with git worktrees](../guides/parallel-agents-git-worktrees.md).

## Resume an opencode session

Click the session. Agntree runs `opencode --session <session-id>` in the session's worktree. Right-click and choose **Copy Resume Command** to get that line for any terminal.

A new session shows `new` until your first prompt. opencode creates the session then, and Agntree links the row to it and takes its title.

## What Agntree runs

| Action | How |
| --- | --- |
| New session | `opencode` in the worktree |
| Resume | `opencode --session <session-id>` |
| List sessions | `opencode api session.list` |
| Fork | `opencode api session.fork`, then `session.move` when the fork goes to a new worktree |
| Last prompt and reply in the tooltip | `opencode session export`, when you hover the row |

opencode keeps its sessions in a database. Agntree never opens that database; it only uses the commands above.

## Good to know

- **The tooltip loads on hover.** Reading a session's last exchange needs an export, so Agntree fetches it for the row under your cursor instead of for every row.
- **Find Session coverage.** Each search reads opencode's newest 200 top-level sessions through its CLI. Older, archived, and subagent sessions are not searched.
- **Running Find Session needs another agent.** opencode has no read-only mode that Agntree can enforce, so Claude Code, Codex, or Pi runs the search. Your opencode sessions are still included.

## Related

- [Sessions](../sessions.md)
- [Fork a session](../fork-sessions.md)
- [Find Session](../find-session.md)
