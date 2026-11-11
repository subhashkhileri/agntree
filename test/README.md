# Tests

Two suites, both runnable without packaging or installing the extension, plus an
optional end-to-end check that launches a real VS Code window. Which layer to test at,
and the rules every test follows, are in
[`AGENTS.md#testing-doctrine`](../AGENTS.md#testing-doctrine); this file covers the
mechanics.

| Suite | Command | What it does |
|---|---|---|
| Dry tests | `npm run test:dry` | Bundles source modules with esbuild, aliases `vscode` to a stub, and runs them in plain Node. |
| Integration test | `npm run test:integration` | Launches a real VS Code Extension Development Host and activates the extension. |
| Terminal-restore E2E (optional) | `npm run test:e2e` | Launches the installed VS Code in a throwaway profile and drives three real editor terminals through quit/reopen cycles with a fake harness CLI. |

## Dry tests (`test/dry`)

Each `*.test.ts` holds a few `node:test` tests, one behavior per test. `run.js`
bundles every file with the `vscode` module aliased to `vscode-stub.js`, then
runs the bundles with `node --test`: each file gets its own process, tests in a
file run in order, and the stub is reset before each test that uses it.

| File | Covers |
|---|---|
| `helpers.test.ts` | Pure rules: numbered fork names, the row icon state table, the last-exchange stale-reply rule, the launch claim rule, deepest-worktree matching, JSON Schema checks named by path, cmd.exe quoting |
| `icons.test.ts` | Every harness ships generated (not hand-edited) marks for each theme and state; working animates and honors reduced motion, done is a green dot, closed is grey, new is a ring |
| `menus.test.ts` | Manifest rules: a quiet hover row with nothing destructive, plain folders without git-only actions, New Session entries gated on their harness, UI entries that explain a missing extension, dialog ellipses |
| `storage.test.ts` | Legacy chat migration (once), repository order past legacy hidden entries, per-workspace terminal PIDs and their legacy migration, removal tombstones |
| `git.test.ts` | Real `git`: plain folders keep their worktree id through `git init`, change lists classify renames, deletions, binaries, untracked and non-ASCII paths, discard, copying uncommitted work (binary edits, unusual names, no overwrite), the Discard All summary, force-removal guards |
| `changes.test.ts` | Changes panel sections and rows, empty states, and the destructive Discard / Discard All commands (scope guard, Trash, exact confirmation text) |
| `files.test.ts` | All Files listing: folders first in natural order, hidden build and VCS output, stable ids |
| `workspace-roots.test.ts` | Add accepts a plain folder, resolves a subdirectory to its repository, refuses a bare repository; Move Up / Down; Remove forgets every worktree of the root |
| `worktree-commands.test.ts` | Create Worktree places a new branch under `<repo>-worktrees` and hides checked-out branches; Delete closes sessions before removing the directory and never deletes a branch from a detached worktree; Delete & Branch; Rebase targets exclude the branch's own remote copy and list the recommended one first |
| `tree.test.ts` | Session rows in stable creation order with quiet descriptions and harness marks, the open/working marks, tooltips (lazy previews fetched on hover via `resolveTreeItem`), worktree lookup caching, plain folders upgrading on `git init` and back |
| `terminal.test.ts` | Launch decisions (new, chosen ID, resume, repeat a fork), missing sessions, focus versus relaunch, close semantics, and restore: adoption by PID after a reload, background resume after a quit, duplicate titles, the title race, a slow harness check, contained failures |
| `chat-commands.test.ts` | New sessions, legacy chats, the UI handoff and its refusals, revealing an open UI panel, the default surface, UI placeholders, forks in place and into a new worktree, import, and removal with tombstones |
| `session-import.test.ts` | Auto-import and harness names, user renames, tombstones, the disable switch, retention with stars and open chats, linking UI placeholders, the launch snapshot across a reload, CLI placeholders reserving their session, nested workspace roots keeping their own sessions and misplaced rows moving to them |
| `pending-watcher.test.ts` | Codex/opencode linkage: claiming the session that appears after a launch but not one from a nested workspace root, launch order, and opencode's first-prompt naming fallback |
| `attention.test.ts` | Needs-you cooldown, one notification per finished turn and per wait (never at startup), discovery fallback, native-UI polling, focus suppression |
| `claude.test.ts` | Resume validation, naming precedence, names and previews from typed prompts only, lean metadata, launch and fork commands, live state with the `claude agents` waiting reason, relocation |
| `session-search.test.ts` | Find Session against a fake `claude` and synthetic transcripts: the cheap default engine, read-only flags with no allow list or saved session, the prompt carrying the question, Claude's instructions, and the reply's JSON Schema, a reply that breaks the schema sent back to the same process with its problems (and a failed search after two tries), only sessions Claude confirms (an ID that is a path is hidden, a quote from injected context is dropped, the quoted prompt's real time), each search in its own folder, removal of the CLI's leftover project directory, cancel ending the process and what it started, a new question replacing a running search while one overtaken in the queue never starts, one transcript pass per quote with no file left open, a failed CLI's error, the newest ten searches with malformed records and unknown harnesses skipped |
| `session-search-commands.test.ts` | Find Session commands over a fake harness: the question box shows the engine and its gear changes it for the next question; Resume and Show in Workspaces import a found session into its owning root once; a session outside every root resumes in a terminal at its folder and copies its resume command; Stop while matches are confirmed cancels |
| `claude-turn-state.test.ts` | The shared tail reader and Claude's full parser agree at every step of a turn; tail windowing, partial lines, reading back to the file start |
| `claude-scoping.test.ts` | Discovery scoped to a worktree's own project directories, path encoding, symlinks, long-path prefixes, duplicate transcripts, `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_PROJECT_DIR_NAME` |
| `claude-watcher.test.ts` | Exact-ID linkage wherever the transcript is written, only once it holds a message, the TTL for closed chats, renaming restored chats |
| `exact-id-watcher.test.ts` | The shared exact-ID loop: a chat registered while a pass is awaiting is checked when that pass ends instead of being dropped with the snapshot |
| `pi.test.ts` | The Pi adapter and service against synthetic JSONL records: discovery scoped to the worktree and its subdirectories, names from `session_info` or the first prompt, previews and usage totals, turn state, launch/resume/fork commands, resume scoping, `sessionDir` overrides (env and project), live states, and malformed or truncated records |
| `pi-watcher.test.ts` | Pi exact-ID linkage: the record appears only after the first prompt, only the chosen ID links, and a restored chat is renamed from a record stored under a project `sessionDir`. The TTL and restored-rename rules of the shared loop are covered by `claude-watcher.test.ts` |
| `claude-agents.test.ts` | `claude agents --json` parsing, deterministic duplicate merge, the cache and shared in-flight call, disable-on-failure |
| `native-ui.test.ts` | Claude and Codex UI availability rules, the command and URI paths, failures that never fall back to a new chat |
| `native-ui-surface.test.ts` | Tab tracking: focus following tabs and groups, Codex panels by resource, Claude tabs by title expectation, background links that need a matching title |
| `codex.test.ts` | Codex launch commands, discovery with rollout state and tokens, item-based previews, app-server forks, incremental rollout reads |
| `codex-app-server.test.ts` | JSON-RPC client against a fake server: request matching, the fork writer lock, errors and timeouts, restart and idle shutdown, start backoff, dispose |
| `opencode.test.ts` | The opencode adapter against a fake CLI: cursor pagination shared by concurrent callers, one export per preview, fork-then-move with orphan cleanup, the standalone API fallback, the delete guard, turn state |

### Fakes and fixtures

| File | Stands in for |
|---|---|
| `vscode-stub.js` | The `vscode` module. `__reset()` clears messages, terminals, commands, listeners, and settings between tests. |
| `support.ts` | Typed stub controls, in-memory `Memento`/`StorageService`, temp directories, `waitFor`, record factories, and fake adapters / native UIs. |
| `claudeFixture.ts` | A synthetic Claude profile under a temp `CLAUDE_CONFIG_DIR` (or `HOME`) with transcript writers. |
| `piFixture.ts` | A synthetic Pi profile under a temp `PI_CODING_AGENT_DIR` with session-entry builders and a writer that names records the way Pi does. |
| `fixtures/fake-codex-app-server.js` | `codex app-server` over JSON-RPC. |
| `fixtures/fake-opencode.js` | The `opencode` CLI, answering from a JSON state file and recording each call. POSIX only; the tests skip on Windows. |
| `fixtures/fake-claude-search.js` | `claude --print --input-format stream-json` as Find Session runs it: plays one scenario turn of stream-json events per user message, records its arguments, every message, its cwd, and every start, and can hang, fail, start a grandchild that holds its output, or leave the project directory the real CLI leaves. POSIX only. |
| `fixtures/claude-agents.json` | Sample `claude agents --json` output. |

No test reads the developer's `~/.claude`, opencode database, Codex state, or `~/.pi`, and
none needs a harness CLI installed. No model turn or network call is made.

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `AGNTREE_TEST_TIMEOUT_MS` | `run.js` | Per-test timeout (default 60000). |

## Writing a dry test

Bundle the module under test with the stub, build the fixture in the test, and assert what
the behavior promises:

```ts
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, stub, tempDir } from './support';

beforeEach(() => stub.__reset());

test('a user removal leaves a tombstone; a retention delete does not', (t) => {
  const dir = tempDir(t); // removed when the test ends, pass or fail
  const storage = makeStorage();
  // ...drive public methods, then assert observable results:
  assert.deepEqual([...storage.getRemovedSessionKeys()], ['codex:thread-1']);
});
```

Add a row to the table above for every new `*.test.ts`; `npm run typecheck` covers
`test/dry/**/*.ts`.

## Integration test (`test/integration`)

`runTest.js` starts VS Code with the repo loaded as an extension development
path and a throwaway user-data/extensions profile, then runs
`suite/index.js` inside the extension host. The suite checks activation, that
every contributed command is registered, contributed settings, new-session submenus and their
install gating, the absence of attention-hook commands and menus, and that
refresh works.

```bash
npm run test:integration
```

VS Code is found automatically on macOS, Windows, and Linux; override with
`VSCODE_EXECUTABLE=/path/to/code` when it lives elsewhere. Set
`AGNTREE_TEST_KEEP=1` to keep the temp profile for debugging.

## Optional terminal-restore E2E (`test/e2e/terminal-restore`)

This is not part of `npm run test:dry` or `npm run test:integration`. It opens a
real VS Code window, takes about a minute, and proves the user-visible restore
contract: three chats in three linked worktrees open; quit; reopen; quit; reopen.
Every restored tab must carry its Agntree title, resume its own harness session in the
background, run with its working directory set to its own worktree (never the workspace
folder), and leave the previously active tab active.

A fake `claude` CLI (a Node script that logs its arguments and working directory and
idles) stands in for the real harness. No model turn, network call, login, or `~/.claude`
access is involved: the user-data dir, extensions dir, git workspace, and Claude config
all live under a fresh temp directory.

```bash
npm run test:e2e
AGNTREE_E2E_SCENARIO=no-shell-integration npm run test:e2e
```

Prerequisites:

- VS Code (same resolver as the integration suite; `VSCODE_EXECUTABLE` overrides)
- `git`
- a desktop session (Linux without `DISPLAY`/`WAYLAND_DISPLAY` skips)
- `node:sqlite` (Node 24, or Node 22 with `--experimental-sqlite`) or the
  `sqlite3` CLI, to seed the throwaway profile

| `AGNTREE_E2E_SCENARIO` | Expectation |
|---|---|
| `default` | every tab resumes after each quit |
| `no-shell-integration` | same, with `terminal.integrated.shellIntegration.enabled` off |
| `custom-tab-title` | same, with a non-default `terminal.integrated.tabs.title` |
| `persistent-sessions-off` | VS Code keeps no terminal tabs; no resume is attempted |
| `revive-never` | VS Code restores plain shells without identity; no resume is attempted |

`AGNTREE_E2E_ROOT` sets the parent directory for the temp profile. Keep it short
(VS Code's unix socket path is limited to 103 characters, so macOS/Linux default
to `/tmp`) and executable: the fake CLI wrapper lives there, and some hardened
Linux systems mount `/tmp` with `noexec`. `AGNTREE_TEST_KEEP=1` keeps the profile
and logs.
