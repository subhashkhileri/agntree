# Roadmap

This roadmap records direction, not commitments. Shipped changes are documented in
[`CHANGELOG.md`](CHANGELOG.md); open design questions for work in progress live with the
implementation rather than here.

Status values: **in progress**, **planned**, **exploring** (not scheduled).

## In progress

### Codex harness

Add Codex as a first-class harness alongside Claude Code and opencode: discovery, import,
search, resume, fork (same worktree and new worktree), previews, metadata, auto-naming, and
finished-turn notifications.

v1 uses the Codex app-server (`codex app-server --listen stdio://`) as the source of truth
for threads, with a private server process per extension host that starts lazily and shuts
down after an idle period. New sessions still open `codex` in a terminal and are linked by a
watcher, because a thread is not materialized until its first user message. Forks use
`thread/fork` and return a resumable ID synchronously.

## Planned

- **Codex archived sessions.** Decide whether import and search include archived threads.
  The current recommendation is to skip them, matching Codex's own thread picker.
- **Portable command quoting.** Shell quoting assumes a POSIX shell; Windows needs
  platform-specific quoting for paths passed to `--cd` and similar flags.
- **opencode "needs you" state.** opencode exposes no pending-permission signal through its
  CLI. Revisit if it gains one.

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
