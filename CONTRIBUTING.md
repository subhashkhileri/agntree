# Contributing to Agntree

Thank you for your interest in contributing to Agntree! This guide will help you get started.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [VS Code](https://code.visualstudio.com/) 1.85.0+
- [Claude Code CLI](https://claude.ai/code) (for testing session features)
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

Agntree's architecture separates agent-specific logic from the core session management. Adding support for a new AI coding agent involves the following steps:

### Architecture Overview

```
src/services/
├── ClaudeSessionService.ts    # Claude Code session discovery & parsing
├── StorageService.ts          # Agent-agnostic session storage
├── TerminalManager.ts         # Agent-agnostic terminal management
└── GitService.ts              # Agent-agnostic git operations
```

The agent-specific logic is isolated in `ClaudeSessionService.ts`. To add a new agent:

### Step 1: Create a Session Service

Create a new file `src/services/<AgentName>SessionService.ts` that implements session discovery and parsing for the new agent. Look at `ClaudeSessionService.ts` for the interface pattern:

- **Session discovery** — Find existing sessions on disk
- **Session ID extraction** — Parse session files for resumable IDs
- **Session metadata** — Extract summaries, timestamps, message counts
- **Path encoding** — Handle how the agent stores project-specific sessions

### Step 2: Update Terminal Commands

In `src/services/TerminalManager.ts`, add the CLI commands for the new agent:

- How to start a new session
- How to resume an existing session
- How to fork a session (if supported)

### Step 3: Update Types

In `src/types.ts`, add any agent-specific fields to the `ChatSession` interface or create a discriminated union.

### Step 4: Register the Agent

Wire up the new session service in `src/extension.ts` and update the tree providers to display agent-specific icons or labels.

### Step 5: Test

- Test session creation, resumption, and forking
- Test session import/discovery
- Test terminal integration
- Verify state persistence across restarts

### Questions?

If you're working on adding support for a new agent and have questions about the architecture, [open a discussion](https://github.com/subhashkhileri/agntree/discussions) or [file an issue](https://github.com/subhashkhileri/agntree/issues).

## Project Structure

```
src/
├── extension.ts              # Extension entry point
├── types.ts                  # TypeScript interfaces
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
    └── SessionWatcher.ts
```

## Code Style

- TypeScript with strict mode
- ESLint for linting (`npm run lint`)
- Follow existing patterns in the codebase
- Keep changes focused — one feature or fix per PR

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
