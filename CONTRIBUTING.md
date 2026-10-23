# Contributing to Agntree

Thank you for your interest in contributing to Agntree! This guide will help you get started.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [VS Code](https://code.visualstudio.com/) 1.85.0+
- [Claude Code CLI](https://claude.ai/code) and/or [opencode](https://opencode.ai) (for testing session features)
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
npm run test:dry                 # plain Node with a stubbed vscode API
npm run test:dry -- opencode     # only files whose name contains "opencode"
npm run test:integration         # real VS Code host; set VSCODE_EXECUTABLE if needed
```

See [`test/README.md`](test/README.md) for coverage and environment variables.

### Build & Package

```bash
npm run compile                   # Build
npm run lint                      # Run ESLint
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
3. Make your changes
4. Run `npm run lint` and fix any issues
5. Test in the Extension Development Host (F5)
6. Submit a pull request with a clear description

## Adding Support for New AI Coding Agents

Agntree models each CLI agent as a **harness**. Adding support for a new agent means implementing the adapter contract and adding a watcher for new-session linkage — core session management (storage, tree, commands, terminals) stays unchanged.

### Architecture Overview

```
src/harnesses/
├── types.ts              # HarnessAdapter + HarnessSessionWatcher contracts
├── ClaudeHarness.ts      # Claude Code adapter
├── OpencodeHarness.ts    # opencode v2 adapter
├── HarnessRegistry.ts    # Installed detection, lookup, default harness
└── commandUtils.ts       # CLI resolution and shell quoting

src/services/
├── ClaudeSessionService.ts
├── OpencodeSessionService.ts
├── ClaudeSessionWatcher.ts
├── OpencodeSessionWatcher.ts
├── HarnessWatcherRegistry.ts
├── StorageService.ts     # Harness-agnostic session storage
├── TerminalManager.ts    # Harness-agnostic terminal management
└── GitService.ts         # Harness-agnostic git operations
```

### Step 1: Implement `HarnessAdapter`

Create `src/harnesses/<AgentName>Harness.ts` implementing the interface in `src/harnesses/types.ts`. The adapter owns all agent-specific behavior:

- **Installation detection** — `isInstalled()`
- **Launch/resume/fork commands** — `buildLaunchCommand()`, `isSessionResumable()`
- **Session discovery** — `listSessionsForWorktree()` / `listSessionsForRepository()`
- **Metadata and previews** — `getSessionMetadata()` / `getPreview()`
- **Server-side fork and move** — `forkSession()`, `moveSession()`, `prepareForkToNewWorktree()`
- **Headless quick actions** — `buildHeadlessCommand()`

Prefer the agent's documented CLI/API over reading its internal files or database, so upgrades don't break the adapter.

### Step 2: Add a Session Watcher

Create a service implementing `HarnessSessionWatcher` that links newly launched sessions to the Agntree chat and auto-names it. Register it in `HarnessWatcherRegistry` in `src/extension.ts`.

### Step 3: Register the Harness

- Add the new ID to `HarnessId` in `src/types.ts`.
- Register the adapter in the `HarnessRegistry` created in `src/extension.ts`.
- Set a `agntree.<harness>Installed` context key at activation and gate its menu entries in `package.json` (see the `agntree.newSession` submenu).
- Add a `New <Agent> Session` command in `src/commands/chat.ts` and `package.json`.

### Step 4: Test

- Test session creation, resumption, forking (same worktree and new worktree)
- Test session import/discovery and repository search
- Test auto-naming, tooltips, and quick actions
- Verify state persistence across restarts
- Verify behavior when the CLI is not installed

### Questions?

If you're working on adding support for a new agent and have questions about the architecture, [open a discussion](https://github.com/subhashkhileri/agntree/discussions) or [file an issue](https://github.com/subhashkhileri/agntree/issues).

## Project Structure

```
src/
├── extension.ts              # Extension entry point
├── types.ts                  # TypeScript interfaces
├── harnesses/                # Harness adapters (Claude, opencode, ...)
├── commands/                 # Command implementations
│   ├── repository.ts         # Repository management
│   ├── worktree.ts           # Worktree operations
│   ├── chat.ts               # Session commands
│   └── quickActions.ts       # Quick action commands
├── providers/                # Tree view providers
│   ├── WorkspacesTreeProvider.ts
│   ├── ChangesTreeProvider.ts
│   └── QuickActionsTreeProvider.ts
└── services/                 # Core services
    ├── StorageService.ts
    ├── GitService.ts
    ├── TerminalManager.ts
    ├── ClaudeSessionService.ts
    ├── ClaudeSessionWatcher.ts
    ├── OpencodeSessionService.ts
    ├── OpencodeSessionWatcher.ts
    └── HarnessWatcherRegistry.ts
```

## Code Style

- TypeScript with strict mode
- ESLint for linting (`npm run lint`)
- Follow existing patterns in the codebase
- Keep changes focused — one feature or fix per PR

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
