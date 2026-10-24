# 0001 — Native Claude session identity

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

Chats were linked to Claude sessions by watching the project directory and claiming the first
transcript nobody had claimed yet. Two chats launched in the same worktree could claim each
other's transcripts, and a chat did not know its session ID until after the first prompt.
Forks copied the entire source project directory into the destination, which duplicated
transcripts and needed collision handling. Reopening a chat before its first prompt started a
fresh session instead of continuing the one the user had created.

Claude Code 2.1.310 accepts a caller-chosen session ID and writes the transcript under it.

## Decision

Choose the session ID before launch and link exactly that ID:

- New chat: `claude --session-id <uuid>`.
- Fork: `claude --resume <source> --fork-session --session-id <new>`, run in the destination
  working directory.
- Store the chosen ID as `pendingHarnessSessionId` until the transcript links; store the fork
  source as `forkedFromSessionId` for the same window.
- Never copy a project directory, and never claim a transcript that no chat chose.

## Alternatives

- **Claim the newest unseen transcript.** Racy by construction: the claim depends on scan
  timing, and concurrent launches in one worktree are indistinguishable.
- **Copy the project directory for forks.** Duplicates files, needs `errorOnExist` guards and
  orphan cleanup, and leaves the destination with two transcripts after the first prompt.
- **Let Claude assign IDs and discover them afterwards.** There is no reliable way to tell
  which launch produced which transcript.

## Evidence

- A chosen ID is honored for a new session and for a fork: the transcript appears under the
  chosen file name, and the fork's copied entries keep the source's message UUIDs while
  carrying the new `sessionId`.
- Claude writes no transcript until the first user prompt, so a chat correctly stays `new`
  until then.
- `--session-id` requires a valid UUID, which is why IDs are generated as v4 (`generateId()`).
- `--bg` overrides `--session-id` ("`--bg manages the session id`"), so a chosen ID is
  authoritative only for an interactive launch.

## Consequences

- Linkage is deterministic: two chats in one worktree cannot claim each other's sessions.
- A chat shows `new` until its first prompt; the pending ID survives an extension-host restart
  and is reused if the chat is reopened.
- A terminal fork needs its source until the fork transcript exists; that is one more stored
  field, and it is cleared once the watcher links the fork.
- Deleting a chat discards the pending ID; nothing is left behind in the harness.
