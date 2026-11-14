# Agntree compared with Orca, Paseo, and the plain CLI

There are three ways to run several coding agents at once: by hand in terminals, in a standalone agent app such as Orca or Paseo, or inside your editor with an extension such as Agntree. They solve the same problem from different places. This page describes each fairly so you can pick the one that fits how you work.

Descriptions of other tools are taken from their own websites as of November 2026 and may have changed since.

## The short version

- **Stay in VS Code or Cursor, use the agent CLIs you already have:** Agntree.
- **Want a dedicated app, a phone app, remote machines, or dozens of agents:** a standalone app such as [Orca](https://orca.dev/) or [Paseo](https://paseo.sh/).
- **One or two agents, and you like your terminal:** the plain CLI is enough.

## Side by side

| | Plain CLI | Standalone agent app | Agntree |
| --- | --- | --- | --- |
| Where it runs | Your terminal | A separate desktop app, often with a mobile app | Inside VS Code and Cursor |
| Your editor | Whatever you use, in another window | The app's own editor and diff views | VS Code itself, with your extensions and keybindings |
| Parallel agents on git worktrees | By hand | Yes | Yes |
| Agents | Any CLI | Many; Orca and Paseo each list dozens | Claude Code, Codex, opencode, Pi |
| Resume and fork a session | Per-agent commands and IDs | Varies by app | One click; each agent's own fork |
| Find a past session by description | No | Varies by app | Yes, across all four agents |
| "Agent needs you" signals | Look at each terminal | Varies by app; Orca alerts your phone | Row marks, notifications, and a jump shortcut |
| Chat interface | The agent's terminal UI | The app's own chat UI | The agent's terminal UI, or the Claude Code and Codex extension panels |
| Phone, remote machines, cloud | No | Yes, a main focus | No |
| What you install | Nothing extra | A desktop app | One extension |
| Price | Free | Orca and Paseo describe themselves as free and open source | Free, MIT |

## Agntree and standalone agent apps

Orca calls itself an agent development environment: "Run Claude Code, Codex, and any other coding agent in parallel, each in its own worktree." Paseo describes itself as "an open source agentic development environment for desktop, mobile, web, and CLI." Both are full applications. You open them instead of, or next to, your editor, and they bring their own terminals, diff views, and chat interface, along with things an editor extension does not attempt: a phone app, agents on remote machines, and agents that coordinate other agents.

Agntree takes the opposite position. It is a sidebar in the editor you already have open.

**Choose a standalone app when you want:**

- to check on and steer agents from your phone,
- agents running on remote machines or in the cloud,
- an agent beyond the four Agntree supports,
- a separate, purpose-built workspace for agent work.

**Choose Agntree when you want:**

- to stay in VS Code or Cursor, with your extensions, themes, keybindings, and debugger,
- the agent's own terminal UI or official VS Code panel, not a third chat interface,
- nothing else to install, sign in to, or keep running,
- sessions that remain exactly where the agent put them, usable from the command line with or without Agntree.

The two are not exclusive. Agntree works on the agents' native sessions and standard git worktrees, so it shows sessions and worktrees however they were created.

## Agntree and the plain CLI

Everything Agntree does can be done by hand. The difference is the bookkeeping.

| Task | By hand | With Agntree |
| --- | --- | --- |
| Resume a session | Find the ID, `cd` to its directory, run `claude --resume <id>`, `codex resume <id>`, `opencode --session <id>`, or `pi --session <id>` | Click the session |
| Start an agent on a new branch | `git worktree add`, `cd`, start the CLI, remember which terminal it is | **Create Worktree…**, then **+** |
| Try a second approach | Learn each agent's fork flags and where the copy lands | **Fork Session Here** |
| Find last week's session | Grep transcripts, or scroll a picker in every directory | Describe it in **Find Session** |
| Notice an agent is waiting | Look at each terminal in turn | A notification, or `Ctrl+Alt+N` |
| Review the agent's edits | `git status` and `git diff`, again and again | The **Changes** panel |
| Work on a pull request | Fetch the branch, add a worktree, `cd`, start the CLI | **Check Out Pull Request…** |

If you run one agent at a time in one repository, the CLI alone is fine. Agntree starts to pay for itself at about three sessions, or the first time you lose one.

## Agntree and other VS Code extensions

The VS Code Marketplace has session history viewers, which list past conversations for one agent, and git worktree managers, which create and switch worktrees. Agntree joins the two ideas: a session is listed under the worktree it belongs to, for four agents at once, with live working and finished state, forking, and notifications. It also works alongside the official [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) and [Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) extensions and can [open a session in their panels](agent-panels.md).

## What Agntree does not do

So you do not have to find out later:

- No mobile app, and no agents on remote machines or in the cloud.
- No built-in chat interface. Sessions run in the agent's terminal UI or its official VS Code panel.
- No agents beyond Claude Code, Codex, opencode, and Pi today.
- No orchestration: Agntree does not have agents start or direct other agents.
- Windows support is partial.

## Related

- [Getting started](getting-started.md)
- [Run multiple agents in parallel with git worktrees](guides/parallel-agents-git-worktrees.md)
- [FAQ](faq.md)
