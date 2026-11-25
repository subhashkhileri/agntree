# Sessions

A session is one conversation with a coding agent. Agntree lists every Claude Code, Codex, opencode, and Pi session under the repository and git worktree it runs in, and resumes any of them with one click. The session itself stays in the agent's own storage; Agntree only keeps the list.

## Read a session row

```
▾ storefront
  ▾ main ●
      Fix flaky cart total test 4m             ★
      Add coupon codes to checkout now
      Refactor price formatting 1d
    ▸ Older (9)
  ▾ feature/search ↑2 · PR #184
      Build typeahead search endpoint 1m
```

Each row shows four things:

- **The name.** The agent names the session after your first prompt; you can rename it.
- **The agent's mark**, which also shows the state:

  | Mark | Meaning |
  | --- | --- |
  | The mark pulses | The agent is working on a turn |
  | The mark with a green dot | The turn finished |
  | A grey mark | The session is closed: no terminal or panel is open for it |
  | The mark with a hollow ring | New: no prompt has been sent yet |

- **A short time** since the last activity (`now`, `16m`, `2h`, `3d`), or `new`, right after the name.
- **A star** at the right edge of the row, if you starred it. A long name is cut short before the star is, so you can always see which sessions are starred.

Hover a row for the session brief: your last prompt, the agent's last reply, and, where the agent provides them, the message count and model.

