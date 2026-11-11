# 0016 — Find Session searches every harness, and runs only where a read-only mode exists

- **Status:** Proposed
- **Date:** 2026-11-11
- **Extends:** [0014](0014-find-session-agent-over-native-records.md)

## Context

[ADR 0014](0014-find-session-agent-over-native-records.md) made one harness's CLI the
search agent and that harness's records the only searchable source. Users have sessions in
all four supported harnesses, often in the same repository, and a question such as "which
session reviewed the parser change?" does not say which agent ran it. The sources also
differ sharply:

- Claude Code, Codex, and Pi keep readable session files, so a read-only agent can search
  them directly.
- opencode keeps sessions only in its SQLite database. [AGENTS.md](../AGENTS.md) forbids
  reading that database, and its `session.list` search matches titles only.
- Claude Code offers a tool allow list (`Read,Grep,Glob`) and `--no-session-persistence`;
  Codex offers an ephemeral thread in a read-only sandbox; Pi offers built-in
  `read`, `grep`, `find`, and `ls` tools. opencode's `run` exposes a full coding agent with
  write tools and persists a session, with no documented read-only mode.

## Decision

- **Search sources are independent of the runner.** Every installed harness implements
  `SessionSearchSource`; the agent that answers is chosen separately. The answer schema
  offers exactly the sources that prepared successfully, so a broken harness cannot be
  named in a match.
- **A source may prepare a read-only view.** `SessionSearchSource.prepare()` writes records
  a harness does not expose as files into the search's own temporary folder. The view is
  built per search, used by the agent, and removed with the folder; nothing is indexed or
  kept between searches. A failing prepare drops that harness from the search with a
  visible step instead of failing the whole search.
- **opencode is searchable through a user-message snapshot.** `OpencodeSessionSearch` lists
  recent top-level, non-archived sessions with `session.list` and reads only
  `session.message.list?type=user` for each, writing one compact JSON file per session.
  It is bounded to the newest 200 sessions, a 45-second preparation budget that starts
  before the listing, and a 4 MB total snapshot; Stop aborts the listing and the message
  fetches. The instructions say older, archived, and subagent sessions are absent, and
  when the budget dropped sessions or later prompts. Assistant text and tool evidence are
  not in the snapshot. Verification is live (`session.get` and `session.message.list`),
  never the snapshot.
- **A runner keeps the harness's own configuration.** The model, provider, auth, effort,
  skills, extensions, hooks, and context files are whatever the user configured; the
  runner passes a model or effort flag only when the Find Session settings name one. A
  model and effort belong to the harness they were chosen for: when the configured
  harness changes, `engine()` clears them, and a fallback runner passes none. The one
  per-run change is MCP: a search may not call an MCP tool, because those tools are not
  covered by the CLI's read-only tool list or sandbox and can write. Claude loads an empty
  strict MCP config written as a file in the search folder
  (`--strict-mcp-config --mcp-config <file>`); Codex runs `codex exec --ephemeral` with the
  real `CODEX_HOME` and adds `-c mcp_servers.<name>.enabled=false` for each server declared
  in `config.toml` (a plugin-provided server has no per-server switch, so it stays as
  configured); Pi keeps `--tools read,grep,find,ls` and adds `--exclude-tools 'mcp__*'`.
  Codex, Pi, and Claude read the prompt from stdin, so a multi-line question never passes
  through cmd.exe quoting on Windows. `codex exec` keeps no conversation across processes,
  so a correction starts a new ephemeral run whose message carries the original prompt,
  the previous reply, and the correction. opencode does **not** get a runner until it
  offers an equivalent mode; the current evidence and revisit conditions are in
  [0017](0017-opencode-find-session-source-only.md).
- **The runner is chosen among available harnesses.** `engine()` prefers the configured
  harness when its runner's CLI is available and otherwise falls back to the first
  available runner, so a machine without Claude Code can still search. Runner selection
  probes the executable (`SessionSearchRunner.isAvailable()`), not the adapter's install
  state: a leftover profile without the CLI is enough to show sessions but not to spawn
  one. The `agntree.sessionSearch.harness` enum lists only harnesses with a runner
  (`claude`, `codex`, `pi`).
- **Verification stays with the harness.** Codex uses `thread/read` and
  `thread/items/list`, whose `userMessage` items are the typed prompts without the
  AGENTS.md and environment context that appear in the rollout. Pi uses the same
  `piUserPrompt()` rule that names sessions and previews. opencode uses the live message
  API. A quote that is not one of the user's prompts is dropped; the match remains with its
  real folder, title, and dates.

## Alternatives

- **Read opencode's database.** Forbidden by AGENTS.md, and its schema is internal.
- **Export every opencode session with `session.export`.** One 153-message session exported
  1.1 MB, and a search would export every session on each run. Listing only the user
  messages is about 5 KB for the same session and is the evidence a quote needs.
- **Index opencode sessions persistently.** Rejected by ADR 0014: an index needs upkeep and
  duplicates the harness's records. The snapshot is per-search and ephemeral.
- **Use opencode as the runner with its normal agent.** It has write tools and saves a
  session, so a prompt injected from a transcript could change files or leave records
  behind.
