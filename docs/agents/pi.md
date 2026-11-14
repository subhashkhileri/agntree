# Pi coding agent session manager for VS Code

Agntree gives the Pi coding agent a session manager inside VS Code. Every Pi session is listed under its repository and git worktree, resumes with one click, forks into a new branch, and notifies you when a turn finishes. Agntree drives the `pi` CLI you already have.

## Requirements

- [Pi](https://pi.dev), working in a terminal.
- The `pi` command on your `PATH`. If it is somewhere else, set [`agntree.harnessCommands.pi`](../reference/settings.md#agent-commands).

## What works

| Feature | Pi |
| --- | --- |
| Start and resume sessions | Yes |
| Sessions started outside Agntree appear automatically | Yes |
| Fork, here or into a new worktree | Yes, with Pi's own `--fork` |
| Working and finished marks, finished-turn notifications | Yes |
| "Needs your input" notifications | Not available. Pi exposes no pending-permission state |
| Find Session | Searched, and can run the search |
| Open in the agent's VS Code panel | No. Sessions open in a terminal |

## Run Pi sessions in parallel

Give each task its own git worktree, and start a Pi session in each:

1. Hover your repository in Agntree and select **Create Worktree…**.
2. Hover the new worktree and select **New Session**, then **New Pi Session**.
3. Repeat for the next task.

See [Run multiple agents in parallel with git worktrees](../guides/parallel-agents-git-worktrees.md).

## Resume a Pi session

Click the session. Agntree runs `pi --session` with the session's record, in the directory the session was started in. Right-click and choose **Copy Resume Command** to get that line for any terminal.

## What Agntree runs

| Action | Command |
| --- | --- |
| New session | `pi --session-id <new-uuid>` |
| Resume | `pi --session <session-record>` |
| Fork | `pi --fork <source> --session-id <new-uuid>` |
| Find Session | `pi --print` with only the `read`, `grep`, `find`, and `ls` tools, and MCP tools denied |

Agntree chooses the session ID before it starts Pi, so a row is always linked to exactly the session it launched.

## Where sessions come from

Agntree reads Pi's session records under `~/.pi/agent/sessions/`. It follows the same overrides Pi does: the `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` environment variables, and the `sessionDir` setting.

A session is named with the name you gave it in Pi with `/name`. Your first prompt is the fallback. The session tooltip shows the last exchange, the message count, and the model.

## Good to know

- **A finished mark can appear briefly during a retry.** Pi's session record stores messages, not its internal "settled" event, so an automatic retry or a compaction can look like a finished turn for a moment.
- **A `sessionDir` set only in a subdirectory's own `.pi/settings.json`** is not discovered. Set it for the worktree, or use the environment variable.
- **Branches made with `/tree`** are read in file order, not reconstructed as a tree.

## Related

- [Sessions](../sessions.md)
- [Fork a session](../fork-sessions.md)
- [Find Session](../find-session.md)
