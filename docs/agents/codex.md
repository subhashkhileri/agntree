# Codex session manager for VS Code

Agntree gives OpenAI Codex a session manager inside VS Code. Every Codex thread is listed under its repository and git worktree, resumes with one click, forks into a new branch, and notifies you when a turn finishes. Agntree drives the `codex` CLI you already have.

## Requirements

- The [Codex CLI](https://developers.openai.com/codex), signed in and working in a terminal.
- The `codex` command on your `PATH`. If it is somewhere else, set [`agntree.harnessCommands.codex`](../reference/settings.md#agent-commands).
- Optional: the [Codex extension](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt), to open threads in its conversation panel.

## What works

| Feature | Codex |
| --- | --- |
| Start and resume sessions | Yes |
| Sessions started outside Agntree appear automatically | Yes |
| Fork, here or into a new worktree | Yes, with the Codex app-server's own fork |
| Working and finished marks, finished-turn notifications | Yes |
| "Needs your input" notifications | Not available. Codex exposes no pending-approval state that Agntree can read |
| Find Session | Searched, and can run the search |
| Open in the agent's VS Code panel | Yes, the Codex extension |

## Run Codex sessions in parallel

Give each task its own git worktree, and start a Codex session in each:

1. Hover your repository in Agntree and select **Create Worktree…**.
2. Hover the new worktree and select **New Session**, then **New Codex Session**.
3. Repeat for the next task.

The sidebar shows which threads are working and which have finished, and each one edits its own directory. See [Run multiple agents in parallel with git worktrees](../guides/parallel-agents-git-worktrees.md).

## Resume a Codex session

Click the session. Agntree runs `codex resume <thread-id> --cd <worktree>`. Right-click and choose **Copy Resume Command** to get that line for any terminal.

A new Codex session shows `new` until your first prompt. Codex creates the thread at that point, and Agntree links the row to it and takes the thread's name.

## Use the Codex panel

Select the panel icon on a session, or choose **Open in Codex UI**, to continue a thread in the Codex extension's conversation panel. Agntree closes the session's terminal first, because Codex allows one writer per thread. The panel resumes the thread in its own directory, so it works from any worktree. See [Agent panels](../agent-panels.md).

## What Agntree runs

| Action | How |
| --- | --- |
| New session | `codex` in the worktree |
| Resume | `codex resume <thread-id> --cd <worktree>` |
| List, preview, and fork threads | A private `codex app-server`, over its JSON-RPC protocol |
| Working and finished state | The thread's rollout file under `~/.codex/sessions/` |
| Find Session | `codex exec --ephemeral --sandbox read-only` |

Agntree starts the app-server only when it needs it and stops it when idle. It never opens Codex's state database.

## Good to know

- **Archived threads** are not listed.
- **The Codex app-server protocol is marked experimental by Codex.** After a Codex upgrade, if threads stop appearing, check [Troubleshooting](../troubleshooting.md#sessions-do-not-appear).
- **Find Session with Codex** turns off the MCP servers in your `config.toml` for the search. A server contributed by a Codex plugin has no per-run switch and stays as configured.

## Related

- [Sessions](../sessions.md)
- [Fork a session](../fork-sessions.md)
- [Notifications](../notifications.md)
