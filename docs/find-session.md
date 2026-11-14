# Find Session

Find Session finds a past coding-agent session from a description of what you did in it. Type "the one where we fixed the flaky cart test" and an agent searches your Claude Code, Codex, opencode, and Pi history in every folder on your machine, then lists the sessions that match so you can resume one.

Use it when you remember the work but not the name, the folder, or even which agent you used.

## Ask a question

1. Press `Ctrl+Alt+F` (`Ctrl+Cmd+F` on macOS), or choose **Find Session…** in the Agntree `…` menu.
2. Describe the session in your own words and press `Enter`.

The **Find Session** view opens in the sidebar and shows the search running, with the step the agent is on. How long it takes depends on how much history you have and the model you use. **Stop Search** cancels it.

Good questions describe the work, not the wording:

- `the mod that shows context and usage limits`
- `where I migrated the billing tables to the new schema`
- `the session that set up GitHub Actions for the docs site`

## Read the results

Each question is a row. Beneath it are the sessions the agent found.

| Row | Shows | Hover for |
| --- | --- | --- |
| Question | How many sessions matched and when you asked | The agent's answer in full, which agent and model ran the search, and the steps it took |
| Session | The session's name, its folder, and when the matching prompt was sent | Why it matched, and the prompt of yours that it matched on |

On a session row:

- **Resume** (or click the row) opens the session. If its folder is in Agntree, the session is added under its worktree and opens as usual. If not, a terminal opens in that folder with the agent's resume command.
- **Show in Workspaces** reveals the session in the Workspaces tree. If its folder is not in Agntree yet, it offers to add it.
- **Copy Resume Command** copies the command line, for example `cd ~/code/storefront && claude --resume <id>`.

On a question row, **Ask Again…** reopens the question so you can refine it. Agntree keeps your last ten searches; **Clear Searches…** removes them.

## Choose the agent, model, and effort

One installed agent runs the search, and it searches every installed agent's sessions. Claude Code, Codex, and Pi can run a search. opencode sessions are searched too, but opencode cannot run one, because it has no read-only mode that Agntree can enforce.

Select the gear in the question box, or run **Find Session Settings…**, to change:

- **Harness:** the agent that runs the search. Claude Code is the default; if it is not installed, the first available agent is used.
- **Model:** leave empty to use the model that agent is already configured with, or pick a faster, cheaper one for searches only.
- **Effort:** how hard the agent thinks. Higher is slower and costs more.

These are the [`agntree.sessionSearch.*` settings](reference/settings.md#find-session). Changing the agent clears the model and effort, since they belong to the agent they were chosen for.

## What the search can and cannot do

Find Session is built so that a search cannot change anything.

- **Read-only tools.** The agent gets file reading and searching tools and nothing that writes. Codex runs in its read-only sandbox.
- **MCP servers are off for the run.** A server from your agent's configuration cannot be called during a search. One exception: an MCP server contributed by a Codex plugin has no per-run switch and stays as configured.
- **Nothing is left behind.** The search does not save a session in your agent's profile, and its temporary folder is removed afterwards. Agntree builds no index.
- **Every match is verified.** Agntree checks each session the agent names against that agent's own records, and checks that the quoted prompt is one you really typed. A session the agent invents is never shown.

## Privacy and cost

Find Session is the one Agntree feature that sends your session content anywhere. The agent you choose reads your session records, including sessions from your other agents, and sends what it reads to its model provider, exactly as any session with that agent does. It runs only when you ask a question, and it uses your own account, so a search costs what that model costs you.

Everything else in Agntree stays on your machine. See [Privacy](privacy.md).

## Limits

- **opencode coverage is partial.** opencode keeps sessions in a database Agntree does not open, so its newest 200 top-level sessions are read through opencode's own CLI for each search. Older, archived, and subagent sessions are not searched.
- **A search stops after ten minutes.**
- **The Copy Resume Command line uses POSIX syntax** (`cd … && …`).

## Hide the view

The Find Session view sits collapsed under Workspaces. To show it only after your first search, turn off [`agntree.sessionSearch.alwaysShowView`](reference/settings.md#find-session).

## Related

- [Sessions](sessions.md), for importing a session you can already see
- [Resume a session](guides/resume-a-session.md)
