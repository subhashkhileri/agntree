# Keyboard shortcuts

Agntree's default shortcuts use `Ctrl+Alt` on Windows and Linux and `Ctrl+Cmd` on macOS, so they stay clear of VS Code's own. Every one can be changed.

## Anywhere in VS Code

| Windows and Linux | macOS | Action |
| --- | --- | --- |
| `Ctrl+Alt+N` | `Ctrl+Cmd+N` | Go to Next Session That Needs You |
| `Ctrl+Alt+Enter` | `Ctrl+Cmd+Enter` | New Session with your default agent, in the current worktree |
| `Ctrl+Alt+F` | `Ctrl+Cmd+F` | Find Session… |
| `Ctrl+Alt+S` | `Ctrl+Cmd+S` | Starred Sessions… |
| `Ctrl+Alt+A` | `Ctrl+Cmd+A` | Show the Agntree sidebar |

## In the Workspaces view

With a session selected:

| Windows and Linux | macOS | Action |
| --- | --- | --- |
| `F2` | `F2` | Rename Session… |
| `Delete` | `Cmd+Backspace` | Remove Session from List… (works on several selected sessions) |
| `Ctrl+C` | `Cmd+C` | Copy Resume Command |

## In the All Files panel

With a file or folder selected:

| Windows and Linux | macOS | Action |
| --- | --- | --- |
| `F2` | `F2` | Rename... |
| `Delete` | `Cmd+Backspace` | Delete (moves to the Trash) |
| `Ctrl+C` | `Cmd+C` | Copy |
| `Ctrl+X` | `Cmd+X` | Cut |
| `Ctrl+V` | `Cmd+V` | Paste |

## Change a shortcut

Choose **Agntree Keyboard Shortcuts…** in the Agntree `…` menu. VS Code's Keyboard Shortcuts editor opens with Agntree's commands. There you can change or remove any shortcut, and give a key to any other Agntree command, such as **Fork Session Here** or **Open Session in Terminal**. Session and file commands act on the selected row when run from a key.

## A keyboard-only loop

With a default agent set (**Set Default Agent…**), a whole working loop needs no mouse:

1. `Ctrl+Alt+Enter` starts an agent in the worktree you are in.
2. Give it a task, then start or switch to another.
3. `Ctrl+Alt+N` takes you to whichever agent finished or needs you first.
4. `Ctrl+Alt+F` finds a session from last week by description.

## Related

- [Commands and menus](commands.md)
- [Settings](settings.md)