- **Discard the user's configuration for the search.** `claude --safe-mode`,
  `codex exec --ignore-user-config` in a throwaway home, and Pi's
  `--no-extensions --no-skills --no-context-files --no-mcp` all make a read-only run easy
  to describe, but they ignore the model, provider, skills, extensions, and rules the user
  set. Agntree uses each harness as configured and removes only the MCP tools from the
  tool set.
- **Give the agent a shell so it can call `opencode` itself.** It would need Bash without a
  sandbox, which is exactly what the read-only runners avoid.

## Evidence

Measured on 2026-11-11 with Claude Code 2.1.318, codex-cli 0.166.0, opencode v2.1.2, and
Pi 1.5.2:

- A Codex `exec --sandbox read-only` run read `~/.codex/sessions`, `~/.claude/projects`,
  and `~/.pi/agent/sessions`. `codex exec --help` (0.166.0) documents `--ephemeral` on
  both `exec` and `resume`: a real `codex exec --ephemeral --sandbox read-only --json`
  answered from the user's configured model and left the rollout count in
  `~/.codex/sessions` unchanged. A real run with the prompt on stdin printed "Reading
  prompt from stdin...", answered `OK`, and also left the rollout count unchanged.
  `-c mcp_servers.<name>.enabled=false` switches off a
  server declared in `config.toml` without changing the file or its transport; `codex mcp
  list` showed `playwright` and `node_repl` disabled and still refused a quoted name such
  as `node.repl`, which its `-c` parser splits.
- A plugin can contribute its own MCP server (this profile's `cua_repl` comes from the
  Codex plugins). Disabling it as `mcp_servers.cua_repl.enabled=false` fails with
  "invalid transport" because the override has no server definition, and disabling the
  plugin would discard more of the user's setup than the search needs. Those servers keep
  the user's configuration; the search's read-only guarantee covers the shell sandbox and
  the config-declared servers.
- A real cross-harness search with the Claude runner and no MCP exclusion called the
  user's Playwright MCP server even though `--tools Read,Grep,Glob` was set. MCP tools
  bypass the built-in allow list. `--safe-mode` suppresses them by discarding the rest of
  the user's configuration; `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` keeps
  skills, plugins, hooks, and settings and only prevents MCP servers from loading. A real
  `claude --print` run with those two flags answered normally.
- `pi --help` (1.5.2) states that `--tools` keeps MCP tools unless an entry starts with
  `mcp__`, while `--exclude-tools` applies to all tools, MCP included. `--exclude-tools
  'mcp__*'` therefore denies MCP tools without `--no-mcp`, `--no-skills`,
  `--no-extensions`, or `--no-context-files`, which would discard the user's setup. A real
  `pi --print --tools read,grep,find,ls --exclude-tools 'mcp__*'` run answered and kept its
  session in the supplied `--session-dir`. Pi 1.5.2's installed `main.js` reads piped
  stdin into the initial message; a real run with the prompt on stdin answered `OK` and
  wrote only its session in the supplied `--session-dir`.
- `codex exec --help` (0.166.0) states that instructions are read from stdin when no
  prompt argument is given or `-` is used. Claude's `--mcp-config <configs...>` treats its
  values as config files; a real invocation with the empty config as a file read that
  path and reported only the extra tokens after it as missing. Find Session uses those
  surfaces, so a multi-line prompt or quoted JSON never reaches `quoteForCmd()`, which
  refuses quotes and newlines on Windows; the fake CLI tests assert every command
  argument survives it.
- The same real search, run once with each runner, returned the Codex session through
  Claude (about 30 s), the Codex runner (about 29 s), and the Pi read-only runner (about
  22 s). None of the runs wrote a session to the user's real Codex or Pi profile.
- `thread/items/list` for a real thread returned two `userMessage` items, while the rollout
  held four `input_text` blocks: the AGENTS.md and environment blocks are not items, so the
  Codex verifier does not need the rollout's injection rules.
- A Pi run with `--tools read,grep,find,ls` found the synthetic banana session using
  `ls`, `grep`, and `read`; a second `pi --session <id>` invocation answered from the same
  conversation. The session stayed in the supplied `--session-dir`.
- opencode `session.list` with `search=actionable` returned nothing while the same text was
  in a session's assistant message, confirming title-only search. The global list worked
  from `/tmp`; `session.message.list?type=user` returned the two user prompts (5 KB) while
  `session.export` for that session was 1.1 MB. `session.get` and `session.export` worked
  by ID from a different working directory.

## Consequences

- An opencode-only machine can search nothing until Claude Code, Codex, or Pi is installed
  to run the search; opencode's sessions are still included when one of them runs it.
- opencode search is recent-history search. A match older than the newest 200 sessions (or
  one whose messages did not fit the 45-second budget) cannot be found until the source
  gains a better native surface.
- Search time now includes opencode snapshot preparation. The agent's token cost stays
  roughly flat because the snapshot is compact and the sources still tell it to Grep before
  reading.
- A Codex correction re-runs the search instead of resuming it, because an ephemeral run
  keeps no thread. Corrections happen only when a reply breaks the schema and are capped
  at two.
- The chosen runner's provider receives excerpts of the sessions the agent reads,
  including another harness's sessions. The README says so, as ADR 0014 required.
- Adding a harness to Find Session now means implementing `sessionSearch` and, when its
  records are not files, `prepare()`; a runner is optional and must prove a read-only tool
  set and a way to keep MCP tools out without discarding the rest of the user's config.
