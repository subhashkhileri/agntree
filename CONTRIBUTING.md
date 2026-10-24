# Contributing to Agntree

Thank you for your interest in contributing to Agntree! This guide covers setup and the PR
process. Before writing code, read [`AGENTS.md`](AGENTS.md) — it is the project's working
agreement and explains where a change belongs, what to investigate first, how we test, and
what "done" means.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [VS Code](https://code.visualstudio.com/) 1.85.0+
- [Claude Code CLI](https://claude.ai/code), [opencode](https://opencode.ai), and/or [Codex CLI](https://developers.openai.com/codex) (for testing session features)
- [Git](https://git-scm.com/)

### Development Setup

```bash
# Clone the repository
git clone https://github.com/subhashkhileri/agntree.git
cd agntree

# Install dependencies
npm install

# Build the extension
npm run compile

# Watch for changes (auto-rebuild)
npm run watch
```

### Testing Locally

Press **F5** in VS Code to launch the Extension Development Host with the extension loaded.

Automated suites (no extension install required):

```bash
npm run typecheck                # tsc --noEmit for src and test/dry
npm run test:dry                 # plain Node with a stubbed vscode API
npm run test:dry -- opencode     # only files whose name contains "opencode"
npm run test:integration         # real VS Code host; set VSCODE_EXECUTABLE if needed
```

Dry tests bundle the real source with esbuild and alias `vscode` to
`test/dry/vscode-stub.js`. Fake app servers and synthetic transcripts live under
`test/dry/fixtures/` and in the tests themselves; no test requires a model turn. If you add
a test file, add it to the table in [`test/README.md`](test/README.md).

See [`test/README.md`](test/README.md) for coverage and environment variables.

### Build & Package

```bash
npm run compile                   # Build
npm run typecheck                 # Type-check src and test/dry
npx @vscode/vsce package          # Package as .vsix
code --install-extension *.vsix   # Install locally
```

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/subhashkhileri/agntree/issues) to avoid duplicates
2. Use the [bug report template](https://github.com/subhashkhileri/agntree/issues/new?template=bug_report.yml)
3. Include steps to reproduce, expected vs actual behavior, and your environment

### Requesting Features

1. Use the [feature request template](https://github.com/subhashkhileri/agntree/issues/new?template=feature_request.yml)
2. Describe the problem you're trying to solve, not just the solution

### Submitting Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Read [`AGENTS.md`](AGENTS.md) and make the change at the right layer
4. Run `npm run typecheck` and `npm run test:dry`, and fix any failures
5. Run `npm run test:integration` when commands, menus, settings, or activation changed
6. Test UI changes in the Extension Development Host (F5)
7. Update `CHANGELOG.md` under `Unreleased` and any affected docs
8. Run the [self-review pass](AGENTS.md#reviewing-your-own-diff) and fix or explain what you
   find
9. Submit a pull request with a clear description

The self-review is a judgment pass, not a compliance checklist. The questions worth asking:

- Did I copy a flow, lifecycle, or invariant that already has an owner? Name the shared
  mechanism, or say why this case genuinely differs.
- Is every cache, timer, listener, and process bounded and owned? Did I leave a branch,
  option, or protocol method with no caller?
- Is the new abstraction earning its place, or does a one-caller helper only add
  indirection?
- Does any test wait on a fixed sleep instead of the condition it needs?

If a smell is deliberate, explain it in the PR description.

## How We Work

The full working agreement lives in [`AGENTS.md`](AGENTS.md). The short version:

- **Find the seam first.** Harness-specific behavior belongs in `src/harnesses/` and its
  watcher. Commands, providers, and shared services stay harness-agnostic.
- **Name the shared mechanism.** If two paths share a lifecycle or an invariant, extract
  the mechanism and keep the differences at the edges. Do not copy a flow to vary one step,
  and do not abstract lines that share no invariant.
- **Prefer the native CLI/API.** Never read opencode's SQLite database or Codex's state
  database. Read files only where that is the harness's only supported surface.
- **Investigate before implementing.** Run the external tool, record its version and exact
  fields, and decide the failure behavior before writing the happy path.
- **Keep the UI quiet.** Session rows carry only recency, a star, and the harness mark;
  detail belongs in the tooltip and destructive actions in menus.
- **Stay cheap.** Cache with short TTLs, read logs incrementally, poll only while needed,
  and shut external processes down when idle.
- **Keep destructive operations narrow.** Scope to the active worktree, refuse dangerous
  paths, never overwrite silently, and log what happened.
- **Test at the cheapest layer.** No model turns, no network, and no dependency on the
  maintainer's local sessions. The test matrix is in [`test/README.md`](test/README.md).
- **Ship the docs.** User-visible changes need a changelog entry and the relevant README or
  architecture update.

## Adding Support for New AI Coding Agents

Agntree models each CLI agent as a **harness**. Adding support for a new agent means implementing the adapter contract, adding a watcher for new-session linkage, and wiring the harness's command, menus, settings, and icons. Core session management (storage, tree, terminals, notifications) stays harness-agnostic.

### Architecture Overview

```
src/harnesses/
├── types.ts              # HarnessAdapter + HarnessSessionWatcher contracts
├── ClaudeHarness.ts      # Claude Code adapter
├── OpencodeHarness.ts    # opencode v2 adapter
├── CodexHarness.ts       # Codex adapter (app-server + rollout live state)
├── HarnessRegistry.ts    # Installed detection, lookup, default harness
└── commandUtils.ts       # CLI resolution and shell quoting

src/services/
├── ClaudeSessionService.ts
├── OpencodeSessionService.ts
├── CodexAppServer.ts     # Lazy JSON-RPC client for `codex app-server`
├── CodexRollout.ts       # Incremental rollout reader for live turn state
├── ClaudeSessionWatcher.ts
├── OpencodeSessionWatcher.ts
├── PendingSessionWatcher.ts   # Shared poll/claim/TTL loop for new sessions
├── CodexSessionWatcher.ts
├── HarnessWatcherRegistry.ts
├── StorageService.ts     # Harness-agnostic session storage
├── TerminalManager.ts    # Harness-agnostic terminal management
└── GitService.ts         # Harness-agnostic git operations
```

### Before Implementing

Answer these before writing the adapter. They determine the design, and most of them can be
answered by running the agent's CLI/API and reading its output.

1. **Identity** — What is a session ID? Is it stable, unique, and predictable? Is there a
   thread object separate from its log?
2. **Creation** — Can a resumable session exist before the first prompt? If not, new chats
   launch the TUI in a terminal and a watcher links the native session later.
3. **Discovery** — What lists sessions, how do you scope by worktree, is pagination
   cursor-based, and are subagents/ephemeral/archived sessions mixed in? Which mode is
   cheapest and most reliable?
4. **Resume and fork** — What are the exact commands or API methods? Does a fork return a
   new ID synchronously, preserve history, and accept a destination directory? What cleanup
   is needed if a later step fails?
5. **Move** — Is moving a session between directories supported? If not, set
   `capabilities.move = false`; do not fake it.
6. **Metadata and previews** — Where do title, preview, model, agent, tokens, cost, recap,
   and message count come from? Which are cheap, which need lazy loading or caching?
7. **Live turn state** — Can the API report whether a session owned by a separate TUI process
   is working? If not, which log or event stream is the live signal, and what marks the start
   and end of a turn?
8. **Watcher behavior** — How does a new session appear, how do you avoid claiming an
   existing one, and what is the TTL and naming fallback?
9. **Installation and versioning** — How is the CLI detected? Which setting overrides it? Is
   the protocol experimental or versioned?
10. **Platform, failure, and cost** — Does Windows need different quoting? What does the user
    see when the CLI is missing, the API fails, or the log is corrupt? What is the process
    RSS and the per-render cost?

`AGENTS.md` has the full version of this checklist, plus how Claude Code, opencode, and Codex
solved each concern.

### Step 1: Implement `HarnessAdapter`

Create `src/harnesses/<AgentName>Harness.ts` implementing the interface in
`src/harnesses/types.ts`. The adapter owns all agent-specific behavior:

- **Installation detection** — `isInstalled()`
- **Launch/resume/fork commands** — `buildLaunchCommand()`, `isSessionResumable()`
- **Session discovery** — `listSessionsForWorktree()` / `listSessionsForRepository()`
- **Metadata and previews** — `getSessionMetadata()` / `getPreview()`
- **Fork and move** — `forkSession()`, `moveSession()`, `prepareForkToNewWorktree()`
- **Capabilities** — `fork`, `move`, `recap`, and whether previews are `inline` or `lazy`
- **Tree marks** — `treeIcons` from `harnessTreeIcons('<harness>')`, or a codicon fallback

If the adapter would otherwise become an I/O layer, put the native protocol or CLI in a
service under `src/services/` and inject it into the adapter. That is the seam tests use to
fake the process.

Prefer the agent's documented CLI/API over reading its internal files or database, so
upgrades do not break the adapter. If the API is experimental, surface its errors instead of
guessing at fields.

### Step 2: Add a Session Watcher

Create a service implementing `HarnessSessionWatcher` that links newly launched sessions to
the Agntree chat and auto-names it. Reuse whichever shared mechanism already matches the
harness's lifecycle; the existing watchers show the snapshot → poll → claim → name pattern
when session IDs are assigned in a separate process. Keep the claim rules consistent:
snapshot known sessions before polling, claim only unseen sessions created after the chat,
refuse a session already linked to another chat, rename from the native title, and give up
after a bounded TTL. Implement the interface directly when the lifecycle genuinely differs.
Register it in `HarnessWatcherRegistry` in `src/extension.ts`.

Forks that return a linked ID do not use the watcher; only terminal forks and brand-new
sessions do.

### Step 3: Register the Harness

- Add the new ID to `HarnessId` in `src/types.ts`.
- Register the adapter in `HarnessRegistry` and the watcher in `HarnessWatcherRegistry` in
  `src/extension.ts`; give a stateful adapter a `dispose()` so the registry releases it.
- Add a `New <Agent> Session` command in `src/commands/chat.ts` and `package.json`, and add
  it to both **New Session** submenus behind `agntree.<harness>Installed`. The activation
  loop sets that context key automatically once the adapter is registered.
- Add the worktree submenu gate to `(claude || opencode || <harness>)`.
- Add `agntree.harnessCommands.<harness>` with the default command.
- Add a base mark in `resources/icons/harness/base/`, register it in
  `scripts/generate-harness-icons.mjs`, and run `npm run generate:icons`.

### Step 4: Test

- Adapter tests with a fake CLI/app-server or synthetic transcripts: discovery scoping,
  launch commands, metadata/previews, turn state, fork results, missing-session behavior.
- Watcher test: new-session linkage, auto-naming, refusing an already-linked session.
- Terminal and chat-command tests: new/resume/fork commands, fork to a new worktree.
- Menu and icon tests: install gating and generated icon files.
- Integration test: command registered, submenu entry gated, `harnessCommands` default.

No test may require a model turn or the real CLI. See [`test/README.md`](test/README.md).

### Step 5: Document It

- Add the harness to the README agent table and setup notes.
- Add an `Unreleased` entry to `CHANGELOG.md`.
- Add the architecture and testing details to `ARCHITECTURE.md` and `test/README.md`.
- Add anything intentionally unsupported to `ROADMAP.md`.

### Questions?

If you're working on adding support for a new agent and have questions about the architecture, [open a discussion](https://github.com/subhashkhileri/agntree/discussions) or [file an issue](https://github.com/subhashkhileri/agntree/issues).

## Project Structure

```
src/
├── extension.ts              # Extension entry point
├── types.ts                  # TypeScript interfaces
├── harnesses/                # Harness adapters (Claude, opencode, Codex, ...)
├── commands/                 # Command implementations
│   ├── repository.ts         # Repository management
│   ├── worktree.ts           # Worktree operations
│   └── chat.ts               # Session commands
├── providers/                # Tree view providers
│   ├── WorkspacesTreeProvider.ts
│   ├── ChangesTreeProvider.ts
│   └── FilesTreeProvider.ts
└── services/                 # Core services
    ├── StorageService.ts
    ├── GitService.ts
    ├── TerminalManager.ts
    ├── ClaudeSessionService.ts
    ├── ClaudeSessionWatcher.ts
    ├── OpencodeSessionService.ts
    ├── PendingSessionWatcher.ts
    ├── OpencodeSessionWatcher.ts
    ├── CodexAppServer.ts
    ├── CodexRollout.ts
    ├── CodexSessionWatcher.ts
    └── HarnessWatcherRegistry.ts
```

## Code Style

- TypeScript with strict mode; `npm run typecheck` must pass for `src` and `test/dry`
- Match the surrounding code — naming, comment density, and error handling
- Prefer async/await over callbacks
- Comments explain *why*, not *what*; do not narrate obvious code
- Keep harness-specific branches in adapters and per-harness watchers
- Handle failure paths explicitly; do not swallow errors that change user-visible behavior
- Keep UI wording generic ("session", not "Claude session") unless the surface is
  harness-specific
- Add tests at the cheapest useful layer and update the matrix in `test/README.md`
- Keep changes focused — one feature or fix per PR

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
