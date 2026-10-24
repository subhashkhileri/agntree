# AGENTS.md

Agntree is a VS Code extension that manages CLI coding-agent sessions (Claude Code,
opencode, and Codex) across git repositories and worktrees. This is the working agreement
for anyone changing the repository — human contributors and the coding agents working with
them. It covers the taste behind the code, the questions to answer before writing any, and
the checklist a change must pass before it is done.

Deeper references:

| Document | Use it for |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Deep reference: subsystem map, harness internals, session discovery, notifications, worktrees, PR checkout |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Setup, PR process, and adding a harness |
| [`test/README.md`](test/README.md) | Test suites, coverage matrix, and environment variables |
| [`ROADMAP.md`](ROADMAP.md) | Deferred and experimental work; check it before proposing a large design |
| [`CHANGELOG.md`](CHANGELOG.md) | Release-note format; user-visible changes land under `Unreleased` |

This is the only instruction file: Claude Code (v2.1.277+), Codex, opencode, and other
`AGENTS.md`-aware tools load it automatically. `ARCHITECTURE.md` is reference material and
is not loaded every session; read the relevant section when you touch that subsystem.

## How we think

- **One seam per harness.** Claude Code, opencode, and Codex disagree about session
  identity, discovery, forking, and live state. Those disagreements belong in
  `src/harnesses/` and in each harness's watcher. Commands, providers, and shared services
  stay harness-agnostic so adding support for another agent does not touch the core.
- **One mechanism per job.** When two paths share a lifecycle or an invariant, name the
  shared mechanism and keep the differences at the edges. Do not copy a flow to vary one
  step, and do not abstract two similar lines that share no invariant.
- **Native interfaces, not internals.** Prefer a harness's documented CLI or API. Claude
  Code only offers its JSONL transcripts, so we read those; opencode and Codex offer APIs,
  so we never touch opencode's SQLite database or Codex's state database. An experimental
  API that fails with a clear error is better than a schema we guessed.
- **Quiet UI.** Session rows show only what changes: a short relative time or `new`, a star,
  and the harness mark. Detail lives in the tooltip. Destructive and occasional actions live
  in the `…` and context menus, not in the hover row. Dialogs end in `…`, and only the
  primary actions stay inline.
- **Cheap by default.** The tree renders often, so nothing on that path may block. Cache
  with a short TTL, share in-flight requests, read logs incrementally, fetch previews only
  for the row under the cursor, poll only while a chat is pending, and shut external
  processes down when idle.
- **Narrow destructiveness.** Deleting, discarding, renaming, and pasting are scoped to the
  active worktree, refuse dangerous paths, never overwrite silently, and are logged. A
  confirmation must say exactly what will be lost.
- **Local-first.** Agntree has no telemetry and stores its state in VS Code's
  `globalState`. Network work happens through tools the user invoked — `git`, `gh`, and the
  harness CLIs themselves.
- **Tests are executable specifications.** They prove behavior without a model turn, a
  network call, or a real CLI whenever a fake at the process boundary can do the job. Real
  local data is optional and must skip cleanly.
- **Docs are part of the change.** User-facing behavior goes in `README.md` and
  `CHANGELOG.md`; architecture goes in `ARCHITECTURE.md`; test coverage goes in
  `test/README.md`; deferred or experimental work goes in `ROADMAP.md`.
- **Small, focused diffs.** One feature or fix per PR. Follow the surrounding patterns
  instead of introducing a second way to do the same thing.

## Non-negotiables

1. **No harness conditionals outside the harness layer.** Commands, providers, and shared
   services must not branch on `chat.harness`. If behavior differs by harness, put it behind
   `HarnessAdapter` (a method or a capability flag). Per-harness watchers may compare their
   own `harness` field.
2. **Never read internal storage directly.** opencode's `opencode.db` and Codex's state
   database are off limits. Claude's JSONL is the only supported surface it offers.
3. **Never interpolate user input into a shell command.** Git runs through argument arrays
   (`runGit`). Terminal launch commands use `quoteShellArgument`; Windows quoting is a known
   gap tracked in `ROADMAP.md`.
4. **Destructive operations stay narrow.** Files must be inside the active worktree, names
   must be one path segment, deletes use the Trash, creates and pastes never overwrite, and
   `GitService.forceRemoveWorktree()` refuses the filesystem root, the repository, the home
   directory, their ancestors, and paths git does not report as worktrees. Log user-triggered
   actions and refusals with `logOperation()`.
5. **Stored state is a compatibility surface.** Never require users to reinstall or re-add
   repositories to get a new field. Read old shapes through `StorageService`, migrate them on
   read (as `claudeSessionId` was migrated), and write the new shape back.
