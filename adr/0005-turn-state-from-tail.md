# 0005 — Turn state comes from a progressive transcript tail

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

The attention service polls every four seconds. It used to re-parse each active transcript in
full: 60 MB took 272 ms, 20 MB took 100 ms, 5.5 MB took 31 ms. The deciding entries are at the
end — the last non-sidechain conversation entry's `stop_reason` and the latest
`turn_duration.pendingBackgroundAgentCount` — but the distance from EOF varies. In a live
background-agent session the latest `turn_duration` was 196 KB from the end, which a 64 KB
window missed.

## Decision

- Read the last 16 KB, then grow the window fourfold (64 KB, 256 KB, 1 MB, 4 MB, …) until the
  deciding entries are found or the window covers the file.
- Drop a partial first line; ignore an incomplete last line.
- Derive state with one shared function, also used by the full parser: a user entry, an
  assistant entry with a null or `tool_use` stop reason, or a positive pending-agent count means
  working; otherwise the turn ended at that entry's timestamp.
- Do not fall back to a full parse; the reader expands to the start of the file instead.
- Do not keep the pre-`turn_duration` marker fallback ([0002](0002-claude-2-1-310-only.md)).

## Alternatives

- **Full parse on every tick.** 100–270 ms per session on large files, every four seconds.
- **Fixed 64 KB window.** Misses the 196 KB case.
- **A separate incremental parser.** Two derivations of the same rule drift apart.
- **Trust `claude agents --json` for turn state.** It is process-level and reports `idle` while
  a background agent outlives the parent turn ([0006](0006-needs-you-from-agents-json.md)).

## Consequences

- A 256 KB tail costs about 1 ms per tick on typical files.
- Worst case, deciding entries near the start of a file mean reading the whole file — never more
  than the full parse it replaced.
- An empty transcript reports working; an unreadable one is omitted.
- A session with background agents stays working until the counter reaches zero, and its
  finished-turn notification waits for that.