Starred sessions come first in their worktree, so the ones you marked as important are the first you see. Below them, the rest are listed newest first by when they were created. Only starring or unstarring moves a row: opening, resuming, or new activity never does, so the list does not shift under your cursor. To list sessions only by when they were created, turn off [`agntree.starredSessionsFirst`](reference/settings.md#sessions). Sessions you have not used for a few days [fold under an **Older** row](#older-sessions-fold-away).

## Start a session

Hover a worktree or folder and select **New Session** (**+**), then choose an agent. A terminal opens in that directory with the agent's CLI running.

The terminal opens in the editor area, as a tab beside your files. It behaves like any other editor tab: drag it to reorder it, drag it to an edge to split the editor, and put two agents side by side.

- **One-click start:** choose **Set Default Agent…** in the New Session menu. After that, **+** starts that agent at once. Every agent stays available from the row's right-click **New Session** menu.
- **From the keyboard:** `Ctrl+Alt+Enter` (`Ctrl+Cmd+Enter` on macOS) starts a session with your default agent in the worktree you are working in.
- **In the agent's VS Code panel:** Claude Code and Codex sessions can start in their extension's chat panel instead of a terminal. See [Agent panels](agent-panels.md).

A new session shows `new` until you send the first prompt. That is when the agent creates the session on its side; Agntree then links the row to it and takes the agent's name for it.

## Resume a session

Click the row. Agntree opens the agent's CLI in the session's worktree with its native session ID, so the conversation continues where it stopped.

- If the session is already open in a terminal, the click focuses that terminal.
- If it is open in the Claude Code or Codex panel, the click reveals the panel instead of starting a second copy.
- **Open Session in Terminal** on the row always uses the terminal.

To resume from outside VS Code, right-click the session and choose **Copy Resume Command**. It copies a command line that works from any terminal, for example `cd ~/code/storefront && claude --resume <id>`. See [Resume a session](guides/resume-a-session.md) for each agent's command.

Sessions survive a restart. After **Developer: Reload Window**, Agntree reconnects each terminal to its session. After you quit and reopen VS Code, each restored terminal tab resumes its own session.

## Switch between sessions

Press `Ctrl+Alt+S` (`Ctrl+Cmd+S` on macOS), or choose **Switch Session…** in the Agntree `…` menu, to jump to any session in any repository without the mouse. A list opens at the top of the window, in four sections:

| Section | What is in it |
| --- | --- |
| **Needs you** | Sessions that finished a turn or started waiting on you while you were elsewhere, longest-waiting first. A Claude Code session waiting on a prompt shows what it is asking. |
| **Open** | Sessions running in a terminal or an agent's panel |
| **Starred** | Your starred sessions |
| **Recent** | Everything else in the list |

Within a section, the session you used last comes first. The session you are in sits at the very bottom, so `Ctrl+Alt+S` then `Enter` takes you back to the previous one.

- **Search:** type part of a session's name, repository, worktree, or agent.
- **Move down:** press `Ctrl+Alt+S` again while the list is open; each press moves one row, wrapping at the end. `Enter` opens the highlighted session.
- **Open:** a pick opens the way a click on its row does, focusing a running terminal or panel instead of starting a second copy.
- **Act without leaving the list:** hover a row for **Open in Claude Code UI** or **Open in Codex UI**, **Open Session in Terminal**, **Close Session**, and **Star Session**. Starring or closing keeps the list open.
- **Narrow it:** the star in the list's title bar shows only starred sessions, and the filter shows only the repository you are working in.

Each row carries the agent's mark, which keeps updating while the list is open. Rows never move under your cursor; the order is set when the list opens.

## Sessions started outside Agntree

You do not have to start a session from the sidebar for it to appear there. Agntree looks at the sessions each agent holds for your folders and worktrees and adds the recent ones it has not seen, such as a session started in:

- a plain terminal,
- another VS Code window,
- the Claude Code or Codex extension's own panel.

Imported sessions carry the agent's own name for them: Claude Code's session title, Codex's thread name, opencode's title, or Pi's session name.

To add an older session by hand, right-click a worktree or folder and choose **Import Existing Sessions…**, then tick the ones you want. To look for a session in any folder on your machine, use [Find Session](find-session.md).

Turn automatic import off with [`agntree.autoImport.enabled`](reference/settings.md#sessions). Sessions you start from Agntree are still listed, and rows then stop [aging out](#rows-age-out-by-themselves).

## Rename, star, and close

- **Rename:** select a session and press `F2`, or use **Rename Session…**. A name you choose is never replaced by the agent's.
- **Star:** select the star on a row, or the star on a row in [Switch Session](#switch-between-sessions). Starred sessions sit at the top of their worktree and never age out of the list. **Starred Sessions…** in the Command Palette opens Switch Session showing only starred sessions, across your repositories. The star follows VS Code's `explorer.decorations.badges` setting; with badges turned off, it sits next to the time instead.
- **Close:** **Close Session** ends the session's terminal. The row stays and turns grey; click it to resume.

## Clean up the list

- **Remove one or several sessions:** select the rows (`Shift` or `Ctrl`/`Cmd` click for several), then press `Delete` (`Cmd+Backspace` on macOS) or choose **Remove Session from List…**. Star, Unstar, and Close work on a multi-selection too.
- **Remove every session under a worktree:** right-click it and choose **Remove All Sessions from List…**.

Removing a row never deletes the conversation. The agent keeps it, and **Import Existing Sessions…** brings it back. A session you removed is not imported again automatically.

### Older sessions fold away

In each worktree, sessions with no activity for 3 days fold under an **Older (n)** row at the bottom, so the sessions you are working with stay in view. Opening a session counts as activity. Expand the row to see the folded sessions; they work like any other row.

- A **starred** session, or one that is **open** in a terminal or panel, never folds.
- A single quiet session stays where it is, since a row that hides one session saves nothing.
- Opening a folded session, or going to it from [Switch Session](#switch-between-sessions), Find Session, or a notification, moves it back up: it is in use again.
- An **Older** row you expand stays open while you look through it or remove sessions from it, and collapses again once a session moves out of it, for example when you open one.

Change the number of days with [`agntree.foldOlderSessionsAfterDays`](reference/settings.md#sessions), or set it to `0` to list every session.

### Rows age out by themselves

A session row leaves the list after 15 days without activity, whether Agntree started it or imported it. This keeps the tree to what you are working on.

- A **starred** session stays for good.
- A session that is **open** in a terminal or panel is never removed.
- If an aged-out session becomes active again, it returns.

Change the number of days with [`agntree.autoImport.retentionDays`](reference/settings.md#sessions).

## Copy a session's ID

Right-click a session and choose **Copy Session ID** for the agent's native ID, or press `Ctrl+C` (`Cmd+C` on macOS) with a session selected to copy its resume command.

## Related

- [Fork a session](fork-sessions.md)
- [Find Session](find-session.md)
- [Notifications](notifications.md)
- [Commands on a session row](reference/commands.md#session-rows)
