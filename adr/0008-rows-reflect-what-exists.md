# 0008 — A row exists only while its session does

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

Three symptoms had one cause: Agntree trusted a label instead of the state behind it.

1. VS Code keeps a terminal whose process exited in `window.terminals`, so a chat looked open and
   clicking it focused a dead tab. The row kept the finished-turn mark until the window reloaded.
2. A fork closed before its first prompt has no transcript — Claude writes none until the first
   prompt — so reopening it re-ran the fork against the source's current state. The fork point
   silently moved.
3. A linked chat whose transcript had been deleted offered only "Delete Chat".

## Decision

- A terminal is open only while its process runs (`exitStatus === undefined`). A dead tab is
  disposed and a fresh terminal is launched; restart sync does not re-associate it.
- Opening a chat that already has a terminal focuses it and mints no pending ID.
- Closing a fork with no transcript drops the chat (`dropUnusedFork`). A fork whose first prompt
  produced a transcript stays for the watcher to link. A plain pending chat is kept, because
  relaunching it with the same ID is deterministic.
- A linked chat whose session is gone warns that it cannot be reopened and offers Delete Chat. It
  does not start a new session.
- A fork source is validated before creating a worktree, so a missing transcript fails before the
  destructive step.
- Tree refresh after a launch is best-effort; a `reveal()` rejection is not surfaced.

## Alternatives

- **Trust `window.terminals`.** Exited tabs are listed, so the row lies.
- **Keep unused forks.** The row can only offer a fork of a moving source.
- **Auto-start a new session when the linked one is gone.** Leaves `harnessSessionId` pointing at
  nothing, with no watcher registration.
- **Prompt on close.** Closing a terminal is frequent and casual; a prompt there trains the user
  to dismiss it.
- **Create the worktree before validating the fork source.** Leaves a worktree behind on failure.

## Consequences

- A dead terminal no longer needs a window reload to clear.
- Closing an unused fork loses its row; re-forking is one click.
- A fork row whose process exited without a close event can still be reopened, and that reopen
  re-forks from the source's current state. This is the one remaining path where the fork point
  can move; the row is gone as soon as the close event arrives.
- The missing-session warning is the only recovery path for a deleted transcript; there is no
  silent fallback.
