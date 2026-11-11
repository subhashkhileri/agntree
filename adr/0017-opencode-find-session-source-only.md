# 0017 — opencode stays a Find Session source, not a runner

- **Status:** Proposed
- **Date:** 2026-11-11
- **Extends:** [0016](0016-find-session-sources-across-harnesses.md)

## Context

[ADR 0016](0016-find-session-sources-across-harnesses.md) made opencode sessions
searchable through a snapshot but left opencode without a runner, pending "an equivalent
read-only mode". This record re-examines that gap against opencode v2.1.2 and the current
V2 documentation.

A Find Session runner must hold one headless conversation, read the records through a
strict read-only tool set, accept follow-up corrections, and leave no search session in
the user's profile. Claude Code, Codex, and Pi all provide a CLI mode for that. opencode
does not expose one directly:

- `opencode run --agent <id>` selects an agent, and V2 defines agents with ordered
  permission rules (`action`, `resource`, `effect`; last match wins).
- The built-in **Plan** agent is described as read-only for normal project files, but it
  may write OpenCode plan files under `~/.opencode/plan`, and its shipped permissions deny
  `edit` while leaving `shell` allowed by default.
- The built-in **Explore** agent is search-oriented, but it is a `subagent`: it runs in a
  child session through the subagent tool, not as `run --agent`. Its permissions allow
  `shell`, `webfetch`, and `websearch`; its read-only shell behavior is a system-prompt
  instruction, not an enforced rule.
- No documented ephemeral or no-save session mode exists. The docs' `--archived` creates
  the session archived so scripted runs stay out of session lists and the inbox, but the
  session still exists. opencode's feature request for an ephemeral mode is open.
- `--session <id>` and `--continue` do support follow-ups in the same session.

## Decision

- **opencode remains a search source only.** `agntree.sessionSearch.harness` offers
  `claude`, `codex`, and `pi`; opencode sessions are still searched by whichever of those
  runs a search, through `OpencodeSessionSearch`.
- **No opencode runner until both gaps close.** Revisit when opencode documents a
  selectable, enforced read-only primary agent and either an ephemeral session or a
  no-persist flag that is available in the supported version. A custom read-only agent is
  not enough by itself while every run persists a session.
- **A project-local config could carry the policy later.** The V2 permission list can
  express "deny `*`, then allow `read`, `glob`, and `grep`" (plus `external_directory` for
  the transcript folders), and MCP tools fall under their own actions. opencode loads a
  project-local `opencode.jsonc`, so a future runner could put that policy in the search's
  own temporary folder without changing the user's configuration. That path stays
  unverified on v2.1.2 (see Evidence) and is not used today.

## Alternatives

- **Run the Plan agent.** Rejected: shell is allowed by default and plan files may be
  written, so a prompt injected from a transcript could still change the machine.
- **Run the Explore agent.** Rejected: it is subagent-only, and its permission list allows
  shell, web fetches, and web search. The read-only behavior is an instruction to the
  model, not a boundary.
- **Run the Build agent with the user's config.** Rejected: it has edit and shell tools,
  broad default access, and persists a session. A Find Session prompt reads untrusted
  transcripts, so this is the exact failure the read-only runners avoid.
- **Delete the search session afterwards.** `opencode session delete <id>` exists and
  would be narrow (only the ID Agntree created), but it makes a read-only search perform a
  destructive operation and depends on the ID being captured reliably. Not chosen while
  there is no no-persist mode.
- **Wait for the opencode ephemeral-session request.** That request alone would not make
  the Plan or Explore agents enforced read-only; both gaps must close.

## Evidence

Checked on 2026-11-11 with opencode v2.1.2 and the V2 documentation:

- `opencode run --help` exposes `--agent`, `--session`, `--continue`, `--format json`,
  and `--auto`, but no `--archived`; the documentation's `--archived` example is ahead of
  the installed binary. `opencode run "…"`, `--agent`, `--session`, and continuation are
  documented in the [CLI reference](https://opencode.ai/docs/cli/commands/).
- `opencode api agent.list` on v2.1.2 returned `build` and `plan` as `primary`, `general`
  and `explore` as `subagent`, plus hidden `compaction`, `title`, and `summary` agents.
  Plan's rules deny `edit` except under `~/.opencode/plan/*` and do not deny `shell`;
  Explore's rules end with a catch-all deny followed by allows for `shell`, `grep`,
  `glob`, `webfetch`, `websearch`, `read`, and `external_directory`. The shipped policies
  are described in the [Agents guide](https://opencode.ai/docs/agents/) and the
  [Permissions guide](https://opencode.ai/docs/permissions/).
- `opencode debug config` in a temporary folder loaded a project-local
  `opencode.jsonc` containing the deny-all/read-only permission list, so the configuration
  surface is present. A headless probe with that policy did not complete within 150 seconds
  and produced no output or session, so enforcement was **not** verified end-to-end.
  Custom agent definitions (both `agents` config and `.opencode/agents/*.md`) did not
  appear in `agent.list` or `debug agents` on v2.1.2.
- There is no documented no-persist flag. The request for one is open:
  [anomalyco/opencode#53921](https://github.com/anomalyco/opencode/issues/53921),
  "[FEATURE]: Add an ephemeral mode that does not persist sessions locally", opened
  2026-10-08.
- ADR 0016's snapshot remains the search surface: `session.list` plus
  `session.message.list?type=user`, written into the search folder and removed afterwards.
  Verification stays live through `session.get` and `session.message.list`.

## Consequences

- An opencode-only machine still cannot run a search; Claude Code, Codex, or Pi must be
  installed. opencode sessions are included whenever one of them runs it.
- opencode's recent-history coverage limits (newest 200 sessions, a 45-second preparation
  budget, a 4 MB snapshot cap, user messages only) are unchanged and remain recorded in
  [ROADMAP.md](../ROADMAP.md).
- Adding a runner later means implementing `SessionSearchRunner` for opencode, adding the
  id to the `agntree.sessionSearch.harness` enum, and stating the minimum supported
  opencode version. The search contract does not change: one headless conversation,
  enforced read-only tools, and no session left behind.
- The decision is deliberately provisional. It is about the native surface opencode
  offers today, not a judgment that opencode should never run the search.
