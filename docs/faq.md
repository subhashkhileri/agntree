# Frequently asked questions

Short answers to the questions people ask most about Agntree, the VS Code session and git worktree manager for coding agents. Each answer links to the page with the detail.

## The basics

### What is Agntree?

Agntree is a free, open-source VS Code extension that manages coding-agent sessions. It lists every Claude Code, Codex, opencode, and Pi session in one sidebar, grouped by repository and git worktree, so you can start, resume, fork, find, and review agent work without juggling terminals or session IDs. See [Getting started](getting-started.md).

### Which coding agents does Agntree support?

Claude Code (version 2.1.310 or newer), OpenAI Codex, opencode (version 2 or newer), and Pi. All four can be started, resumed, forked, and imported, and all four notify you when a turn finishes. Claude Code also reports when it is waiting on a permission prompt or a question. See the pages for [Claude Code](agents/claude-code.md), [Codex](agents/codex.md), [opencode](agents/opencode.md), and [Pi](agents/pi.md).

### How do I run multiple Claude Code agents in parallel?

Give each agent its own git worktree, which is a separate directory on a separate branch of the same repository. In Agntree, hover a repository and select **Create Worktree…**, then hover the new worktree and select **New Session**. Repeat for each task. The agents cannot overwrite each other's files, and the sidebar shows which are working and which have finished. The same steps work for Codex, opencode, and Pi. See [Run multiple agents in parallel with git worktrees](guides/parallel-agents-git-worktrees.md).

### How do I resume a Claude Code session in VS Code?

Open the Agntree sidebar and click the session. Agntree runs `claude --resume` with the session's ID in the session's directory, so the conversation continues where it stopped. Sessions you started outside Agntree are listed too. See [Resume a session](guides/resume-a-session.md).

### Does Agntree replace Claude Code, Codex, opencode, or Pi?

No. Agntree is a front end for the agent CLIs you already use. Starting or resuming a session opens the agent's own terminal UI, and every session stays in the agent's own storage, usable from the command line with or without Agntree.

### Does Agntree work in Cursor?

Yes. Agntree is a standard VS Code extension and runs in editors built on VS Code, including Cursor. Search for **Agntree** in the editor's Extensions view; if it is not listed there, install the `.vsix` file from the [latest release](https://github.com/subhashkhileri/agntree/releases/latest). See [Getting started](getting-started.md#install).

### Is Agntree free?

Yes. Agntree is free and open source under the MIT license, with no paid tier and no account. You still need your own subscription or API access for the agents you run.

### Does Agntree send my code or conversations anywhere?

No. Agntree has no telemetry and keeps its state inside VS Code. The one exception is **Find Session**, which runs only when you ask a question: the agent you choose reads your session history and sends what it reads to its model provider, as any session with that agent does. See [Privacy](privacy.md).

## Sessions

### How do I find an old Claude Code session?

Use **Find Session** (`Ctrl+Alt+F`, `Ctrl+Cmd+F` on macOS) and describe what you did, for example "the one where we fixed the flaky cart test". An agent searches your Claude Code, Codex, opencode, and Pi sessions in every folder and lists the matches. If you know which folder it was in, right-click that worktree and choose **Import Existing Sessions…**. See [Find Session](find-session.md).

### Can I fork a Claude Code or Codex conversation?

Yes. Right-click a session and choose **Fork Session Here**, or **Fork Session to New Worktree…** to fork into a new branch that also carries your uncommitted changes. The fork starts with the original's full history and the original is untouched. Forking works for Claude Code, Codex, opencode, and Pi. See [Fork a session](fork-sessions.md).

### Do sessions I start outside Agntree show up?

