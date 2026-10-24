# 0004 — Link on messages, keep pending state bounded

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

With a chosen session ID ([0001](0001-native-claude-session-identity.md)), linkage is "wait for
this exact transcript". A transcript file can exist before it holds anything resumable — an
interrupted launch, or a first prompt still being written. The first implementation linked on
file existence, which stranded those chats. It also re-registered a pending chat on every open,
resetting the scan baseline so the ID could become unclaimable; it polled abandoned chats
forever; and it rescanned for a missing transcript on every four-second attention tick.

## Decision

- Link only when the transcript is resumable, meaning it contains at least one message
  (`hasMessages`). Keep the pending ID until then.
- Persist the pending ID, and make registration idempotent: keep the original baseline unless
  it is stale, and skip registration when a terminal will merely be focused.
- Stop watching a pending chat that is not active after five minutes. The ID stays stored.
- Cache a missing transcript path for 30 seconds.
- Gate `fs.watch` work on an in-memory set of pending IDs, so appends to any other transcript
  cost nothing.
- Bound pending-idle name monitoring with a TTL instead of stopping a chat's monitor on its
  first inactive tick.

## Alternatives

- **Link on file existence.** Strands an empty or interrupted transcript: the chat looks linked
  but cannot be resumed.
- **Reset the baseline on every open.** A second open can make a pending ID unclaimable;
  focusing a chat must not change linkage state.
- **Poll forever.** Abandoned chats keep scanning project directories.
- **No negative cache.** Every attention tick rescans for a transcript that is not there.
- **Mint a speculative ID before checking for a terminal.** Leaves a phantom ID on a chat whose
  terminal is reused.

## Consequences

- A chat stays `new` until the first prompt writes something worth resuming.
- An abandoned pending chat stops consuming work after five minutes but remains in storage; it
  is registered again if opened.
- Reopening a plain pending chat relaunches the same ID, which is why that row is kept. Forks
  are the exception ([0008](0008-rows-reflect-what-exists.md)).
- Linkage work is proportional to the number of pending chats, not to filesystem activity.
