# 0007 — Claude metadata is deliberately lean

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

The transcript parse extracted recap (`away_summary`), model and token usage, `gitBranch`, and a
message count. After the quiet-layout redesign the tree shows only a relative time or `new`, a
star, and the harness mark; the tooltip shows the summary, the last exchange, and the last
activity; import rows show no branch or message count. None of the extra fields reached the UI,
and all of them were parsed on every full read. opencode and Codex still fill their own metadata.

## Decision

- Keep: session ID, `cwd`, summary, last activity, recent user prompts, last ask and reply, turn
  state, and `hasMessages` for resume validation.
- Drop: recap, its timestamp, model, tokens, `gitBranch`, and message count.
- `toHarnessSession` and `getSessionMetadata` return `recap: null` and `messageCount: 0`
  ("unknown"), so the shared shapes do not change and other harnesses are untouched.

## Alternatives

- **Keep parsing them.** Cost and drift with no consumer; each field also has to stay correct
  across transcript format changes.
- **Move metadata to the Agent SDK.** Not part of the supported surface for this extension.
- **Keep a separate lightweight usage path.** There is no cheap native source for it.

## Consequences

- Tooltips have no usage footer; import rows have no branch or message count.
- `messageCount: 0` means unknown. Do not render "0 messages".
- Resume validation uses `hasMessages`, not a count.
- [`ROADMAP.md`](../ROADMAP.md) tracks restoring recap or usage if a cheap native source appears.
