# Fork a session

Forking copies a conversation into a new session that starts with the full history of the original. Use it to try a second approach, to split one long session into two lines of work, or to experiment without risking a session that is going well. The original is left exactly as it was.

Agntree can fork Claude Code, Codex, opencode, and Pi sessions, either beside the original or into a new git worktree.

## Fork in the same worktree

Right-click a session and choose **Fork Session Here**.

A new session appears under the same worktree and opens in a terminal. It is named after the original with a number: forking `Fix flaky cart test` creates `Fix flaky cart test (1)`. Both sessions share the same files, so use this when the two conversations will not edit the same code at the same time.

## Fork into a new worktree

Right-click a session and choose **Fork Session to New Worktree…**. Agntree asks for a branch name and a directory, then:

1. creates a new branch and worktree from the commit the source worktree is on,
2. copies the source worktree's **uncommitted changes** into it, including untracked files,
3. forks the conversation into the new worktree and opens it.

The fork starts from the same code and the same conversation as the original, in its own directory. The two agents can now work at the same time without touching each other's files, and you can compare the results as two branches.

The suggested directory is the same `<repo>-worktrees/<branch>` folder that [Create Worktree](worktrees.md#create-a-worktree) uses.

> [!NOTE]
> A session in a plain folder has no branch to fork into. Use **Fork Session Here**, or run `git init` in the folder first.

## How each agent forks

Agntree uses the agent's own fork, so the result is a real session that you can also resume from the command line.

| Agent | What Agntree runs | The fork exists |
| --- | --- | --- |
| Claude Code | `claude --resume <source> --fork-session --session-id <new>` | After your first prompt in the fork |
| Codex | The Codex app-server's `thread/fork`, into the destination directory | Immediately |
| opencode | opencode's `session.fork` API, then `session.move` for a new worktree | Immediately |
| Pi | `pi --fork <source> --session-id <new>` | Immediately |

Claude Code writes nothing until the first prompt. If you close a Claude Code fork's terminal before sending one, Agntree removes the row: reopening it later would fork from wherever the original has moved on to, not from the point you chose.

## When to fork and when to start fresh

| Situation | Do this |
| --- | --- |
| The agent understands the problem and you want a different solution | Fork |
| You want two solutions built at the same time | Fork into a new worktree |
| The conversation is long and has drifted | Start a new session with a short summary |
| The next task is unrelated | Start a new session |

## Related

- [Run multiple agents in parallel with git worktrees](guides/parallel-agents-git-worktrees.md)
- [Sessions](sessions.md)
- [Worktrees and repositories](worktrees.md)
