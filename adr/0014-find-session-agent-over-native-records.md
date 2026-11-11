# 0014 — Find Session runs an agent over the harnesses' own records

- **Status:** Proposed
- **Date:** 2026-11-10

## Context

Users ask "which session did I do X in?" weeks later, often for a session outside any
workspace root. Titles do not answer it: in the case that prompted this feature, the work
was the fiftieth of 87 prompts in a session named for something else. A plain grep does not
answer it either, because Claude repeats the user's CLAUDE.md in every session, so ten of
fifteen transcripts matched the mod's name.

## Decision

- **No index.** An agent searches the records each harness already keeps. Agntree builds,
  stores, and refreshes nothing for search.
- **The harness runs the agent.** One installed harness's CLI runs a headless conversation
  with read-only file tools and no saved session. The user chooses the harness, model, and
  effort; the default is the cheapest model at medium effort.
- **Each harness explains its own records.** A source's `instructions()` say where its
  sessions live and how to tell typed prompts from injected context. That knowledge lives
  in the adapter, next to the code that already parses those records, not in shared code.
- **Only the harness's record is trusted.** A match is shown only when its harness confirms
  the session exists; folder, title, and dates come from that record, and a quote is shown
  only when it opens one of the user's own prompts.
- **The prompt carries the format; Agntree checks it.** The prompt ends with the JSON
  Schema of the reply, whose field descriptions are the format instructions. Agntree
  parses each reply and validates it against that schema; a reply that breaks it goes back
  to the same agent with each problem named, at most twice. This needs nothing from a CLI
  beyond text in and text out and a follow-up message, so every runner shares it; a
  CLI-specific schema flag (`claude --json-schema`) would also pass JSON through `cmd` on
  Windows. The answer is shown as plain text, never as Markdown.

## Alternatives

- **A local index with keyword ranking, then a model to rerank.** Instant and free for the
  ranking step, but it duplicates the harnesses' records, needs incremental upkeep, and
  misses paraphrased questions unless a model expands the query anyway.
- **An MCP server exposing search tools to the agent.** Cleaner tool results, but a second
  process and protocol to own, configured differently for every harness CLI.
- **Shared code that reads every harness's sessions.** It would read opencode's database,
  which [AGENTS.md](../AGENTS.md) forbids, and would put harness knowledge outside the
  adapters.

## Evidence

Claude Code 2.1.322, Haiku at medium effort, 15 transcripts (34 MB), the question above:

- Both runs found the right session in about 50 s for about $0.01, with 11 Grep and 3 Read
  calls; about 18,000 characters of tool output reached the model. It never read a whole
  transcript.
- One run quoted real prompts but tied them to the wrong part of the session, which is why
  every quote is checked against the transcript and its time is taken from there.
- Without `--allowedTools`, Read outside the cwd and `--add-dir` was refused, so the agent
  is confined to transcripts.
- `--no-session-persistence` still left a project directory for the run's cwd, with saved
  grep output that the next run matched; the runner removes it.

## Consequences

- Every search costs a model turn and takes tens of seconds; there is no instant result.
- Search time grows with the size of the records, since each grep reads them again. Tokens
  stay roughly flat because tool output is capped.
- The chosen harness's provider receives excerpts of the sessions it reads, including
  another harness's sessions when that harness is a source. The README says so.
- Adding a harness to Find Session means implementing `sessionSearch` and, optionally,
  `sessionSearchRunner`; shared code does not change. [ADR 0016](0016-find-session-sources-across-harnesses.md)
  extends this to a source whose records are not files: it may also implement `prepare()`
  to write a temporary read-only view for one search.
