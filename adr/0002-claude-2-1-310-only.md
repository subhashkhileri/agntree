# 0002 — Support Claude Code 2.1.310 and newer only

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

The native session flags and `claude agents --json` are version-dependent. Supporting older
CLIs would mean a version probe, capability flags, a legacy transcript-claiming watcher, and
fallbacks for transcript shapes that predate `turn_duration.pendingBackgroundAgentCount`. Each
of those is a second code path that can drift from the supported one, and the project already
carries three harnesses.

## Decision

Claude Code 2.1.310 is the minimum supported version, verified against the local CLI. Add no
version detection, capability probe, legacy watcher, or transcript fallback. If a flag or
command is missing, the CLI's own error is the user-visible failure.

## Alternatives

- **Probe `--version` and branch.** Every supported feature then needs two implementations and
  two tests; the older path is the one nobody exercises.
- **Keep the old watcher for older CLIs.** It is the racy mechanism this work removed
  ([0001](0001-native-claude-session-identity.md)).
- **Parse older transcripts.** The pre-`turn_duration` background-agent markers are ambiguous,
  and the authoritative counter is available in every supported version.
- **Degrade silently.** A missing flag would produce a chat that never links, which is harder
  to diagnose than an error from the CLI.

## Consequences

- Users on older CLIs must upgrade; `README.md` and the `onNeedsInput` setting description say
  so.
- There is no `if (version)` branch in the Claude code. Upgrading the CLI is the fix for a
  missing flag.
- A future CLI change fails visibly instead of degrading.
- `--bg` sessions, duplicate-transcript cleanup from old forks, and incremental parsing for the
  full-metadata path stay deferred in [`ROADMAP.md`](../ROADMAP.md).
