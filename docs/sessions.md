# Sessions

A session is one conversation with a coding agent. Agntree lists every Claude Code, Codex, opencode, and Pi session under the repository and git worktree it runs in, and resumes any of them with one click. The session itself stays in the agent's own storage; Agntree only keeps the list.

## Read a session row

```
▾ storefront
  ▾ main                                  ●
      Add coupon codes to checkout      now
      Fix flaky cart total test        ★ 4m
  ▾ feature/search               ↑2 · PR #184
      Build typeahead search endpoint    1m
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

- **A short time** since the last activity (`now`, `16m`, `2h`, `3d`), or `new`.
- **A star**, if you starred it.

Hover a row for the session brief: your last prompt, the agent's last reply, and, where the agent provides them, the message count and model.

Sessions are listed newest first by when they were created, and they stay there. Opening, resuming, or starring a session never moves its row, so the list does not shift under your cursor.

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
- **Star:** select the star on a row. Starred sessions never age out of the list. **Starred Sessions…** (`Ctrl+Alt+S`, `Ctrl+Cmd+S` on macOS) lists every starred session across your repositories.
- **Close:** **Close Session** ends the session's terminal. The row stays and turns grey; click it to resume.

## Clean up the list

- **Remove one or several sessions:** select the rows (`Shift` or `Ctrl`/`Cmd` click for several), then press `Delete` (`Cmd+Backspace` on macOS) or choose **Remove Session from List…**. Star, Unstar, and Close work on a multi-selection too.
- **Remove every session under a worktree:** right-click it and choose **Remove All Sessions from List…**.

Removing a row never deletes the conversation. The agent keeps it, and **Import Existing Sessions…** brings it back. A session you removed is not imported again automatically.

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
