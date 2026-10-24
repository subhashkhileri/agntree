# 0006 — Needs-you comes from `claude agents --json`, not hooks

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

"Needs you" — a permission prompt or a pending question — was delivered by hooks that Agntree
installed into `~/.claude/settings.json`. That required an install command, a matching removal
command, a context key, menu entries, and writing a file Agntree does not own. Nothing worked
without the install.

Claude 2.1.310 exposes `claude agents --json`: active interactive and background sessions with
`status` and `waitingFor`. It is documented as the external state interface, needs no TTY, and
costs about 0.22 s per call. It is process-level: it reports `idle` while a background agent
outlives the parent turn, and slash commands briefly report `busy`.

## Decision

- Read waiting state from `claude agents --json`; never write to the user's settings.
- Cache the parsed map for 10 s, share one in-flight call, and skip the call when
  `onNeedsInput` is off or no Claude terminal is active.
- Treat any non-empty `waitingFor` as needs-you, and fall back to `input needed` for
  `status: waiting` without a reason.
- Merge duplicate session IDs deterministically: a non-empty `waitingFor` wins, otherwise the
  newest `startedAt`.
- On failure, log once and disable the interface until the extension host restarts. Turn-end
  notifications are unaffected.
- Seed an already-waiting session during the priming tick, so an extension-host restart does not
  replay a notification.
- Remove the install and remove commands, the context key, the menus, and all settings access.

## Alternatives

- **Keep hooks.** Writes user configuration, needs consent, and maintains a surface outside this
  extension's data.
- **Treat process `idle` as turn-end.** Wrong while a background agent runs; turn state comes
  from the transcript tail instead ([0005](0005-turn-state-from-tail.md)).
- **Scrape the TUI.** Not machine-readable.
- **Poll per session.** One batched call covers every Claude session for the same cost.

## Consequences

- Agntree hook entries installed earlier remain in `~/.claude/settings.json` but are inert; users
  remove them by hand.
- Without the CLI — missing, failing, or disabled — there is no needs-you; finished-turn notices
  still work.
- `waitingFor` is undocumented, so parsing ignores unknown fields and tolerates a missing reason.
- Needs-you latency is bounded by the 10 s cache plus the four-second tick.
