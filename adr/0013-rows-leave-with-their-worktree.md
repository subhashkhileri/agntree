# 0013 — Session rows leave with their worktree

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

A chat is stored against a worktree id derived from its repository id and path
(`worktreeId()` in `GitService`). Removing a workspace root deleted only the repository
record, and deleting a worktree deleted only the directory, so their chats stayed in
`globalState` with nothing to render them under.

Those rows were not harmless. Re-adding a folder gives it a new repository id, so the old
rows never reappear, yet `SessionImportService` treats every stored `harnessSessionId` as
already linked. The sessions of a removed folder could therefore never be imported again,
automatically or by hand. Every read of `getChats()` also carried the dead rows.

## Decision

Extend [ADR 0008](0008-rows-reflect-what-exists.md) from sessions to their place:

- Deleting a worktree removes its session rows and closes their terminals, which would
  otherwise keep running in a deleted directory.
- Removing a workspace root does the same for every worktree git lists for it at that
  moment.
- These removals leave no tombstone (`rememberSession: false`): the user removed a
  place, not the conversations, so a re-added folder imports its recent sessions again,
  and older ones through **Import Sessions**.
- Both confirmations say what leaves the list and that the agents keep the
  conversations.

`forgetWorktrees()` in `extension.ts` is the one implementation; the repository and
worktree commands call it.

## Alternatives

- **Soft-remove roots again (`hidden`).** Re-adding would revive the old id and every row
  with its name and star, but hidden roots accumulate and every scan must keep skipping
  them. Pre-1.0 builds did this and it was removed; the legacy flag is only honored on
  re-add.
- **Garbage-collect rows whose worktree no longer lists.** A worktree on an unmounted
  drive or a transiently failing `git` would lose its rows.
- **Keep the rows.** Leaves the import blocked, as above.

## Consequences

- A re-added folder's sessions come back as new rows: custom names and stars are lost,
  and sessions older than the auto-import retention need a manual import.
- A worktree removed outside Agntree (for example `git worktree remove`) still leaves its
  rows, and removing the root does not reach them, because git no longer lists that
  worktree.
- `workspace-roots.test.ts` covers that Remove forgets every worktree of the root.
