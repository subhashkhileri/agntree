# Changes and files

The **Changes** and **All Files** panels show what is in the worktree you are working on. Select a worktree or a session in the Workspaces view and both panels follow it, so you can see what an agent changed in any branch without opening that branch in VS Code.

Both panels name the worktree in their title, for example `Changes (feature/search ~ storefront)`.

## Review what the agent changed

The Changes panel lists the worktree's uncommitted changes in two sections:

```
▾ Staged Changes        2 files · +48 -3
▾ Changes               3 files · +120 -14
    search.ts           src/api · M +86 -9
    search.test.ts      src/api · A +34
```

Each section shows the number of files and the lines added and removed. Each file shows its directory, its status (`M` modified, `A` added, `D` deleted), and its own line counts.

Select a file to open its diff. It opens in the second editor column, beside the agent's tab, so you can read the change while the agent keeps working. The diff uses the layout you use for every other diff in VS Code.

| Action | Where |
| --- | --- |
| **Stage File** | The **+** on a file under Changes |
| **Unstage File** | The **−** on a file under Staged Changes |
| **Discard Changes** | The discard icon on a file under Changes |
| **Stage All Changes**, **Discard All Changes** | The Changes section header |
| **Unstage All Changes** | The Staged Changes section header |

Discarding asks first. Discarding an untracked file moves it to the Trash instead of deleting it, so it can be recovered.

A renamed file is listed as a deletion and an addition, which are the two changes you can stage, unstage, or discard. A plain folder shows "Not a git repository" instead of a list.

The panel refreshes as files change. It stays fast in a large change set, because it lists each section with two `git` calls no matter how many files changed.

### During a rebase

If [**Rebase onto Upstream…**](worktrees.md#merge-and-rebase) stops on a conflict, the Changes panel shows the rebase with its current step and three actions: **Continue Rebase**, **Skip Commit**, and **Abort Rebase**. Resolve the conflicts, stage the files, and continue.

## Browse and edit files

The All Files panel is a file browser for the same worktree. Folders are listed first. Select a file to open it.

Actions in the panel's title bar: **Search in Files**, **New File…**, **New Folder…**, **Paste**, and **Refresh**. On the right-click menu of a file or folder:

| Group | Actions |
| --- | --- |
| Open | **Open to the Side** |
| Locate | **Reveal in File Manager**, **Open in Integrated Terminal** |
| Paths | **Copy Path**, **Copy Relative Path** |
| Clipboard | **Copy**, **Cut**, **Paste** |
| Create | **New File…**, **New Folder…** |
| Edit | **Rename…**, **Delete** |

With the panel focused, `F2` renames, `Delete` (`Cmd+Backspace` on macOS) deletes, and `Ctrl+C`, `Ctrl+X`, and `Ctrl+V` (`Cmd` on macOS) copy, cut, and paste.

## Safety

File operations in these panels are narrow by design:

- They only act **inside the worktree** the panel shows. A path outside it is refused.
- **Delete moves to the Trash** and asks first.
- **Creating and pasting never overwrite** an existing file.
- Every delete, discard, and refusal is recorded in the **Agntree Operations** output channel (**View → Output**, then pick it from the list).

## Related

- [Worktrees and repositories](worktrees.md)
- [Keyboard shortcuts](reference/keyboard-shortcuts.md)
