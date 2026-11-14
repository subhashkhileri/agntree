# Agntree documentation

Agntree is a free, open-source extension for VS Code and Cursor that manages coding-agent sessions. It puts every [Claude Code](agents/claude-code.md), [Codex](agents/codex.md), [opencode](agents/opencode.md), and [Pi](agents/pi.md) session in one sidebar, grouped by repository and git worktree, so you can start, resume, fork, find, and review agent work without juggling terminals or session IDs.

New here? [Install Agntree and start your first session](getting-started.md). It takes about two minutes.

## What you can do

| I want to… | Read |
| --- | --- |
| Install Agntree and start a session | [Getting started](getting-started.md) |
| Start, resume, rename, star, and clean up sessions | [Sessions](sessions.md) |
| Give each task its own branch and directory | [Worktrees and repositories](worktrees.md) |
| Try a second approach without losing the first | [Fork a session](fork-sessions.md) |
| Find a session from last week by describing it | [Find Session](find-session.md) |
| Know when an agent finishes or needs me | [Notifications](notifications.md) |
| Use the Claude Code or Codex chat panel instead of a terminal | [Agent panels](agent-panels.md) |
| See and manage what the agent changed | [Changes and files](changes-and-files.md) |

## Agents

Each agent has a page with its requirements, the commands Agntree runs for it, and what is and is not supported.

| Agent | Start and resume | Fork | Auto-import | Find Session | Notifications | VS Code panel |
| --- | --- | --- | --- | --- | --- | --- |
| [Claude Code](agents/claude-code.md) | Yes | Yes | Yes | Yes | Finished turns and "needs input" | Yes |
| [Codex](agents/codex.md) | Yes | Yes | Yes | Yes | Finished turns | Yes |
| [opencode](agents/opencode.md) | Yes | Yes | Yes | Searched, cannot run the search | Finished turns | No |
| [Pi](agents/pi.md) | Yes | Yes | Yes | Yes | Finished turns | No |

## Guides

- [Run multiple agents in parallel with git worktrees](guides/parallel-agents-git-worktrees.md)
- [Resume a Claude Code, Codex, opencode, or Pi session](guides/resume-a-session.md)

## Reference

- [Settings](reference/settings.md)
- [Commands and menus](reference/commands.md)
- [Keyboard shortcuts](reference/keyboard-shortcuts.md)

## More

- [Comparison with standalone agent apps and the plain CLI](comparison.md)
- [FAQ](faq.md)
- [Troubleshooting](troubleshooting.md)
- [Privacy](privacy.md)
- [Changelog](../CHANGELOG.md)

## How Agntree thinks

Three ideas explain most of how Agntree behaves:

- **Sessions belong to the agent.** Agntree never copies a conversation into a format of its own. A row in the sidebar points at the agent's native session, so the session still resumes from the command line, and removing a row never deletes a conversation.
- **Sessions live where the code lives.** A session is listed under the repository and worktree it runs in. Selecting it points the Changes and All Files panels at that worktree.
- **The sidebar stays quiet.** A row shows a name, a short time, a star, and the agent's mark. Everything else is in the tooltip or the right-click menu.

For how the extension is built, see [ARCHITECTURE.md](../ARCHITECTURE.md). To contribute, start with [CONTRIBUTING.md](../CONTRIBUTING.md).
