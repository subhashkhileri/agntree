# Resume a Claude Code, Codex, opencode, or Pi session

To resume a coding-agent session you need its session ID and, for most agents, the directory it ran in. This guide lists the resume command for each agent, shows where the ID comes from, and shows how to resume any session with one click in VS Code.

## Resume commands

| Agent | Resume a session by ID |
| --- | --- |
| Claude Code | `claude --resume <session-id>` |
| Codex | `codex resume <thread-id>` |
| opencode | `opencode --session <session-id>` |
| Pi | `pi --session <session-id>` |

Run the command from the directory the session was started in. Claude Code and Pi file sessions by project directory, so the same command from another directory may not find the session. Codex accepts the directory as an option: `codex resume <thread-id> --cd <directory>`.

Claude Code has two shortcuts for when you do not have the ID:

```bash
claude --continue    # continue the most recent conversation in this directory
claude --resume      # pick a session from a list
```

## Find the session ID

The hard part of resuming is usually finding the ID, and remembering which directory the session belongs to.

- **In Agntree:** right-click a session and choose **Copy Session ID**, or **Copy Resume Command** for the whole command line.
- **Claude Code** stores each session as `<session-id>.jsonl` under `~/.claude/projects/`, in a folder named after the project directory.
- **Codex** stores a rollout file per thread under `~/.codex/sessions/`, in folders by date. The thread ID is the end of the file name.
- **Pi** stores a record per session under `~/.pi/agent/sessions/`, in a folder named after the project directory.

## Resume with one click in VS Code

[Agntree](../getting-started.md) lists every session under the repository and git worktree it belongs to. To resume one:

1. Open the Agntree sidebar.
2. Click the session.

Agntree opens the agent's own CLI in the right directory with the right session ID. The row shows the session's name and how long ago it was active, and its tooltip shows your last prompt and the agent's last reply, so you can tell sessions apart before opening one.

Sessions you started outside Agntree are listed as well. Agntree reads the sessions each agent already holds for the folders you add.

## When you cannot find the session

If you remember the work but not the session:

- **Import Existing Sessions…** on a worktree lists every session the agents hold for that directory.
- [**Find Session**](../find-session.md) searches every agent's sessions in every folder from a description such as "the one where we fixed the flaky cart test".

## Resume a session in a new direction

To continue from a session without changing it, fork it. A fork is a new session that starts with the original's full history. In Agntree, right-click a session and choose **Fork Session Here** or **Fork Session to New Worktree…**. See [Fork a session](../fork-sessions.md).

## When a session will not resume

- **Wrong directory.** Run the command from the directory the session was started in. Agntree's **Copy Resume Command** always resumes in the right one.
- **The session was deleted.** If the agent no longer has the session, nothing can resume it. Agntree says so instead of opening an empty conversation.
- **No prompt was ever sent.** Agents create a session only when you send the first message. A session you opened and closed without typing has nothing to resume.
- **It is open somewhere else.** Codex allows one writer per thread. Close the session's terminal or panel before resuming it elsewhere.

## Related

- [Sessions](../sessions.md)
- [Claude Code](../agents/claude-code.md), [Codex](../agents/codex.md), [opencode](../agents/opencode.md), and [Pi](../agents/pi.md)
