---
name: add-feature
description: Add a feature to the Agntree VS Code extension following the project's working agreement. Use when implementing new functionality, adding commands, extending a harness, or changing tree/menu behavior.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Add a Feature to Agntree

Read [`AGENTS.md`](../../../AGENTS.md) first — it is the working agreement and the canonical
checklist. [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) is the architecture reference and
[`test/README.md`](../../../test/README.md) is the test matrix. This skill is the short
path through them.

## 1. Pre-flight

Do not start with a file. Start with these answers:

1. What behavior changes? Write one sentence plus the edge cases and non-goals.
2. Which layer owns it? Trace the existing path with `rg` before adding anything.
3. Does the native tool actually support it? Run the CLI/API and record the version and
   exact method/fields. Do not code from memory.
4. What happens when it is missing, slow, malformed, or a different version?
5. What does it cost per tree render, and what needs caching, pagination, or lazy loading?
6. Does it touch persisted state, git, or files? Plan the migration or scope guard.
7. Where is the cheapest test boundary that still exercises the real logic?
8. Which docs change: README, `CHANGELOG.md`, `ARCHITECTURE.md`, `test/README.md`, `ROADMAP.md`?

## 2. Choose the layer

| Change | Home |
| --- | --- |
| Differs per harness | `src/harnesses/<Harness>Harness.ts` (add a method or capability first) |
| New-session linkage | `src/services/<Harness>SessionWatcher.ts` + `HarnessWatcherRegistry` |
| User action or flow | `src/commands/*.ts` + `package.json` |
| Tree row, tooltip, icon state | `src/providers/*.ts`, `src/harnesses/sessionUtils.ts` |
| Persistence | `src/services/StorageService.ts` (migrate on read) |
| Git or paths | `src/services/GitService.ts`, `src/utils/paths.ts` |
| External process/protocol | A service in `src/services/` |
| Command/menu/setting/context key | `package.json` + `src/extension.ts` |

Never put `if (chat.harness === ...)` in a command, provider, or shared service. Put the
difference behind `HarnessAdapter` or a capability flag.

## 3. Implement in order

1. **Seam first, only if needed.** Change `src/harnesses/types.ts` or `src/types.ts` before
   the implementation, and keep the interface as small as the feature allows.
2. **Lower layer next.** External I/O and parsing in a service; harness behavior in the
   adapter. Accept injected dependencies so tests can fake the boundary.
3. **Wire the user path.** Register in `src/extension.ts`, contribute in `package.json`, and
   pick the right surface: inline only for the primary action; everything else in the `…`
   or context menu. Dialog titles end in `…`. Gate harness entries on
   `agntree.<harness>Installed`.
4. **Render quietly.** Stable tree ids and `contextValue`; short labels; detail in the
   tooltip; harness mark from `treeIcons`; no destructive actions in the hover row.
5. **Persist safely.** Read old shapes and migrate in `StorageService`; never require a
   reinstall or drop a chat because a field is absent.
6. **Test at the cheapest layer.** Pure helper → direct test. Service/provider → vscode stub
   and temp dirs. Harness → fake CLI/app-server or synthetic transcripts. Manifest/menu/
   activation → integration suite.
7. **Document it.** `CHANGELOG.md` under `Unreleased`, plus README/architecture/test matrix
   as applicable. Deferred work goes in `ROADMAP.md`.

## 4. Common recipes

### A new command

- Add it to `contributes.commands` in `package.json` with a title and codicon.
- Add menu entries with the correct `when` clause and group. Dialog commands end in `…`.
- Register it in the matching `src/commands/*.ts` file and make sure the register function
  is called from `extension.ts`.
- Test it in `test/dry/chat-commands.test.ts` (or the relevant command test): register on
  the stub, fake storage/terminals, execute the command, assert the result.

### A tree row or tooltip change

- Give the row a stable `id` and a `contextValue` that matches its menu entries.
- Keep the label quiet: short relative time or `new`, star, harness mark.
- Put the brief in `tooltip`: recap or last exchange, then message count, model, agent,
  tokens, and cost.
- Icon state comes from `selectHarnessIconState()`; do not hand-pick SVGs in a provider.
- Test the rendered label/tooltip in `test/dry/tree.test.ts`.

### A new harness

Follow [`AGENTS.md`](../../../AGENTS.md#adding-a-harness) and
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#adding-support-for-new-ai-coding-agents). In
short: `HarnessId`, adapter, service if needed, watcher, registry wiring, command and both
New Session submenus, `harnessCommands`, generated icons, tests, and docs. The adapter must
cover installed detection, launch/resume/fork commands, resumability, discovery scoped by
worktree, metadata/previews, and fork results. Decide the live-turn-state source explicitly;
if the API cannot report TUI-owned sessions, document which log is tailed. Reuse an existing
watcher mechanism when its lifecycle matches; otherwise implement `HarnessSessionWatcher`
directly — do not copy a poll loop to change one step.

### A service that owns a process

- Start lazily, not at activation.
- Give every request a timeout and expose a typed error.
- Restart on the next request after an exit, and ignore exit events from a replaced child.
- Shut down after an idle period and dispose on deactivation.
- Put the command and args behind options so a fixture can replace them.
- Test the protocol against `test/dry/fixtures/` rather than the real binary.

## 5. Review the diff

Read it as if someone else wrote it. The full prompt table is in
[`AGENTS.md`](../../../AGENTS.md#reviewing-your-own-diff); the questions to keep in mind:

- Is the same flow, lifecycle, or invariant implemented in more than one place? Name the
  shared mechanism, or explain why the duplication is intentional.
- Is every cache, timer, listener, and process bounded and owned?
- Did I leave a branch, option, protocol method, or helper with no caller and no test?
- Does an abstraction have one caller? Inline it until a second real caller exists.
- Does a test wait on a fixed sleep instead of the precondition it needs?

Prefer the smallest change that removes the cost. Do not shorten code by making failure
behavior less clear.

## 6. Verify

```bash
npm run typecheck
npm run compile
npm run test:dry
npm run test:integration   # when commands, menus, settings, or activation changed
```

Then use F5 for UI work and check both themes. There is no ESLint setup in this repository;
`npm run typecheck` is the static check. Do not claim a change is visible in VS Code until
the Extension Development Host or a reloaded window shows it.

## 7. Pitfalls

- Copying a flow instead of naming the shared mechanism, or abstracting a trivial
  duplication with one caller.
- A fixed sleep where an awaited operation or explicit condition would do.
- Reading opencode's SQLite database or Codex's state database directly.
- Shell interpolation in git; unquoted paths in terminal commands.
- Deleting or overwriting without `isWithin`, a one-segment name check, or `overwrite: false`.
- Unbounded caches, leaked listeners/timers, or a child process that outlives deactivation.
- Editing generated icons instead of `resources/icons/harness/base/`.
- Adding `detail` to every QuickPick row or destructive buttons to the hover row.
- Forgetting the `CHANGELOG.md` entry and the test-matrix row.
