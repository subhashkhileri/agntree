# 0009 — Restored terminals keep their chat

- **Status:** Accepted
- **Date:** 2026-10-25

## Context

Agntree opens each chat in an editor terminal, and the extension host can restart while
those terminals keep running. VS Code preserves two different things:

- A **window reload** keeps the pty. The new extension host sees the same terminal with
  the same `terminal.processId`, but its in-memory map from chat to terminal is gone.
- A **quit and reopen** does not keep the pty. VS Code serializes each editor terminal
  and revives it as a new shell with a new PID. It keeps the tab title, not the process.

One identifier cannot cover both. A title is all that survives a quit, but it says
nothing about what is running underneath; a PID proves what is running, but it is
replaced when the tab is revived. Matching by title alone cannot distinguish a live
agent from a shell that only looks like it, so a reload could type a resume command into
a running session.

The title itself is also fragile if it is applied too early. In a probe on VS Code
1.143.1, an editor terminal was serialized with an empty `cwd`, which makes every
revived shell report a working directory. That report re-tags the title as a config
title (`titleSource: 3`), after which the shell's own title (`zsh`) wins. A title applied
when the terminal was created did not survive. A rename issued after
`onDidStartTerminalShellExecution` left the title as an explicit custom title, which was
serialized and restored.

## Decision

An Agntree terminal keeps two identities, one per restore mode.

1. **The custom title is the identity across a quit.** Every terminal mapped to a chat
   carries exactly `Agntree: <chat name> [<shortId>]`. `TerminalManager.getTerminalName()`
   is the only formatter. `parseTerminalShortId()` accepts a name only when it starts
   with `Agntree: ` and ends with a six-character id, so a terminal Agntree did not
   create is never claimed.
2. **The recorded PID is the identity across a reload.** `globalState` holds
   `agntree.terminalPids: Record<workspacePath, Record<chatId, pid>>`.
   `TerminalManager` writes an entry when a launched terminal's PID resolves, keeps it
   when the tab closes (VS Code fires close events on quit), and removes it when the
   chat is deleted, in every workspace that recorded it. It does not live on
   `ChatSession`: the record describes one workspace's terminal, not the chat. The
   outer key exists because `workspaceState` is replaced when the workspace folder
   changes, and `agntree.autoSwitchWorkspaceFolder` changes it from inside Agntree; a
   workspace-scoped record would forget every running terminal on that switch. A record
   written by an earlier development build in `workspaceState` is migrated on first
   read.
3. **A terminal is adopted only while its PID is live.** During activation,
   `beginRestoreSync()` adopts a terminal whose PID matches a recorded chat and never
   sends input into it. Adoption reads PIDs and storage only, so `activate()` awaits
   it before registering commands; the reload path is silent and cannot start a second
   agent.
4. **A revived tab is resumed in place, in its own worktree.** A tab whose title maps
   to a chat this workspace recorded, and whose current PID differs from the record, is
   a revived shell. The tab's shell starts in the workspace root, while the harness
   commands use the process working directory, so the launch is
   `cd <quoted worktree> && <launch command>`. The two commands are one shell line, so
   the command-start event covers the launch and a failed `cd` cannot start an agent in
   the wrong tree. Resuming happens in the background, without focusing any tab and
   without the missing-session warning that would interrupt startup. Only one tab per
   chat is resumed when duplicate titles exist; the rest stay plain shells.
5. **The title is applied after the command starts.** `openChat()` waits for the PID
   and, when shell integration is enabled, for the command-start event, then activates
   the tab and renames it. With `terminal.integrated.shellIntegration.enabled: false`
   no command-start event can arrive and no cwd report re-tags the title, so the wait is
   skipped. The focus and shell-integration listeners re-apply the title if VS Code or
   the user changes it. A rename targets only the active terminal, so `applyTitle()`
   requires the caller to activate the tab first. Writes are serialized and re-check the
   active tab when they run, so overlapping focus changes cannot rename one chat's tab
   with another chat's title. Revived tabs are retitled by a background pass that
   activates each tab without focus, marks that activation as manager-initiated so the
   extension's selection handler ignores it, and restores the previously active tab; it
   stops if the user takes over.