6. **Background work has an owner and a lifetime.** Every listener, timer, watcher, child
   process, and cache entry must be disposed or bounded. Processes start lazily, have
   timeouts, and stop when idle. Do not leave an unhandled promise or an orphaned process.
7. **Do not edit generated files.** Harness icons are generated from
   `resources/icons/harness/base/` by `npm run generate:icons`. Edit the base mark and
   regenerate.
8. **Tests must stay runnable by anyone.** No model turns, no network, no dependency on a
   maintainer's local sessions unless the test skips cleanly when they are absent.
9. **Ship the documentation with the code.** A user-visible change without a `CHANGELOG.md`
   entry and the relevant README/architecture update is incomplete.

## Before writing code

Answer these in order. If a question has no answer, investigate before editing.

1. **What behavior changes?** State it in one sentence, plus the edge cases and what is
   explicitly out of scope.
2. **Which layer owns it?** Trace the current path — command → provider/service → adapter →
   native tool — and put the change at the lowest layer that can own it. See the table
   below.
3. **Does the native tool actually support it?** Run the CLI or API and record the version,
   method, and exact fields. Do not code from memory or a blog post. Note whether the
   surface is documented, experimental, or internal.
4. **What happens when it is unavailable?** Missing binary, not logged in, older or newer
   version, malformed or missing file, restart mid-operation. Decide the user-visible
   behavior before writing the happy path.
5. **What does it cost?** How often is it called? What is cached, for how long, and what is
   read per tree render? Does anything need pagination, incremental reads, lazy loading, or
   an idle shutdown?
6. **What state does it touch?** Stored chats, worktrees, terminals, open files, git. If it
   changes a persisted shape, plan the migration and the downgrade behavior.
7. **Is it destructive?** If it deletes, moves, copies, renames, or overwrites, define the
   scope guard, the confirmation wording, and the operation-log entry first.
8. **Can it be tested cheaply?** Identify the boundary where a fake proves the behavior
   without hiding the logic under test.
9. **What documentation changes?** README, changelog, architecture, test matrix, roadmap, or
   a combination.

### Where a change belongs

| Kind of change | Home | Notes |
| --- | --- | --- |
| Behavior that differs per harness | `src/harnesses/<Harness>Harness.ts` | Add a method or capability to the shared interface first; do not leak the branch. |
| New-session linkage and naming | `src/services/<Harness>SessionWatcher.ts` | Register it in `HarnessWatcherRegistry`. Reuse shared polling machinery when the lifecycle matches; implement the interface directly when it does not. |
| User action or multi-step flow | `src/commands/*.ts` | Register the command in `extension.ts` and contribute it in `package.json`. |
| Tree row, tooltip, icon state | `src/providers/*.ts`, `src/harnesses/sessionUtils.ts` | Stable row ids, `contextValue`, and quiet labels matter. |
| Persistence or migration | `src/services/StorageService.ts` | Read old shapes, migrate on read, write back. |
| Git or path safety | `src/services/GitService.ts`, `src/utils/paths.ts` | Argument arrays; `isWithin` / `isStrictlyWithin`. |
| Cross-cutting timing or notifications | `src/services/*` | The adapter supplies turn state; the service stays harness-agnostic. |
| External process or protocol | A service in `src/services/` | Lazy start, request timeouts, restart, idle shutdown, stderr tail. |
| Command, menu, setting, context key | `package.json` + `src/extension.ts` | Gate harness entries on `agntree.<harness>Installed`; end dialog titles with `…`. |

### The feature pipeline

1. **Shape the seam.** If the change is new behavior shared by all harnesses, change
   `HarnessAdapter`, `HarnessSession`, or `SessionMetadata` first. Keep the interface as
   small as the feature allows.
2. **Implement the lower layer.** Put external I/O and parsing in a service; put
   harness-specific behavior in the adapter. Services should be constructible with injected
   dependencies so tests can fake the boundary.
3. **Wire the user path.** Register commands in `extension.ts`, contribute them in
   `package.json`, and decide whether they belong inline, in the `…` menu, or only in a
   context menu. Use `setContext` for availability, not enablement hacks.
4. **Persist carefully.** Update `ChatSession` only when necessary. Migrate legacy records
   on read. Never drop a chat because a field is missing.
5. **Render quietly.** Give tree rows stable ids and a `contextValue` that matches their menu
   entries. Put detail in the tooltip, not the label. Use the harness's generated mark.
6. **Test at the cheapest layer.** A pure helper needs a direct unit test. A service needs a
   stubbed `vscode` and a temp directory. A harness needs a fake process or injected
   adapter. Manifest, activation, command registration, and menu gating need the integration
   suite.
