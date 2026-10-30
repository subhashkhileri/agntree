# Architecture decision records

An ADR records a decision that is expensive to reverse, what it replaced, and the evidence
behind it. It is not a design document and not a changelog: read [`ARCHITECTURE.md`](../ARCHITECTURE.md)
to learn how a subsystem works today, and the ADR to learn why it is shaped that way.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-native-claude-session-identity.md) | Choose the Claude session ID up front; fork natively | Accepted |
| [0002](0002-claude-2-1-310-only.md) | Support Claude Code 2.1.310+ only, with no compatibility layer | Accepted |
| [0003](0003-discovery-physical-path.md) | Discovery follows Claude's physical path encoding | Accepted |
| [0004](0004-message-gated-linkage.md) | Link on messages, keep pending state bounded | Accepted |
| [0005](0005-turn-state-from-tail.md) | Turn state comes from a progressive transcript tail | Accepted |
| [0006](0006-needs-you-from-agents-json.md) | Needs-you comes from `claude agents --json`, not hooks | Accepted |
| [0007](0007-lean-claude-metadata.md) | Claude metadata is deliberately lean | Accepted |
| [0008](0008-rows-reflect-what-exists.md) | A row exists only while its session does | Accepted |
| [0009](0009-restored-terminals-keep-their-chat.md) | Restored terminals keep their chat by title and PID | Accepted |
| [0010](0010-claude-ui-handoff.md) | Hand an existing Claude session to the Claude Code UI | Accepted; new-session path superseded by 0012 |
| [0011](0011-codex-ui-handoff.md) | Hand an existing Codex thread to the Codex extension UI | Accepted; new-session path superseded by 0012 |
| [0012](0012-session-import-and-surface-choice.md) | Import native sessions, name them from the harness, and choose the surface | Accepted |

## Writing one

1. Copy the shape of an existing record: status and date, context, decision, alternatives,
   consequences. Add an evidence section when measurements or CLI behavior drove the choice.
2. Number sequentially. Never renumber.
3. A decision is `Proposed` until it ships, then `Accepted`. To change an accepted decision,
   write a new ADR and mark the old one `Superseded by 00xx`. Do not rewrite history.
4. Record what is hard to reverse and non-obvious. Implementation detail, bug-fix notes, and
   verification checklists belong in the PR and the code.
5. Link the record from the `ARCHITECTURE.md` section it explains, and from `AGENTS.md` when it
   changes the working agreement.
