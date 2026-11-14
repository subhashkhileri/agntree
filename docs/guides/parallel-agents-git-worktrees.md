# Run multiple agents in parallel with git worktrees

To run several coding agents at once without them overwriting each other, give each agent its own git worktree: a separate directory, on a separate branch, of the same repository. One task, one worktree, one agent. This guide shows the workflow by hand and then with Agntree in VS Code, for Claude Code, Codex, opencode, and Pi.

## Why agents need separate directories

A coding agent edits files in the directory it runs in. Start two agents in the same checkout and they share one set of files: one agent's half-finished edit breaks the other's test run, both change the same file, and the diff at the end mixes two tasks.

A git worktree fixes this at the source. It is a second working directory attached to the same repository:

- Each worktree has **its own branch and its own files**, so agents cannot collide.
- All worktrees share **one repository**, so there is nothing to clone or sync, and every branch is visible everywhere.
- Each task ends as **its own branch**, ready to review and merge by itself.

## The workflow by hand

Create a worktree and branch for a task, then start an agent in it:

```bash
cd ~/code/storefront
git worktree add ../storefront-worktrees/feature-search -b feature/search
cd ../storefront-worktrees/feature-search
claude
```

Repeat in a new terminal for each task. To see and clean up your worktrees:

```bash
git worktree list
git worktree remove ../storefront-worktrees/feature-search
```

This works with any agent. What it leaves to you is the bookkeeping: which terminal belongs to which branch, which agent has finished, which session to resume tomorrow, and which worktrees are safe to delete.

## The workflow with Agntree

Agntree keeps the same git worktrees and adds the bookkeeping. Everything below happens in one VS Code window.

### 1. Add your repository

Open the Agntree sidebar and choose **Add Local Folder or Repository…**. The repository appears with its current worktree.

### 2. Create a worktree for each task

Hover the repository and select **Create Worktree…** (**+**). Choose **New branch**, pick the base branch, and name the branch after the task. Agntree puts the worktree in a `<repo>-worktrees` folder beside the repository.

Do this once per task. Three tasks give you three rows under the repository.

### 3. Start an agent in each worktree

Hover a worktree and select **New Session** (**+**), then choose the agent. A terminal opens in that worktree with the agent running. Give it the task, then move to the next worktree and do the same.

You can mix agents. Claude Code on one branch and Codex on another is fine, and so are two different agents on the same branch when you want a second opinion.

### 4. Let them work, and go where you are needed

The mark on each session shows its state: pulsing while the agent works, a green dot when its turn is done. You do not have to watch.

- A notification appears when an agent you are not looking at finishes, or when Claude Code is waiting on a permission prompt.
- `Ctrl+Alt+N` (`Ctrl+Cmd+N` on macOS) takes you to the session that has waited longest. Press it again for the next one.

### 5. Review each branch

Select a session, and the **Changes** panel shows what that agent changed in that worktree: files, line counts, and a diff on click. Stage what is good, discard what is not, or tell the agent what to fix.

### 6. Merge and clean up

When a task is done, commit it and open a pull request as usual, or right-click the worktree you want to merge into and choose **Merge Branch into This Worktree…**. Then right-click the finished worktree and choose **Delete Worktree…**. The sessions' conversations stay with their agents.

## Try two approaches at once

Parallel work is not only for separate tasks. To explore two solutions to one problem:

1. Get a session to the point where the agent understands the problem.
2. Right-click it and choose **Fork Session to New Worktree…**.

Agntree creates a new branch and worktree from the same commit, copies your uncommitted changes, and forks the conversation into it. Both agents now continue from the same starting point in separate directories. Keep the better branch and delete the other. See [Fork a session](../fork-sessions.md).

## Review a pull request in its own worktree

Right-click the repository and choose **Check Out Pull Request…**. Agntree checks the pull request out into a new worktree without touching your current branch. Start a session there and ask the agent to review or test the change while your own work carries on in another worktree.

## Tips

- **Keep tasks independent.** Two agents that both need to change the same module will produce a merge conflict later, worktrees or not. Split work along boundaries that rarely overlap.
- **Install dependencies per worktree.** A new worktree contains only tracked files. Ignored files such as `node_modules`, build output, and `.env` are not there until you install, build, or copy them.
- **Name branches after the task.** The branch name is the row you will look for in the sidebar.
- **Star the sessions you will come back to.** Starred sessions stay in the list for good, and `Ctrl+Alt+S` (`Ctrl+Cmd+S` on macOS) lists them.
- **Delete worktrees when their branch is merged.** A short list is easier to steer.

## Related

- [Worktrees and repositories](../worktrees.md)
- [Notifications](../notifications.md)
- [Claude Code](../agents/claude-code.md), [Codex](../agents/codex.md), [opencode](../agents/opencode.md), and [Pi](../agents/pi.md)