7. **Update the docs.** Add an `Unreleased` changelog entry in the user's terms. Update
   README for behavior, `ARCHITECTURE.md` for subsystem details, `test/README.md` for
   coverage, and `ROADMAP.md` if part of the design is deliberately deferred.
8. **Verify, then review your own diff.** Run the full checklist below and the
   [self-review pass](#reviewing-your-own-diff); read the diff as if someone else wrote it.

## Adding a harness

A harness is a slice, not one file. It ships with an adapter, usually a service and a
watcher, a command and menu entries, icons, tests, and documentation.

### Questions to answer first

1. **Identity.** What is a session ID? Is it stable and unique? Can it be predicted, or is
   it assigned by the tool? Is there a thread/session object separate from its log file?
2. **Creation.** Can a resumable session exist before the first prompt? If not, new chats
   launch the TUI in a terminal and a watcher links the native session after the first user
   message. Does creation require a working directory?
3. **Discovery.** What lists sessions, and how do you scope by worktree directory? Is
   pagination cursor-based? Are subagents, ephemeral sessions, or archived sessions mixed
   into the same list? Can rows be duplicated? Which mode is cheapest and most reliable?
4. **Resume.** What is the exact terminal command, and how is the working directory passed?
   What happens when the native session no longer exists?
5. **Fork.** Is there a native fork API or only a terminal flag? Does it return a new ID
   synchronously or must a watcher discover it? Is history preserved? Can it target a new
   directory? What cleanup is needed if the destination step fails?
6. **Move.** Is moving a session between directories supported? If not, set
   `capabilities.move = false`; do not fake it by copying files.
7. **Previews and metadata.** Where do title, preview, model, agent, tokens, cost, recap,
   and message count come from? Which are cheap, which are expensive, and which need lazy
   loading or a TTL cache?
8. **Live turn state.** Can the API report whether a session owned by a separate TUI
   process is working? If not, what file or event stream is the live signal? What marks the
   start and end of a turn? How do you read only what was appended since the last poll?
9. **Watcher behavior.** How does a new session appear? Poll or file watch? How do you avoid
   claiming an existing session? What is the TTL, and how does naming fall back?
10. **Installation and versioning.** How is the CLI detected? Which setting overrides the
    command? Is the API experimental or versioned? What changes across CLI upgrades?
11. **Platform and quoting.** Are paths passed as arguments or through a shell? Does Windows
    need different quoting? Where do the tool's own files live?
12. **Failure modes and cost.** What does the user see when the CLI is missing, the API
    fails, or the log is corrupt? What is the process RSS and the per-render cost?

### What ships

- `HarnessId` extended in `src/types.ts`.
- `src/harnesses/<Harness>Harness.ts` implementing `HarnessAdapter`.
- A service for the native API/protocol when the adapter would otherwise become an I/O
  layer, and a `<Harness>SessionWatcher` for new-session linkage. When the harness assigns
  session IDs in a separate process and the lifecycle matches one that already exists,
  extend that mechanism instead of copying its loop; when it does not, implement
  `HarnessSessionWatcher` directly.
- Registration in `HarnessRegistry` and `HarnessWatcherRegistry` in `extension.ts`;
  give a stateful adapter a `dispose()` so `HarnessRegistry.dispose()` releases it.
- `agntree.new<Harness>Chat` in `src/commands/chat.ts` and `package.json`, plus entries in
  both **New Session** submenus gated on `agntree.<harness>Installed`. The submenus
  themselves are gated on `agntree.anyHarnessInstalled`, which activation sets.
- `agntree.harnessCommands.<harness>` with a default, and the install-gating loop picks up
  the context key automatically.
- A base mark in `resources/icons/harness/base/`, registration in
  `scripts/generate-harness-icons.mjs`, and generated light/dark × state files.
- Adapter, service/watcher, terminal, chat-command, menu, icon, and integration tests as
  applicable.
- README agent table and setup notes, `CHANGELOG.md`, `ARCHITECTURE.md`,
  `test/README.md`, and a `ROADMAP.md` entry for anything intentionally unsupported.

### How the three harnesses solved it

| Concern | Claude Code | opencode | Codex |
| --- | --- | --- | --- |
| Discovery | JSONL under `~/.claude/projects/` | `opencode api session.list` | `codex app-server` `thread/list` |
| New session | Launch `claude`, watcher links the transcript | Launch `opencode`, watcher links the session | Launch `codex`, watcher links the thread after the first prompt |
| Fork | Copy the project directory / `--fork-session` | Native fork + move | `thread/fork` into the destination `cwd` |
| Move | Via copy | Native move | Not supported |
| Live turn state | Transcript `stop_reason`, including background agents | `time.idle` vs `time.updated` | Rollout `task_started` / `task_complete` / `turn_aborted` |
| Previews | Transcript parse | Lazy `session export`, cached | `thread/items/list` |

The pattern behind the table: use the native lifecycle where one exists, fall back to a
watcher or a tailed log only for the gaps the tool does not expose, and put the fallback in
the harness layer.

## Build and verify

```bash
npm install                      # install dependencies
npm run compile                  # bundle src/ into out/extension.js with esbuild
npm run watch                    # rebuild on changes
npm run typecheck                # tsc --noEmit for src and test/dry
npm run test:dry                 # plain Node, stubbed vscode, no extension install
npm run test:integration         # real VS Code host; commands, settings, menus, activation
npx @vscode/vsce package         # package as .vsix
code --install-extension *.vsix  # install the packaged extension
```

For UI work, press F5 to launch the Extension Development Host. After installing a VSIX,
tell the user to run **Developer: Reload Window**; an already-open window keeps the old code
until it reloads.

## Testing doctrine

Two suites, one purpose: prove behavior without a model turn.

```bash
npm run typecheck           # src and test/dry, no emit
npm run test:dry            # plain Node, stubbed vscode, no extension install
npm run test:dry -- codex   # only files whose name contains "codex"
npm run test:integration    # real VS Code host; commands, settings, menus, activation
```

**Choose the cheapest layer that can prove the behavior.**

| Target | Test shape |
| --- | --- |
| Pure helper | Import the module directly. No `vscode`, no files. |
| Service or provider | Bundle under the `vscode` stub, use temp directories, drive public methods. |
| Harness adapter | Inject a fake app-server/CLI or write synthetic transcripts and rollouts. |
| Service with a child process | Run a fake Node process from `test/dry/fixtures/` and assert the protocol. |
| Command flow | Register on the stub, fake storage/terminals, execute the command. |
| Manifest, activation, menu gating | `npm run test:integration`. |

Rules:

- **Fake at the boundary, not the logic.** Do not mock the adapter or service you are
  testing; fake the process, filesystem, or `vscode` surface around it.
- **No network, no model turns, and no real CLI requirement.** If a test needs real local
  sessions, make it skip cleanly when none exist.
- **Clean up.** Temp directories, scratch sessions, and child processes are removed before
  exit, including on failure.
- **Test observable behavior.** Assert launch commands, returned shapes, tree labels,
  warnings, and persisted records — not private method calls.
- **Avoid sleeps.** Await the operation that establishes the precondition when the API
  exposes it; otherwise prefer deterministic inputs, explicit polling helpers, or fake
  timers over adding latency to the suite.
- **Maintain the matrix.** A new `*.test.ts` gets a row in `test/README.md`.
- **A flaky test is a bug.** Do not paper over it with retries.

`npm run test:dry` bundles each file with esbuild, aliases `vscode` to
`test/dry/vscode-stub.js`, and runs it under Node. If the stub is missing a surface your
test needs, extend the stub deliberately; do not add production conditionals for tests.

## Reviewing your own diff

Read the diff as if someone else wrote it. Look for structural cost rather than style:
duplicated mechanisms, invariants enforced in several places, work added to a hot path,
resources without an owner. These are prompts for judgment, not a checklist. If the simple
shape is different on purpose, explain why in the PR rather than forcing a row to fit.

| Smell | Usual move |
| --- | --- |
| The same flow is implemented twice with small differences | Extract the stable mechanism; leave the differences as hooks or policy at the edges. |
| The same invariant is checked in several places | Move it to the layer that owns the data, or to one shared helper both callers use. |
| A cache, map, or list grows without a stated bound | Bound it, state the eviction rule, and match the TTL to how often the data changes. |
| A synchronous read, scan, or spawn sits on a render or activation path | Make it async, cache it, or coalesce concurrent callers. |
| A fallback, option, or protocol method has no caller and no test | Delete it until a real caller exists. |
| An object captures a large scope for its lifetime | Copy the fields it needs; do not keep a buffer, request, or service alive. |
| Shared code names individual harnesses, commands, or services | Derive the list from the registry that owns them. |
| A test waits on a fixed sleep | Await the precondition or poll an explicit condition. |
| A generic helper has one caller | Keep the direct code until a second real caller appears. |
| A new abstraction only renames existing behavior | Collapse it into the caller; abstraction should remove more reading than it adds. |

Two copies of a lifecycle, protocol, or invariant are a seam worth naming. Two copies of a
trivial expression usually are not. Prefer one small shared mechanism with explicit policy
hooks over a framework that anticipates callers you do not have.

None of this outranks correctness, safety, or using the native interface. A pass that
shortens the code but makes failure behavior less clear is a regression; revert it.

## Definition of done

- [ ] The behavior works for every installed harness, and a missing harness is gated or
      explained rather than broken.
- [ ] `npm run typecheck`, `npm run compile`, and `npm run test:dry` pass.
- [ ] `npm run test:integration` passes when commands, menus, settings, activation, or the
      manifest changed.
- [ ] UI changes were checked in the Extension Development Host in both themes; icon work
      was checked at 16px, including reduced motion.
- [ ] Failure paths are handled: missing session, missing CLI, malformed data, timeout,
      process exit, extension-host restart.
- [ ] No harness conditionals outside adapters/watchers, no internal database reads, no
      shell interpolation, and no unguarded destructive operation.
- [ ] Caches are bounded, timers and listeners are disposed, and child processes are stopped.
- [ ] New behavior has a test at the cheapest useful layer, and the full suite is green.
- [ ] `CHANGELOG.md` has an `Unreleased` entry; README and the architecture/test docs are
      updated, or the change does not affect them.
- [ ] The diff is focused, contains no build artifacts (`out/`, `*.vsix`,
      `test/dry/.build/`), and the documentation matches the code.
- [ ] The [self-review pass](#reviewing-your-own-diff) was run; any remaining structural
      smell is explained in the PR.

## Gotchas

- **Extension host restarts on workspace switch.** `vscode.workspace.updateWorkspaceFolders()`
  tears down the host. Persist selection and active worktree to `globalState` before the
  switch and restore in `activate()`.
- **Terminals survive, the mapping does not.** `TerminalManager.syncWithExistingTerminals()`
  re-links terminals by the `Agntree: <name> [<shortId>]` convention.
- **`treeView.reveal()` needs stable ids, `getParent()`, and a visible tree.** See the
  pattern in `ARCHITECTURE.md`.
- **A tree item shows one icon.** Working/done/closed/new are baked into generated SVGs;
  the animation is CSS inside the SVG and must honor `prefers-reduced-motion`.
- **Path checks are symlink-aware.** Use `isWithin` / `isStrictlyWithin`; do not compare
  strings.
- **Codex `thread/list` needs `useStateDbOnly: true`.** The default scan path is slower,
  returns duplicates, and can block pagination. A new thread is not materialized until the
  first user message, so `thread/start` is not a new-session mechanism.
- **Codex live state comes from the rollout.** `thread/list` reports `notLoaded` for
  TUI-owned threads; read only appended bytes and skip `.zst`.
- **Codex app-server holds a writer lock on loaded threads.** A fork stays loaded after
  `thread/fork` for the default 30-minute unload delay. The private server starts with
  `thread_unload_delay_secs=0` and unsubscribes immediately after forking; otherwise the
  terminal reports the conversation as already open in another app.
- **opencode export truncates on a pipe.** `execToFile()` redirects stdout to a temp file.
- **App-server children can exit after replacement.** Ignore exit events from a child that
  is no longer `this.child`; otherwise a stale SIGTERM rejects the new process's requests.
- **`StorageService.getChats()` migrates on read.** Any code reading chats gets the new
  shape, but the write-back is asynchronous; do not assume the raw `globalState` value is
  current.

## Commits and pull requests

- Commit subjects use a conventional prefix (`feat:`, `fix:`, `docs:`, `refactor:`,
  `chore:`, `ci:`) and an imperative summary. The body explains why the change exists and
  what it replaces; put the user-visible outcome in the changelog, not only the commit.
- If a coding agent wrote the change, end the commit with an `Assisted-by: <agent>` trailer.
  Claude Code commits also include `Co-Authored-By: Claude Code`. PR descriptions end with
  `Assisted-by: <agent>`.
- Version bumps, tags, and Marketplace publishing are maintainer work. Release notes are
  generated from `CHANGELOG.md`, so do not duplicate them in the PR.
- Do not commit `out/`, `*.vsix`, `node_modules/`, or `test/dry/.build/`.

## First ten minutes in the codebase

1. Read `src/extension.ts` to see what is constructed, registered, and disposed.
2. Read `src/harnesses/types.ts` — it is the contract every harness implements.
3. Follow one path end to end: `agntree.newCodexChat` → `createSession` →
   `TerminalManager.openChat` → `CodexHarness.buildLaunchCommand` → the watcher.
4. Read `src/services/StorageService.ts` before touching persisted state.
5. Read `src/utils/paths.ts` before touching files, and `GitService.runGit()` before
   touching git.
