# Tests

Two suites, both runnable without packaging or installing the extension:

| Suite | Command | What it does |
|---|---|---|
| Dry tests | `npm run test:dry` | Bundles source modules with esbuild, aliases `vscode` to a stub, and runs them in plain Node. |
| Integration test | `npm run test:integration` | Launches a real VS Code Extension Development Host and activates the extension. |

## Dry tests (`test/dry`)

Each `*.test.ts` is a self-contained script. `run.js` bundles it with the
`vscode` module aliased to `vscode-stub.js` (or `vscode-quickactions-stub.js`
for quick actions), then runs the bundle under Node. Tests print `PASS`/`FAIL`
lines and exit non-zero on failure.

```bash
npm run test:dry                        # all files
npm run test:dry -- opencode            # files whose name contains "opencode"
```

| File | Covers |
|---|---|
| `storage.test.ts` | Legacy `claudeSessionId` migration, harness defaults, chat persistence |
| `terminal.test.ts` | Launch/resume/fork commands per harness, missing-session handling, terminal reuse, restart sync |
| `tree.test.ts` | Chat ordering, quiet-view descriptions, tooltip brief, lazy opencode previews, harness icons |
| `icons.test.ts` | Generated harness icon files exist, carry the right badge, and state selection follows running → closed/new |
| `chat-commands.test.ts` | New-session commands, numbered fork names, fork in place, fork to a new worktree, cross-harness import, delete/clear |
| `fork-name.test.ts` | `nextForkName()` numbering: `title (1)`, nested `title (1) (1)`, uniqueness, blank fallback |
| `menus.test.ts` | Quiet layout: only primary actions inline, no destructive hover actions, dialog titles end in `…` |
| `changes.test.ts` | Changes panel headers (counts, colors), directory context on flat rows, status→path sorting, tooltips, empty state |
| `files.test.ts` | All Files listing: hidden entries, directories-first natural sort, relative-path tooltips, unselected placeholder |
| `safety.test.ts` | Delete guards: worktree removal refuses the repo, home, filesystem root, parents and unregistered paths; discard refuses paths outside the worktree; opencode refuses non-session IDs |
| `quickactions.test.ts` | Harness-aware quick action commands, argument construction, error handling, output channel |
| `claude.test.ts` | Claude session discovery, adapter commands, previews, capabilities (regression) |
| `claude-scoping.test.ts` | Discovery parses only the project dirs for the requested worktree/repository, using a synthetic temp `HOME` |
| `claude-watcher.test.ts` | Claude new-session linkage + auto-naming, using a temp `HOME` |
| `opencode.test.ts` | Opencode discovery, adapter commands, previews, fork/move/delete |
| `opencode-watcher.test.ts` | Opencode new-session linkage + title rename, using a scratch session |

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `AGNTREE_TEST_CLAUDE_REPO` | `claude.test.ts` | Repository whose Claude sessions are inspected. Defaults to the current directory; the test skips when none are found. |
| `AGNTREE_TEST_OPENCODE_WORKTREE` | `opencode.test.ts` | Directory whose opencode sessions are inspected. Defaults to the current directory; the test skips when none are found. |
| `AGNTREE_FAKE_CLAUDE` / `AGNTREE_FAKE_OPENCODE` | `quickactions.test.ts` | Scripts substituted for the real CLIs so no model turns run. |
| `AGNTREE_TEST_COMMAND_OUTPUT` | `quickactions.test.ts` | File the fake shell command writes to. |
| `AGNTREE_TEST_TIMEOUT_MS` | `run.js` | Per-file timeout (default 180000). |

Scratch sessions and temp directories created by the opencode tests are deleted
before exit. No opencode model turn is executed.

## Integration test (`test/integration`)

`runTest.js` starts VS Code with the repo loaded as an extension development
path and a throwaway user-data/extensions profile, then runs
`suite/index.js` inside the extension host. The suite checks activation, the
registered command set, contributed settings, new-session submenus, the quick
action schema, and that refresh works.

```bash
npm run test:integration
```

VS Code is found automatically on macOS, Windows, and Linux; override with
`VSCODE_EXECUTABLE=/path/to/code` when it lives elsewhere. Set
`AGNTREE_TEST_KEEP=1` to keep the temp profile for debugging.
