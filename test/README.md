# Tests

Two suites, both runnable without packaging or installing the extension. For how to choose
a layer and what a dry test should look like, see
[`AGENTS.md#testing-doctrine`](../AGENTS.md#testing-doctrine).

| Suite | Command | What it does |
|---|---|---|
| Dry tests | `npm run test:dry` | Bundles source modules with esbuild, aliases `vscode` to a stub, and runs them in plain Node. |
| Integration test | `npm run test:integration` | Launches a real VS Code Extension Development Host and activates the extension. |

## Dry tests (`test/dry`)

Each `*.test.ts` is a self-contained script. `run.js` bundles it with the
`vscode` module aliased to `vscode-stub.js`, then runs the bundle under Node.
Tests print `PASS`/`FAIL` lines and exit non-zero on failure.

```bash
npm run test:dry                        # all files
npm run test:dry -- opencode            # files whose name contains "opencode"
npm run typecheck                       # src and test/dry
```

| File | Covers |
|---|---|
| `storage.test.ts` | Legacy `claudeSessionId` migration, harness defaults, chat persistence |
| `terminal.test.ts` | Launch/resume/fork commands per harness, missing-session handling, terminal reuse, restart sync |
| `tree.test.ts` | Chat ordering, quiet-view descriptions, tooltip brief, lazy opencode previews, harness icons |
| `icons.test.ts` | Generated harness icon files exist: `working` is animated with no badge and honors reduced motion, `done` is the static green dot, `closed`/`new` carry their marks; state selection follows working → done → closed/new |
| `chat-commands.test.ts` | New-session commands, numbered fork names, fork in place, fork to a new worktree, cross-harness import, delete/clear |
| `fork-name.test.ts` | `nextForkName()` numbering: `title (1)`, nested `title (1) (1)`, uniqueness, blank fallback |
| `menus.test.ts` | Quiet layout: only primary actions inline, no destructive hover actions, dialog titles end in `…` |
| `changes.test.ts` | Changes panel headers (counts, colors), directory context on flat rows, status→path sorting, tooltips, empty state |
| `files.test.ts` | All Files listing: hidden entries, directories-first natural sort, relative-path tooltips, unselected placeholder |
| `safety.test.ts` | Delete guards: worktree removal refuses the repo, home, filesystem root, parents and unregistered paths; discard refuses paths outside the worktree; opencode refuses non-session IDs |
| `claude.test.ts` | Claude session discovery, adapter commands, previews, turn state, capabilities (regression) |
| `attention.test.ts` | Turn state from a synthetic transcript, including background agents that outlive the parent turn; opencode `time.idle`; hook-log parsing; `mergeAttentionHooks` / `removeAttentionHooks` preserving existing hooks, backups, idempotence, and refusing invalid JSON |
| `claude-scoping.test.ts` | Discovery parses only the project dirs for the requested worktree/repository, using a synthetic temp `HOME` |
| `claude-watcher.test.ts` | Claude new-session linkage + auto-naming, using a temp `HOME` |
| `opencode.test.ts` | Opencode discovery, adapter commands, previews, fork/move/delete |
| `opencode-watcher.test.ts` | Opencode new-session linkage + title rename, using a scratch session |
| `codex.test.ts` | Codex adapter commands, cwd filtering, metadata/previews, fork results, rollout turn state/tokens, incremental updates |
| `codex-app-server.test.ts` | JSON-RPC client against a fake app-server: handshake, request matching, errors, timeouts, restart, idle shutdown |
| `codex-watcher.test.ts` | Codex new-session linkage + auto-naming, with a fake adapter |

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `AGNTREE_TEST_CLAUDE_REPO` | `claude.test.ts` | Repository whose Claude sessions are inspected. Defaults to the current directory; the test skips when none are found. |
| `AGNTREE_TEST_OPENCODE_WORKTREE` | `opencode.test.ts` | Directory whose opencode sessions are inspected. Defaults to the current directory; the test skips when none are found. |
| `AGNTREE_TEST_TIMEOUT_MS` | `run.js` | Per-file timeout (default 180000). |

Scratch sessions and temp directories created by the opencode tests are deleted
before exit. The opencode tests skip when the CLI is not installed. No opencode
model turn is executed.

The Codex tests do not require the Codex CLI: `codex-app-server.test.ts` spawns
a fake Node JSON-RPC server from `test/dry/fixtures/`, and the harness/watcher
tests inject a fake app-server. No Codex model turn is executed.

## Writing a dry test

Choose the cheapest layer that proves the behavior:

| You changed | Test it as |
|---|---|
| A pure helper | Import it directly; no `vscode` and no files. |
| A service or provider | Bundle it under `vscode-stub.js`, use a temp directory, drive public methods. |
| A harness adapter | Inject a fake app-server/CLI, or write a synthetic transcript/rollout. |
| A child-process protocol | Spawn a fake server from `test/dry/fixtures/` and assert the wire behavior. |
| A command flow | Register commands on the stub, fake storage/terminals, execute the command. |
| Manifest, activation, menu gating | Put it in `test/integration/suite/index.js`. |

Each dry test is a standalone script with the same shape:

```ts
import { thing } from '../../src/path';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

async function main(): Promise<void> {
  console.log('\n== behavior ==');
  check(thing() === expected, 'thing does the expected thing');

  console.log(
    `\n${failures === 0 ? 'ALL ... CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
```

Rules:

- **Fake at the boundary.** Do not mock the code under test; fake the process,
  filesystem, or `vscode` surface around it.
- **No model turns or network calls.** Optional real-session discovery must skip
  cleanly when no sessions exist.
- **Clean up.** Remove temp directories, scratch sessions, and child processes
  before exit, including on failure.
- **Test observable behavior.** Assert commands, returned shapes, labels,
  warnings, and persisted records rather than private method calls.
- **Avoid sleeps.** Await the operation that establishes the precondition when the API
  exposes it; otherwise poll an explicit condition instead of adding fixed latency.
- **Extend the stub deliberately.** If `vscode-stub.js` lacks a surface, add it
  there rather than adding a production conditional for tests.
- **Update this file.** Add a row for every new `*.test.ts`, and keep
  `npm run typecheck` (which now includes `test/dry/**/*.ts`) passing.

## Integration test (`test/integration`)

`runTest.js` starts VS Code with the repo loaded as an extension development
path and a throwaway user-data/extensions profile, then runs
`suite/index.js` inside the extension host. The suite checks activation, the
registered command set, contributed settings, new-session submenus and their
install gating, the attention-hook toggles, and that refresh works.

```bash
npm run test:integration
```

VS Code is found automatically on macOS, Windows, and Linux; override with
`VSCODE_EXECUTABLE=/path/to/code` when it lives elsewhere. Set
`AGNTREE_TEST_KEEP=1` to keep the temp profile for debugging.
