# Settings

Agntree works without any configuration. To change how it behaves, choose **Agntree Settings…** in the Agntree `…` menu, or run **Agntree: Agntree Settings…** from the Command Palette. VS Code's Settings editor opens on Agntree's settings, in the five groups below. Every setting can be changed there; none needs `settings.json`.

## Sessions

| Setting | Default | What it does |
| --- | --- | --- |
| `agntree.defaultHarness` | Ask every time | The agent that **New Session** (**+**) starts in one click: **Claude Code**, **opencode**, **Codex**, or **Pi**. Left on **Ask every time**, **+** opens a menu of installed agents. **Set Default Agent…** changes it from the sidebar. In `settings.json` the values are `""`, `claude`, `opencode`, `codex`, and `pi`. |
| `agntree.defaultSessionSurface` | `terminal` | Where a session opens when you click its row or start a new one: **Terminal**, or **Agent's VS Code panel** (`ui`) for Claude Code and Codex. Agents without a panel, and sessions a panel cannot open, use the terminal. The **In Terminal** and **In UI** commands always override it. See [Agent panels](../agent-panels.md). |
| `agntree.autoImport.enabled` | `true` | Show sessions you started outside Agntree, in a plain terminal or in an agent's own VS Code panel, as rows under their worktree. Off: only sessions started from Agntree are listed, rows no longer age out, and **Import Existing Sessions…** still adds others by hand. |
| `agntree.autoImport.retentionDays` | `15` | Session rows leave the tree after this many days without activity. Starred sessions always stay. Only the row is removed; the agent keeps the conversation. Minimum `1`. |

## Notifications

| Setting | Default | What it does |
| --- | --- | --- |
| `agntree.notifications.enabled` | `true` | Notify you about sessions you are not looking at. This is the main switch: turn it off and the three settings below have no effect. |
| `agntree.notifications.onTurnEnd` | `true` | Notify when an agent finishes responding. Works for every agent. |
| `agntree.notifications.onNeedsInput` | `true` | Notify when a Claude Code session is waiting on you, for example at a permission prompt. Claude Code only. |
| `agntree.notifications.nativeBanner` | `true` | macOS only: also show a system banner while VS Code is in the background. |

See [Notifications](../notifications.md).

## Find Session

| Setting | Default | What it does |
| --- | --- | --- |
| `agntree.sessionSearch.harness` | `claude` | The agent that runs **Find Session…**: `claude`, `codex`, or `pi`. It must be installed. Sessions from every installed agent are searched whichever one runs the search. Changing it clears the model and effort below. |
| `agntree.sessionSearch.model` | *(empty)* | The model Find Session uses, written the way that agent's CLI names it, for example `sonnet` for Claude Code. Empty uses the model the agent is already configured with. |
| `agntree.sessionSearch.effort` | *(empty)* | How hard the agent thinks during a search: `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Empty uses the agent's own setting. Higher is slower and costs more, and a level the chosen agent does not support is ignored. |
| `agntree.sessionSearch.alwaysShowView` | `true` | Show the **Find Session** view in the sidebar all the time. Off: it appears only after your first search. |

**Find Session Settings…**, or the gear in the question box, changes the first three with a list to pick from. See [Find Session](../find-session.md).

## Window

| Setting | Default | What it does |
| --- | --- | --- |
| `agntree.autoSwitchWorkspaceFolder` | `false` | When you select a worktree or session in another repository, make that folder the one VS Code has open, so the Explorer, search, and Source Control follow it. VS Code restarts its extensions on each switch, which shows as a brief flicker. Off: use **Open in This Window** on a worktree. |
| `agntree.focusOnStartup` | `false` | Open the Agntree sidebar when VS Code starts, instead of the Explorer. |

Both can also be switched from the Agntree `…` menu.

## Agent commands

The command Agntree runs to start each agent. Change one when the agent is not on your `PATH` (use the full path) or you start it through a wrapper. Reload the window after changing it.

| Setting | Default |
| --- | --- |
| `agntree.harnessCommands.claude` | `claude` |
| `agntree.harnessCommands.opencode` | `opencode` |
| `agntree.harnessCommands.codex` | `codex` |
| `agntree.harnessCommands.pi` | `pi` |

## Example

```json
{
  "agntree.defaultHarness": "claude",
  "agntree.autoImport.retentionDays": 30,
  "agntree.notifications.onTurnEnd": false,
  "agntree.sessionSearch.model": "sonnet",
  "agntree.harnessCommands.codex": "/opt/homebrew/bin/codex"
}
```

## Related

- [Commands and menus](commands.md)
- [Keyboard shortcuts](keyboard-shortcuts.md)
