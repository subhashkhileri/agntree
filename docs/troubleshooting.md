# Troubleshooting

Most Agntree problems come down to one of four things: the agent's command is not where Agntree looks for it, a session is in a folder Agntree has not been given, a session no longer exists on the agent's side, or a window still runs an older build. Find your symptom below.

## An agent is missing from the New Session menu

The menu lists only agents whose command Agntree can find on your `PATH`.

1. Run the agent's command (`claude`, `codex`, `opencode`, or `pi`) in VS Code's integrated terminal. If it does not start there, install it or fix your `PATH` first.
2. If it starts in a terminal but is still missing, VS Code may have a different `PATH` than your shell. This is common when VS Code is started from the dock or a launcher. Set the full path in **Agntree Settings…** → **Agent Commands**, for example `agntree.harnessCommands.claude` = `/Users/you/.local/bin/claude`.
3. Run **Developer: Reload Window**. Agntree checks for agents when the window loads.

To find the full path, run `which claude` (or `where claude` on Windows).

## Sessions do not appear

- **The folder is not in Agntree.** Sessions are listed for the folders and repositories you added. Add the folder, or use [Find Session](find-session.md) to look everywhere.
- **The session is older than the retention window.** Automatic import adds sessions that were active in the last 15 days. Right-click the worktree and choose **Import Existing Sessions…** for older ones.
- **You removed it before.** A session you removed from the list is not imported again automatically. **Import Existing Sessions…** brings it back.
- **Automatic import is off.** Check `agntree.autoImport.enabled`.
- **The session has no prompt yet.** Agents create a session only when you send the first message. Until then the row says `new`.
- **The sidebar was hidden.** Agntree pauses its background scan while its view is closed and catches up when you open it. **Refresh** in the Workspaces `…` menu forces it.
- **Claude Code uses a custom profile.** Agntree reads `CLAUDE_CONFIG_DIR` from VS Code's environment. Start VS Code from a shell where that variable is set.
- **Codex threads stopped appearing after a Codex upgrade.** Agntree talks to `codex app-server`, which Codex marks as experimental. Update Agntree, and [open an issue](https://github.com/subhashkhileri/agntree/issues) with your Codex version if it persists.

## A new session stays "new"

A row is linked to the agent's session after your first prompt. If it still says `new` after you have sent one:

- Make sure the prompt was sent in the terminal Agntree opened for that row.
- Codex and opencode assign the session ID themselves, and Agntree watches for it for five minutes after the terminal opens. If the row never links, right-click the worktree, choose **Import Existing Sessions…** to add the session, and remove the empty row.

## A session will not resume

- **"The session no longer exists."** The agent no longer has the conversation, usually because it was deleted or its storage was cleaned up. Remove the row.
- **Codex says the conversation is open in another app.** Codex allows one writer per thread. Close the thread's terminal or Codex panel, then open it again.
- **The agent starts a fresh conversation.** Check that the agent's CLI is recent enough. Claude Code must be 2.1.310 or newer.

## I get no notifications

1. Check **Agntree Settings…** → **Notifications**. `agntree.notifications.enabled` is the main switch.
2. Notifications are skipped for the session you are looking at. That is intended.
3. Only open sessions are watched: the session needs a terminal or panel open.
4. Check that VS Code's own Do Not Disturb mode is off (the bell icon in the status bar).
5. "Needs your input" is Claude Code only, and it is sent at most once a minute per session.
6. On macOS, the system banner appears only while VS Code is in the background, and needs notification permission for VS Code in System Settings.

`Ctrl+Alt+N` (`Ctrl+Cmd+N` on macOS) still takes you to the next session that needs you, whatever the notification settings.

## The Claude Code or Codex panel will not open a session

The message says why. The usual reasons:

- **The extension is not installed.** Choose **Find Extension** in the message.
- **The worktree is not the first folder in the window** (Claude Code), or **not the only folder** (a new Codex session). Choose **Open in New Window**.
- **The session has no prompt yet.** Send the first prompt in the terminal, then move it to the panel.

See [Agent panels](agent-panels.md#which-folder-the-panel-runs-in).

## Pull requests do not show, or Check Out Pull Request fails

Pull request features use the GitHub CLI. Run `gh auth status` in a terminal. If `gh` is missing or signed out, install it from [cli.github.com](https://cli.github.com/) and run `gh auth login`.

## A terminal reopened without its session

After you quit and reopen VS Code, Agntree resumes each restored terminal tab by the title it gave the tab. A tab you renamed by hand, or a shell without VS Code's shell integration, cannot be matched. Click the session's row to resume it.

## I installed a new version but nothing changed

A window that is already open keeps running the old version. Run **Developer: Reload Window**.

## Find Session fails or finds nothing

- **"No installed harness can search sessions."** Find Session needs Claude Code, Codex, or Pi installed to run the search. opencode alone cannot run one.
- **It found nothing.** Describe the work differently, with words you would have typed in a prompt. For opencode, only the newest 200 sessions are searched.
- **It stopped.** A search ends after ten minutes. Try a faster model in **Find Session Settings…**.

## Still stuck?

Collect what Agntree recorded, then open an issue:

1. **View → Output**, and pick **Agntree Operations** for the log of file and worktree actions.
2. **Help → Toggle Developer Tools**, then the **Console** tab, for errors from the extension.
3. [Open an issue](https://github.com/subhashkhileri/agntree/issues/new?template=bug_report.yml) with your VS Code version, operating system, the agent and its version, and what you did.

## Related

- [FAQ](faq.md)
- [Settings](reference/settings.md)
