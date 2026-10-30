# Tests

Two suites, both runnable without packaging or installing the extension, plus an
optional end-to-end check that launches a real VS Code window. For how to choose
a layer and what a dry test should look like, see
[`AGENTS.md#testing-doctrine`](../AGENTS.md#testing-doctrine).

| Suite | Command | What it does |
|---|---|---|
| Dry tests | `npm run test:dry` | Bundles source modules with esbuild, aliases `vscode` to a stub, and runs them in plain Node. |
| Integration test | `npm run test:integration` | Launches a real VS Code Extension Development Host and activates the extension. |
| Terminal-restore E2E (optional) | `npm run test:e2e` | Launches the installed VS Code in a throwaway profile and drives three real editor terminals through quit/reopen cycles with a fake harness CLI. |

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
| `storage.test.ts` | Legacy `claudeSessionId` migration, harness defaults, chat persistence, per-workspace terminal PID records (workspace-folder switch, legacy migration, deletion) |
| `terminal.test.ts` | Launch/resume/fork commands per harness, chosen pending IDs, missing-session handling, terminal reuse, exited-process cleanup, unused-fork cleanup on close, resolving a chat from a terminal title, restore sync by PID (reload adoption, late adoption, revived-tab resume into the chat's worktree, duplicate-title de-duplication, watcher re-registration for unlinked chats, ownership sweep, title re-application, overlapping title writes, background retitles not reported as user focus, adoption finishing before a slow harness check, a click during that check, the resume-in-progress guard clearing when the launch starts, a failing late adoption) |
| `tree.test.ts` | Creation-order chat rows that never move when a chat is opened or starred, quiet-view descriptions, tooltip brief, native-UI context suffix and active mark, lazy opencode previews, harness icons, caching each repository's worktree list, plain folder roots rendering sessions directly, upgrading after `git init` through a file watcher, and returning to a folder when `.git` is removed, all while keeping the worktree id |
| `icons.test.ts` | Generated harness icon files exist: `working` is animated with no badge and honors reduced motion, `done` is the static green dot, `closed`/`new` carry their marks; state selection follows working → done → closed/new |
| `chat-commands.test.ts` | New-session commands with chosen IDs, numbered fork names, fork in place, fork to a new worktree, cross-harness import, delete/clear, creating a session from a plain folder row, a folder session refusing Fork to New Worktree, no pending ID minted when an existing terminal is focused, the Claude and Codex UI handoffs closing a running terminal, binding the tab, and selecting the row, a row click revealing an open UI panel instead of starting a CLI, the starred-session picker using that same path, the configured default surface and its terminal fallback, an explicit terminal override, a new UI session creating a placeholder that the importer links and renames, a failed UI open removing its placeholder, and a missing UI extension being explained instead of silently starting a CLI |
| `session-import.test.ts` | Auto-import: recent native sessions named by the harness, the retention window that ages out every row, user-removal tombstones, linking a UI-started placeholder, keeping starred and open chats, reserving a CLI placeholder's session for its watcher, a stale placeholder reserving nothing, the launch snapshot surviving a reload, following a later harness name, preserving a user rename, and the disable switch |
| `fork-name.test.ts` | `nextForkName()` numbering: `title (1)`, nested `title (1) (1)`, uniqueness, blank fallback |
| `menus.test.ts` | Quiet layout: no destructive hover actions, Terminal and installed UI actions in the hover row, UI actions visible in the context menu when the extension is missing, the new-session default/alternate entries, dialog titles ending in `…`, no attention-hook commands or menus, and plain folders exposing shared but not git-only actions |
| `changes.test.ts` | Changes panel headers (counts, colors), directory context on flat rows, status→path sorting, tooltips, empty and plain-folder states |
| `workspace-roots.test.ts` | Plain folders as workspace roots: `GitService` reports one root worktree with a stable id that survives `git init`, a folder inside a repository stays its own root, bare repositories have no worktrees, the Add command accepts a plain folder or resolves a subdirectory to the repository root, and Move Up / Move Down reorder the stored rows |
| `files.test.ts` | All Files listing: hidden entries, directories-first natural sort, relative-path tooltips, unselected placeholder |
| `safety.test.ts` | Delete guards: worktree removal refuses the repo, home, filesystem root, parents and unregistered paths; discard refuses paths outside the worktree; opencode refuses non-session IDs |
| `claude.test.ts` | Synthetic Claude transcript: discovery, previews, full-parser turn state, resume validation, lean metadata, `ai-title` session naming ahead of the first-prompt fallback, launch/fork commands, fork-source validation, relocation, live states |
| `claude-ui.test.ts` | Claude UI handoff: extension detection, first-folder guard, preferred-location command, documented URI fallback, new-conversation opening with no session ID, and failures that must not start a fresh chat |
| `claude-ui-surface.test.ts` | Claude UI tab tracking: expectation binding, open state, title preference, active tab/group changes, settle and cancel, a background link that only binds a matching title, close cleanup, and ignoring non-Claude tabs |
| `codex-ui.test.ts` | Codex UI handoff: extension detection, no workspace-folder restriction, the conversation-panel resource, active-group placement, new-panel preflight (single-folder, mismatch, multi-root), and failures that must not open a new chat |
| `codex-ui-surface.test.ts` | Codex UI tab tracking by conversation URI: restored panels, exact session identity, active tab/group changes, settle and close cleanup, and ignoring other custom editors |
| `claude-turn-state.test.ts` | Shared turn-state derivation and the progressive tail reader: working/done, background agents, sidechain entries, incomplete last line, large trailing lines, expansion to the file start |
| `claude-agents.test.ts` | `claude agents --json` parsing and service behavior: busy/idle/waiting, missing reasons, duplicate session IDs, malformed output, cache, in-flight sharing, disabled setting, permanent failure, Windows shell flag |
| `attention.test.ts` | opencode `time.idle`; live-state transitions and needs-input cooldown; priming a pre-existing wait silently; discovery fallback for harnesses without `getLiveStates`; polling native-UI chats without a terminal; notification focus suppression |
| `claude-scoping.test.ts` | Project-directory encoding (realpath, symlinks, special characters, unicode, long paths), duplicate transcript resolution, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, and `cwd` disambiguation, using a synthetic temp profile |
| `claude-watcher.test.ts` | Claude exact-pending-ID linkage and auto-naming, with no directory matching: empty transcripts stay pending, abandoned closed chats expire, restored nameless chats are renamed, using a temp `CLAUDE_CONFIG_DIR` |
| `opencode.test.ts` | Opencode discovery, adapter commands, previews, fork/move/delete |
| `opencode-watcher.test.ts` | Opencode new-session linkage + title rename, using a scratch session |
| `codex.test.ts` | Codex adapter commands, cwd filtering, metadata/previews, fork results, rollout turn state/tokens, incremental updates |
| `codex-app-server.test.ts` | JSON-RPC client against a fake app-server: handshake, request matching, errors, timeouts, restart, idle shutdown |
| `codex-watcher.test.ts` | Codex new-session linkage + auto-naming, with a fake adapter |

### Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `AGNTREE_TEST_OPENCODE_WORKTREE` | `opencode.test.ts` | Directory whose opencode sessions are inspected. Defaults to the current directory; the test skips when none are found. |
| `AGNTREE_TEST_TIMEOUT_MS` | `run.js` | Per-file timeout (default 180000). |

Scratch sessions and temp directories created by the opencode tests are deleted
before exit. The opencode tests skip when the CLI is not installed. No opencode
model turn is executed.

The Claude tests use synthetic transcripts under a temp `CLAUDE_CONFIG_DIR` and
do not read the developer's `~/.claude` profile.

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
