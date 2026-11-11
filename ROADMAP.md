# Roadmap

This roadmap records direction, not commitments. Shipped changes are documented in
[`CHANGELOG.md`](CHANGELOG.md); open design questions for work in progress live with the
implementation rather than here.

Status values: **planned**, **exploring** (not scheduled).

## Planned

- **Codex archived sessions.** Decide whether import and search include archived threads.
  Find Session currently reads every rollout under `~/.codex/sessions`, and a rollout does
  not record whether its thread was archived; an archived thread can therefore be found
  and resumed.

- **Codex plugin MCP servers in Find Session.** The Codex runner disables every MCP server
  declared in `config.toml` with `-c mcp_servers.<name>.enabled=false`, but a Codex plugin
  can contribute its own server (such as `cua_repl`) and the CLI offers no per-server
  switch for it; disabling the plugin would discard more of the user's configuration than
  the search should. Revisit if Codex exposes a per-run MCP allowlist or denylist.

- **An opencode Find Session runner.** opencode sessions are searchable, but opencode
  cannot run the search: `opencode run` exposes a full coding agent, the built-in Plan agent
  allows shell and may write plan files, and Explore is a subagent whose shell and web
  access is only prompt-restricted. Every run also persists a session. Revisit when
  opencode offers an enforced read-only primary agent and a no-save session mode;
  [ADR 0017](adr/0017-opencode-find-session-source-only.md) records the evidence and the
  remaining gaps. A future runner would also need a follow-up in the same session.
- **opencode Find Session coverage.** The source snapshots the newest 200 top-level,
  non-archived sessions that fit a 45-second preparation budget, using
  `session.message.list?type=user`. Older sessions, archived sessions, subagent sessions,
  and assistant/tool evidence are absent. A full-history design would need either a
  bounded local export/index (which ADR 0014 deliberately avoided) or a documented
  content-search endpoint; opencode's `session.list` search only matches titles.
- **Find Session scope.** Searches cover every session on the machine. Starting one from a
  repository row could limit the agent to that repository's sessions.
  The current recommendation is to skip them, matching Codex's own thread picker.
- **Portable command quoting.** Shell quoting assumes a POSIX shell; Windows needs
  platform-specific quoting for paths passed to `--cd`, the `cd <worktree> &&` prefix
  used when resuming a restored tab, and similar shell fragments. Find Session's Copy
  Resume Command also uses POSIX `cd … &&`. CLIs Agntree runs itself already quote for
  cmd.exe through `harnessInvocation()`.
- **opencode and Pi "needs you" state.** Neither CLI exposes a pending-permission or
  waiting-for-input signal through its interface. Revisit if one gains it.
- **Pi settled-turn signal.** Pi's session JSONL records messages, not the `agent_settled`
  event, so automatic retry, queued follow-ups, and compaction can briefly look like a
  finished turn. Revisit if Pi persists that event or exposes a state query for a
  TUI-owned session; the current trade-off is recorded in
  [ADR 0015](adr/0015-pi-sessions-from-transcript.md).
- **Pi session directories set in a subdirectory.** Pi reads `.pi/settings.json` from its
  process cwd only, so a session started in a worktree subdirectory with its own
  `sessionDir` writes to a directory discovery cannot know without walking the worktree.
  The worktree's setting and the default layout are both scanned; revisit if Pi gains a
  way to enumerate sessions across configured directories. Find Session reads the default
  `<agentDir>/sessions` root plus a flat `PI_CODING_AGENT_SESSION_DIR` or global
  `sessionDir` override resolved from the extension host's cwd; a project-local relative
  `sessionDir` is not enumerated.
- **Claude duplicate transcripts.** Forks created by older Agntree versions copied whole
  project directories, leaving the same session IDs under source and destination. There is
  no cleanup yet; decide whether to offer one or leave them to the user.
- **Incremental Claude metadata parsing.** Discovery, import, and naming still read and
  parse the whole transcript. Only the 4-second attention path uses the tail reader. If
  large sessions make tree refreshes expensive, move the full metadata path onto
  `JsonlAppendReader`, which Codex rollouts and Pi records already use.
- **Claude recap and usage metadata.** The current surface intentionally dropped
  `away_summary`, model/token usage, `gitBranch`, and message count because they are not
  worth a full parse. Restore them if Claude exposes a cheap native source.
- **Remove the lazy pending-ID migration.** Opening a pre-change Claude chat with neither a
  session ID nor a pending ID assigns one. Delete that branch once such chats are no longer
  expected.
- **Claude long-path hash.** Directories over 200 encoded characters get a truncated prefix
  plus a hash Claude does not document; discovery matches the prefix and verifies `cwd`.
  Reverse-engineer the hash only if Claude changes the format and prefix matching fails.
- **Fold the exact-ID watchers into the session importer.** `SessionImportService` now
  reconciles sessions started in an agent's UI or outside Agntree, while the per-harness
  watchers still link chats Agntree launched by the ID it chose. Consolidating would remove
  a second linkage mechanism, but it must keep exact identity for those launches — the
  importer's snapshot-based claim is not a substitute — and it touches terminal restore,
  attention, and their tests. See
  [ADR 0012](adr/0012-session-import-and-surface-choice.md).

## Experiments

### Shared Codex app-server daemon across windows

Status: **exploring**, not scheduled.

**Idea.** Run one Codex app-server per user and connect every Agntree window to it through
Codex's native proxy, instead of starting a private server per extension host.

**Native pieces.** Codex already provides the transport:

- `codex app-server daemon start | stop | restart | version` manages a local daemon.
- `codex app-server proxy --sock <path>` proxies stdio JSON-RPC to the running daemon.

No new transport or daemon needs to be built. Agntree would only add a policy layer:
detection, a version gate, opt-in configuration, and fallback to a private server.

**Why this is deferred.**

- **Shared fate.** One crash or upgrade affects every window at once; a private server
  isolates failures to the window that owns it.
- **Version skew.** The daemon may have been started by a different Codex version than the
  one on the current `PATH`. The protocol is still marked experimental.
- **Global side effects.** The daemon outlives the extension host. Agntree would have to be
  careful never to stop a daemon it did not start, and to leave cleanup to the user.
- **Limited payoff today.** A private server is ~65 MB RSS while active and shuts down when
  idle. The saving only matters when several windows are active at the same time.

**What success would look like.**

- Two windows share one app-server process, verified by process count and `daemon version`.
- Reloading one extension host does not interrupt work in another window.
- A daemon started by an incompatible Codex version is detected and the extension falls back
  to a private server with a clear message.
- Closing Agntree never leaves an orphaned daemon behind, and never stops a daemon that was
  already running for another client.
- The daemon exits or is stopped predictably when the last client disconnects, or the user
  can choose to keep it running.

**Prerequisites.**

- The daemon and proxy commands leave experimental status, or the protocol is versioned.
- A documented way to query a running daemon's version and capabilities before connecting.
- An opt-in setting, for example `agntree.codex.useSharedAppServer`, defaulting to `false`.
