# 0015 — Observe Pi sessions through their documented transcript

- **Status:** Accepted
- **Date:** 2026-11-11

## Context

Agntree launches each harness's native TUI in a terminal and observes the session from
outside. opencode is the only harness that serves live state to another process; Claude and
Codex are read from their transcripts and rollout files. Pi 1.5.2 has the richest event model
of the four, but every event surface requires the observer to own the Pi process:

- `pi --mode rpc` "runs Pi as a long-lived subprocess controlled through JSON records on
  stdin and stdout". It accepts commands such as `get_state` (`isStreaming`, `isCompacting`,
  `messageCount`, `pendingMessageCount`), `get_messages`, `switch_session`, and `fork`, and
  streams run, message, tool, compaction, and retry events, including `agent_settled`.
- Extensions use `pi.on(...)` for in-process hooks, including `agent_start`, `agent_settled`,
  `turn_end`, `message_*`, `tool_*`, and `session_*`; the SDK exposes `session.subscribe()`.
- There is no documented attach, subscribe, or session-list command for a TUI started
  elsewhere, and no documented socket or WebSocket transport. The `transport` setting
  configures AI provider connections, not RPC.

Pi does document and version the session JSONL: the header carries `version: 3`, older
sessions migrate on load, and the entry and message shapes are described in
`docs/session-format.md` and `docs/message-types.md`. The one signal the file cannot carry is
`agent_settled`: Pi emits it when no retry, compaction, steering, or queued follow-up will
continue automatically, but it is an event, not a persisted entry.

## Decision

- **The TUI owns the session.** Agntree chooses the ID up front, launches
  `pi --session-id <id>`, and reopens with `pi --session <record path>` (falling back to
  the ID when the record is not found); forks use
  `pi --fork <source> --session-id <new>`. The CLI remains the lifecycle boundary.
- **Observation uses the documented transcript.** Discovery, metadata, previews, and turn
  state come from the session JSONL, with the same progressive tail Claude uses.
- **Turn state is the last persisted message.** A user or tool-result entry, or an assistant
  entry with `stopReason: "toolUse"`, means working; any other assistant stop reason (`stop`,
  `length`, `error`, `aborted`, `deferred`) ends the turn at that message's timestamp.
- **Do not start or own an RPC process for a session the user will interact with.** RPC has
  no TUI, and a second Pi process cannot attach to a TUI-owned session.
- **Do not install an extension into the user's Pi profile** to relay events.

The accepted cost is that automatic retry, queued follow-ups, and compaction can briefly look
like a finished turn. That is tracked in `ROADMAP.md` as the settled-turn signal.

## Alternatives

- **Own `pi --mode rpc` as the chat session.** Gives exact events, but Pi runs headless in
  RPC mode, so Agntree would have to build the conversation UI (prompt entry, streaming,
  tool output, extension UI records, keys) and would stop launching the native TUI. A product
  rewrite, not a harness adapter.
- **Start RPC first, then open the TUI on the same session.** The RPC process does not
  observe the TUI process: each has its own runtime and in-memory message list. Pi has no
  session lock or handoff, so two appenders can diverge or interleave writes. Rejected as
  unsafe and useless as a watcher.
- **Start RPC only to create the record, then quit and resume in the TUI.** No gain: the ID
  is already chosen up front, the TUI still writes the transcript, and Agntree still tails
  it.
- **Poll `get_state` from a second RPC process.** It reports that process's state, not the
  TUI's, and reintroduces the second-writer problem.
- **A Pi extension bridge** (`pi.on("agent_settled", ...)` writing to a file or socket) would
  remove the transient caveat, but it installs third-party code and configuration into the
  user's Pi profile. Revisit only if Pi ships a native attach/subscribe endpoint or persists
  the settled state.

## Evidence

- Installed Pi 1.5.2, docs read locally: `docs/rpc.md`, `docs/rpc-commands.md`,
  `docs/extensions.md`, `docs/session-format.md`, `docs/sessions.md`, `docs/message-types.md`.
- A Codex-backed web search (the built-in search was unavailable) confirmed the same
  surface: RPC is stdio-only and client-owned; there is no documented attach, subscribe,
  session list, or WebSocket transport.
- A temp-profile probe confirmed Pi writes no record until the first conversational message,
  `--fork` writes the new record immediately, the header and entry shapes match v3, and
  terminal `stopReason` values appear as documented.
- The synthetic fixtures check the parser and the tail reader against each other at every
  step of a turn: user, tool use, tool result, terminal reply, new user, failed reply.

## Consequences

- Pi sessions follow the same architecture as Claude and Codex: exact chosen-ID linkage, a
  cheap four-second tail, and no extra process or configuration.
- The turn-end icon and notification can be a few seconds early during an automatic retry,
  queued follow-up, or compaction. No persisted signal distinguishes those today.
- `deferred` is treated as terminal. If Pi gives it continuation semantics, the rule needs
  revisiting.
- The format is documented and versioned, but Agntree does not gate on the header `version`,
  and discovery depends on the encoded directory name and `<timestamp>_<id>` filename, which
  come from Pi's source rather than its docs. A breaking v4 or a layout change would degrade
  silently (missing rows or wrong state), not throw. A header-version check and a recorded
  real-session fixture are the cheapest tripwires; add them when Pi announces a v4 or the
  layout moves.
- If Pi gains attach/subscribe or persists `agent_settled`, the change is confined to
  `PiHarness.getLiveStates()`, `PiSessionService.readTurnState()`, and
  `ExactIdSessionWatcher`'s source; commands and providers do not change.