Yes. Agntree adds recent sessions that the agents hold for your folders and worktrees, whether you started them in a plain terminal, another VS Code window, or the Claude Code or Codex panel. Turn this off with `agntree.autoImport.enabled`. See [Sessions](sessions.md#sessions-started-outside-agntree).

### Why did a session disappear from the list?

A session row leaves the list after 15 days without activity, unless it is starred or open. The conversation is not deleted. Bring it back with **Import Existing Sessions…** on its worktree, star sessions you want to keep, or change `agntree.autoImport.retentionDays`. See [Sessions](sessions.md#rows-age-out-by-themselves).

### Does removing a session delete the conversation?

No. **Remove Session from List…** only removes the row. The agent keeps the conversation, and **Import Existing Sessions…** adds it back.

### What do the marks on a session mean?

A pulsing mark means the agent is working. A green dot means its turn finished. A grey mark means the session is closed, and a hollow ring means it is new and has no prompt yet. See [Sessions](sessions.md#read-a-session-row).

### How do I know when an agent is waiting for me?

Agntree notifies you when a session you are not looking at finishes a turn, and when Claude Code is waiting on a permission prompt or a question. `Ctrl+Alt+N` (`Ctrl+Cmd+N` on macOS) opens the session that has waited longest. See [Notifications](notifications.md).

## Worktrees

### What is a git worktree, and why use one with a coding agent?

A git worktree is an extra working directory attached to a repository, checked out on its own branch. Coding agents edit the directory they run in, so two agents in one checkout step on each other. With a worktree per task, each agent has its own files and branch, and the work ends as separate branches you can review and merge one at a time.

### Where does Agntree create worktrees?

In a folder beside the repository, named `<repo>-worktrees`. A worktree for `feature/search` in `~/code/storefront` goes to `~/code/storefront-worktrees/feature-search`. See [Worktrees and repositories](worktrees.md#create-a-worktree).

### Can I use Agntree without git?

Yes. **Add Local Folder or Repository…** accepts any folder. Sessions run directly in it, and worktree, merge, rebase, and pull request actions appear if the folder later becomes a repository. See [Folders without git](worktrees.md#folders-without-git).

### Can an agent review a GitHub pull request?

Yes. Right-click a repository and choose **Check Out Pull Request…**. Agntree checks the pull request out into its own worktree, without touching your current branch, and you can start a session there. This needs the GitHub CLI (`gh`). See [Check out a pull request](worktrees.md#check-out-a-pull-request).

### Does deleting a worktree delete my sessions?

It removes the session rows under that worktree and closes their terminals. The agents keep the conversations. The confirmation tells you this, and warns you if the worktree has uncommitted changes.

## Agents and editors

### Which Claude Code versions are supported?

Claude Code 2.1.310 or newer. Agntree relies on that version's session, fork, and live-state behavior, and does not adapt to older versions.

### Can I use the Claude Code or Codex chat panel instead of a terminal?

Yes. A Claude Code or Codex session can open in its extension's chat panel, move back to a terminal, or start in the panel. Set `agntree.defaultSessionSurface` to make the panel the default. See [Agent panels](agent-panels.md).

### Does Agntree work with GitHub Copilot, Cline, or Aider?

Not today. Agntree supports Claude Code, Codex, opencode, and Pi. Each agent is one adapter in the code, so new agents can be added; [request one](https://github.com/subhashkhileri/agntree/issues/new?template=agent_request.yml) or see [CONTRIBUTING.md](../CONTRIBUTING.md).

### Does Agntree work on Windows?

Partly. Agntree is developed and tested on macOS and Linux. On Windows, the commands it types into a terminal are quoted for POSIX shells, which can fail for paths with spaces or special characters. Full Windows support is on the [roadmap](../ROADMAP.md).

### How is Agntree different from Orca, Paseo, and other agent apps?

Those are standalone desktop apps for running agents. Agntree is a VS Code extension: your agents sit beside the editor, extensions, and keybindings you already use, and there is no separate app to run. See [Comparison](comparison.md).

## Privacy and cost

### Does Agntree collect telemetry?

No. Agntree sends nothing to its author or to any third party.

### Does Agntree use my tokens or cost money to run?

Almost never. Listing, naming, resuming, and watching sessions read local files or ask the agent's CLI for a list; no model is called. The exception is **Find Session**, which runs an agent on your account when you ask a question.

### Does Agntree change my agent's configuration?

No. Agntree installs no hooks and edits no agent settings. It reads each agent's sessions through the interface that agent supports and starts the agent's CLI the way you would.

### Where does Agntree keep its data?

In VS Code's own extension storage on your machine: the folders you added, the session list, stars, and your last ten Find Session searches. The conversations themselves stay in each agent's storage.