6. **Unprovable cases are left alone.** No recorded PID, an ambiguous short id, an
   unlinked fork (which exists only inside the process that closed), a missing worktree,
   or an exited terminal means no resume. The ownership sweep marks only recorded chats
   as idle, so chats this workspace never opened are untouched.
7. **A restored chat without a native session is registered with its harness watcher
   again.** The watcher's pending registration is in memory and dies with the extension
   host. Adoption and background resume register the chat before its next prompt creates
   a session, so the session is linked instead of leaving the chat unstarted. Chats that
   already have a native session are not registered.

## Consequences

- Restoring after a quit depends on the custom title. A tab renamed by hand before the
  quit has no short id; focusing it re-applies the Agntree title, but that quit cannot
  resume it.
- A resumed tab is changed into its chat's worktree with POSIX shell quoting. Windows
  shells need the platform-specific quoting tracked in `ROADMAP.md`.
- With shell integration disabled, opening a chat skips the command-start wait: no cwd
  report re-tags the title, so the name from `createTerminal()` is already durable. A
  shell that never reports integration with the setting enabled (for example `cmd`)
  still waits out the bounded command-start timeout before skipping the rename.
- The retitle pass briefly activates each revived tab. It runs in the background, marks
  those activations as manager-initiated so the tree and panels do not follow them,
  stops when the user changes the active terminal, and any tab it did not reach is
  retitled when focused.
- PIDs live in `globalState` under the workspace folder path, so Agntree's own
  `autoSwitchWorkspaceFolder` cannot erase them. Restore assumes one window per
  workspace; a second window does not share the first window's terminals, and records
  for workspaces that are no longer open remain until their chats are deleted.
- Adoption is bounded and runs before `activate()` registers the views and commands;
  resuming revived tabs asks the harness whether each session exists and runs
  afterwards. Until a resumed tab finishes that check, `openChat` focuses it rather than
  starting a second agent.
- The mechanism is harness-agnostic: it only replays the adapter's launch command, so a
  new harness gets restore behavior without a harness conditional.
- VS Code 1.93+ is required for the shell-integration events that make the title durable.

## Evidence

- Probe on VS Code 1.143.1 (macOS, zsh): a reload kept `terminal.processId`; a quit
  serialized the editor terminal with `cwd: ""` and `titleSource: 0`, and the revived
  shell's cwd report re-tagged the title as source 3, replacing it with `zsh`. Renaming
  after `onDidStartTerminalShellExecution` kept the Agntree title through the next quit.
- `npm run test:e2e` with three chats in linked worktrees that are **not** the
  workspace folder: `default`, `no-shell-integration`, and `custom-tab-title` each
  produced three resume launches per reopen cycle (nine total), every launch ran with
  its cwd equal to the chat's worktree, and the expected tab stayed active;
  `persistent-sessions-off` and `revive-never` produced no resume, as intended.
- `terminal.test.ts` covers PID adoption, late adoption through `onDidOpenTerminal`,
  revived-tab resume with the worktree `cd`, duplicate-title de-duplication, watcher
  re-registration on both restore paths, the ownership sweep, adoption finishing before
  a deliberately slow resumability check, `openChat` focusing the tab during that
  check, title re-application with a stubbed `vscode` surface (including overlapping
  title writes), background activations not reported as user focus changes, a failing
  late adoption staying contained, and an open that skips the command-start wait when
  shell integration is disabled. `storage.test.ts` covers per-workspace PID records,
  their survival across a workspace-folder change, legacy migration, and deletion;
  `tree.test.ts` covers caching each repository's worktree list once.
- Before the fix, a dry reproduction showed two same-titled tabs both receiving
  `claude --resume linked-session`, a deferred `renameWithArg` applying A's title to B
  when focus changed before the rename ran, and an unregistered Codex chat never
  claiming a thread announced by the fake app-server. The regression cases above encode the corrected
  behavior.
