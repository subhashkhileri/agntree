# Contributing to Agntree

Thank you for your interest in contributing to Agntree! This guide covers setup, the PR
process, and adding a harness. Before writing code, read [`AGENTS.md`](AGENTS.md) — it is the
project's working agreement and explains where a change belongs, what to investigate first,
how we test, and what "done" means.

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

The self-review is a judgment pass, not a compliance checklist; the prompts and the usual
move for each smell live in [`AGENTS.md`](AGENTS.md#reviewing-your-own-diff). If a smell is
deliberate, explain it in the PR description.

## Adding Support for New AI Coding Agents

Agntree models each CLI agent as a **harness**. Adding support for a new agent means
implementing the adapter contract, adding a watcher for new-session linkage, and wiring the
harness's command, menus, settings, and icons. Core session management (storage, tree,
terminals, notifications) stays harness-agnostic.

### Before Implementing

Start from the harness questions in
[`AGENTS.md`](AGENTS.md#questions-to-answer-first). Record the CLI/API version, exact
methods, and failure behavior before writing the adapter. The subsystem map is in
[`ARCHITECTURE.md`](ARCHITECTURE.md), and the contract is
`src/harnesses/types.ts`.

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
- Add the worktree submenu gate to `agntree.anyHarnessInstalled`.
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

- Add the harness to the supported-agents table and setup notes in `README.md`.
- Add an `Unreleased` entry to `CHANGELOG.md`.
- Add the architecture and testing details to `ARCHITECTURE.md` and `test/README.md`.
- Add anything intentionally unsupported to `ROADMAP.md`.
- Add an ADR under `adr/` when the harness answers one of the questions above in a way that is
  expensive to reverse.

### Questions?

If you're working on adding support for a new agent and have questions about the
architecture, [open a
discussion](https://github.com/subhashkhileri/agntree/discussions) or [file an
issue](https://github.com/subhashkhileri/agntree/issues).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
