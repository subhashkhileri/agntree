# Worktrees and repositories

A git worktree is a second checkout of the same repository in its own directory, on its own branch. Agntree makes worktrees the unit of agent work: one worktree per task, one or more agent sessions inside it, and no two agents editing the same files. This page covers adding repositories, creating and removing worktrees, and the git actions on them.

For the workflow as a whole, read [Run multiple agents in parallel with git worktrees](guides/parallel-agents-git-worktrees.md).

## Add a folder or repository

In the **Workspaces** view, select **Add Local Folder or Repository…** (the folder icon in the view's title) and pick a folder.

- A **git repository** is listed with its worktrees beneath it. If you pick a directory inside a repository, Agntree adds the repository's root.
- A **plain folder** is listed with its sessions directly beneath it. See [Folders without git](#folders-without-git).

To start from GitHub instead, choose **Clone from GitHub…** in the view's `…` menu, enter a URL or `owner/repo`, and pick the parent folder. Agntree clones the repository and adds it.

Repositories do not need to be open in VS Code, and you can add as many as you like. Reorder them with **Move Up** and **Move Down** on the right-click menu.

## Read a worktree row

```
▾ storefront
  ▸ main                    ●
  ▸ feature/search          ↑2 · ↓1 · PR #184
  ▸ checkout-tax-rounding   PR #212
```

| You see | It means |
| --- | --- |
| Amber target icon and `●` | The folder this VS Code window has open |
| Green branch icon | The repository's main worktree |
| Blue pull-request icon | A worktree created by **Check Out Pull Request…** |
| `↑2` / `↓1` | Commits ahead of and behind the branch's upstream |
| `PR #184` | The branch has a pull request on GitHub (needs the `gh` CLI) |

The tree refreshes by itself when you switch branches or add a worktree from the command line.

## Create a worktree

Hover a repository and select **Create Worktree…** (**+**), then choose where the branch comes from:

| Option | What it does |
| --- | --- |
| **Existing branch** | Checks out a branch that is not already in a worktree |
| **New branch** | Asks for a base branch and a name, then creates the branch |
| **From upstream** | Fetches the `upstream` remote and bases a new branch on one of its branches. Shown when the repository has an `upstream` remote |

Agntree creates the worktree in a folder beside the repository, so worktrees never clutter the repository itself:

```
~/code/storefront/                    the repository
~/code/storefront-worktrees/
    feature-search/                   worktree for feature/search
    fix-cart-total/                   worktree for fix/cart-total
```

Then hover the new worktree and select **New Session** (**+**) to start an agent in it.

## Check out a pull request

Right-click a repository and choose **Check Out Pull Request…**, or pick it from the Workspaces `…` menu. Select an open pull request from the list, or enter a number or URL.

Agntree fetches the pull request into a local branch named `pr-<number>` and creates a worktree for it, so reviewing a PR never disturbs the branch you are on. This works for pull requests from forks. Start a session in the new worktree to have an agent review, test, or extend the change.

**Open Pull Request in Browser** on any worktree opens the pull request for its branch.

Pull request features need the [GitHub CLI](https://cli.github.com/) (`gh`), signed in.

## Work in a worktree

Selecting a worktree or one of its sessions points the [Changes and All Files panels](changes-and-files.md) at it. The worktree's right-click menu has the rest:

| Action | What it does |
| --- | --- |
| **New Session** | Start any installed agent here |
| **Import Existing Sessions…** | Add sessions the agents already hold for this directory |
| **Open in This Window** | Make this worktree the folder VS Code has open, so the Explorer, search, and Source Control follow |
| **Open in New Window** | Open the worktree in its own VS Code window |
| **Open Terminal Here** | A plain terminal in the worktree |
| **Copy Path** | Copy the worktree's directory |

To have VS Code follow your selection automatically, turn on [`agntree.autoSwitchWorkspaceFolder`](reference/settings.md#window). VS Code restarts its extensions on each switch, which shows as a short flicker.

## Merge and rebase

**Merge Branch into This Worktree…** merges another worktree's branch into the one you right-clicked. Agntree warns first if the target has uncommitted changes, and on a conflict it offers a terminal in the worktree so you can resolve and commit.

**Rebase onto Upstream…** fetches your remotes and rebases the worktree's branch onto the remote branch you pick. The first of `upstream/main`, `upstream/master`, `origin/main`, and `origin/master` that exists is recommended. Before it starts, Agntree shows which files would conflict and whether uncommitted changes will be stashed. If the rebase stops on a conflict, **Continue**, **Skip Commit**, and **Abort** appear in the Changes panel.

## Delete a worktree

Right-click a worktree and choose **Delete Worktree…**. The confirmation says exactly what will be lost, and offers:

- **Delete Worktree Only**, which keeps the branch, or
- **Delete Worktree & Branch**.

Deleting a worktree removes its directory from disk; it does not go to the Trash. If the worktree has uncommitted changes, the confirmation warns you and the buttons say **(force)**. Session rows under the worktree leave the list and their terminals close, but the agents keep the conversations. The main worktree cannot be deleted.

## Remove a repository from Agntree

Right-click a repository or folder and choose **Remove from Agntree…**. This only removes it from the sidebar: your files, the git repository, and the agents' conversations are untouched. Add the folder again and **Import Existing Sessions…** brings its sessions back.

## Folders without git

Any folder can hold sessions, even an empty one. A plain folder gets a folder icon, and its sessions sit directly under it with no worktree level.

If the folder becomes a repository, for example because you or an agent runs `git init`, Agntree upgrades the row and keeps every session where it was. Actions that need git (creating a worktree, merge, rebase, pull requests) appear from then on.

## Folders inside folders

If you add both a folder and a repository inside it (say `~/code` and `~/code/storefront`), each session is listed once, under the deepest added folder that contains it.

## Related

- [Fork a session into a new worktree](fork-sessions.md#fork-into-a-new-worktree)
- [Commands on repository and worktree rows](reference/commands.md#repository-and-folder-rows)
