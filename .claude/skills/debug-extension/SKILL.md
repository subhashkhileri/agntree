---
name: debug-extension
description: Debug and troubleshoot the Agntree VS Code extension. Use when there are errors, the extension isn't working, or when investigating issues.
allowed-tools:
  - Bash
  - Read
  - Grep
  - Write
---

# Debug Extension

Troubleshoot issues with the Agntree VS Code extension.

## Check Compilation Errors

```bash
# From the repository root
npm run compile
```

Look for TypeScript errors in the output.

## View Extension Logs

In VS Code:
1. Open Command Palette (Cmd+Shift+P)
2. Run "Developer: Show Logs"
3. Select "Extension Host" from the dropdown

Or check the Output panel:
1. View > Output
2. Select "Extension Host" or "Agntree"

## Common Issues

### Extension Not Activating

Check `package.json` activation events:
```json
"activationEvents": ["onStartupFinished"]
```

Verify the extension is installed:
```bash
code --list-extensions | grep agntree
```

### Commands Not Appearing

1. Check command is defined in `package.json` under `contributes.commands`
2. Verify menu entries have correct `when` clauses
3. Ensure `contextValue` matches the menu filter

### Tree View Empty

1. Check if repositories are stored in globalState
2. Verify `getChildren()` is returning items
3. Look for errors in Extension Host logs

### File Watcher Not Working

1. Verify worktree path is correct
2. Check if file patterns are matching
3. Look for watcher disposal issues

### Git Diff Not Opening

1. Ensure Git extension is enabled in VS Code
2. Check if the file is tracked by git
3. Verify `git.openChange` command is available

## Probe the Real Window

Use this when the symptom depends on VS Code's own host state rather than on Agntree's
logic: terminals restored after **Reload Window** versus **quit/reopen**, title persistence,
activation order, or anything that only reproduces in a real window. Stubs and unit tests
cannot show what the workbench restores.

The pattern is a throwaway driver extension plus a runner that drives the real VS Code with
an isolated profile. One launch runs one stage; a state file sequences the stages so a
quit/reopen can be tested as separate processes.

### Layout

```text
/tmp/agntree-probe/
  repo/                 # workspace folder the probe opens
  driver/               # one-file extension loaded with --extensionDevelopmentPath
    package.json
    extension.js
  user-data/            # isolated --user-data-dir (throwaway, created by the runner)
    extensions/         # isolated --extensions-dir; the installed Agntree goes here
  fake-claude.sh        # fake harness CLI: logs args, then sleeps
  run.js                # seed state, launch each stage, dump state
  state.json            # stage marker, survives process restarts
  log.jsonl             # driver log
```

### 1. Load the build under test

```bash
mkdir -p /tmp/agntree-probe/user-data/extensions
EXT=$(ls -d ~/.vscode/extensions/subhashkhileri.agntree-* | tail -1)
cp -R "$EXT" /tmp/agntree-probe/user-data/extensions/agntree
```

The runner recreates `user-data/extensions` before each run so a stale copy never hides a
freshly installed build. Never point `--user-data-dir` at the real profile; the probe writes
settings, seeds state, and opens windows.

### 2. Driver skeleton

`driver/package.json`:

```json
{
  "name": "agntree-probe-driver",
  "publisher": "probe",
  "version": "0.0.1",
  "engines": { "vscode": "^1.90.0" },
  "main": "./extension.js",
  "activationEvents": ["onStartupFinished"]
}
```

`driver/extension.js` — each launch performs one stage, then quits:

```js
const vscode = require('vscode');
const fs = require('fs');
const OUT = process.env.PROBE_OUT;
const STATE = process.env.PROBE_STATE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (entry) => fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { stage: 0 }; } };
const writeState = (state) => fs.writeFileSync(STATE, JSON.stringify(state));

exports.activate = async () => {
  const state = readState();
  log({ kind: 'activate', stage: state.stage });
  const chats = JSON.parse(process.env.PROBE_CHATS);

  if (state.stage === 0) {
    await sleep(3000); // let Agntree finish activating
    for (const chat of chats) {
      const item = { itemType: 'chat', label: chat.name, collapsibleState: 0, data: chat };
      await vscode.commands.executeCommand('agntree.openChat', item);
    }
    await sleep(2500);
    const terms = await Promise.all(
      vscode.window.terminals.map(async (t) => ({
        name: t.name,
        pid: await t.processId,
        exit: t.exitStatus?.code ?? null,
        active: t === vscode.window.activeTerminal,
      }))
    );
    log({ kind: 'snapshot', terms });
    writeState({ stage: 1 });
    await sleep(500);
    await vscode.commands.executeCommand('workbench.action.quit'); // not reload
    return;
  }

  if (state.stage === 1) {
    await sleep(5000); // activation's background work, then snapshot
    const terms = await Promise.all(
      vscode.window.terminals.map(async (t) => ({ name: t.name, pid: await t.processId }))
    );
    log({ kind: 'snapshot', terms });
    writeState({ stage: 2 });
    await vscode.commands.executeCommand('workbench.action.quit');
  }
};
```

Drive the extension through its public commands (`agntree.openChat`, `agntree.newClaudeChat`,
…) and snapshot only public surfaces (`window.terminals`, `activeTerminal`, chat rows in
state). Do not import `out/extension.js`.

### 3. Launch command

```bash
CODE="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
PROBE=/tmp/agntree-probe
"$CODE" \
  --user-data-dir="$PROBE/user-data" \
  --extensions-dir="$PROBE/user-data/extensions" \
  --extensionDevelopmentPath="$PROBE/driver" \
  --disable-gpu --skip-welcome --skip-release-notes --disable-workspace-trust \
  --new-window "$PROBE/repo"
```

Pass `PROBE_OUT`, `PROBE_STATE`, and any scenario data such as `PROBE_CHATS` in the child
environment. The runner must wait for the process to exit (with a kill timeout, e.g. 180s)
before starting the next stage.

### 4. Settings and a fake harness

Write `user-data/User/settings.json` before the first launch:

```json
{
  "agntree.harnessCommands.claude": "/tmp/agntree-probe/fake-claude.sh",
  "terminal.integrated.enablePersistentSessions": true,
  "workbench.startupEditor": "none",
  "window.restoreWindows": "none",
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false,
  "update.mode": "none"
}
```

`fake-claude.sh` answers `--version`, appends `date pid args` to a log, and sleeps, so you can
see exactly which launch and resume commands ran without a real session or model turn. Make
it executable (`chmod +x`) and keep it out of the repository; it is probe scaffolding.

### 5. Seed state

Agntree stores one JSON value under the extension id in the global state database. Seed it
with `sqlite3` (schema: `ItemTable(key TEXT UNIQUE, value BLOB)`):

```bash
DB="$PROBE/user-data/User/globalStorage/state.vscdb"
sqlite3 "$DB" "INSERT OR REPLACE INTO ItemTable(key, value) VALUES('subhashkhileri.agntree', '<json>');"
```

Escape single quotes in the JSON (`value.replace(/'/g, "''")`) before embedding it. Read the
stored shape from `src/types.ts` (`STORAGE_KEYS`) and seed the minimum: repositories, chats,
active chat, active worktree. Include every field the code path reads; a missing field usually
fails silently. Seed chats with the worktree id Agntree computes for that repository (copy it
from a real state dump or let Agntree add the repository once, then inspect) — a guessed id
makes the tree look empty and the probe misleading. `repo/` should be a git repository
(`git init`), since the worktree and session flows assume one.

### 6. Inspect after each launch

Copy the databases before opening them and query the copy with `immutable=1`:

```bash
cp "$DB" "$PROBE/db-copy.vscdb"
cp "$DB-wal" "$PROBE/db-copy.vscdb-wal" 2>/dev/null || true
sqlite3 "file:$PROBE/db-copy.vscdb?immutable=1" \
  "SELECT value FROM ItemTable WHERE key='subhashkhileri.agntree';"
```

Workspace-scoped state (the editor grid, terminal pty state) lives in a different database:

```text
user-data/User/workspaceStorage/<hash>/state.vscdb
  memento/workbench.parts.editor       # editor grid, incl. terminal title/titleSource
  terminal.integrated.bufferState      # pty-side titles, shellLaunchConfig, pids
```

For terminal restore bugs, both sides matter: the editor grid's `titleSource` is what VS
Code restores, while the pty state can still show a different title. Custom titles are
`titleSource: 0`; `1` process, `2` sequence, `3` config.

### Gotchas

- **Quit and reload are different.** A reload keeps ptys and PIDs; a quit revives each editor
  terminal as a new shell with a new PID. Test both, and test a quit twice in a row.
- **State writes are not flushed on demand.** If you copy `state.vscdb` without the `-wal`
  file you can read an older value even though memory holds the new one. Copy the sidecar
  files or checkpoint before reading; do not diagnose a "lost write" from a stale copy.
- **Wait for activation, not a fixed startup assumption.** The driver's own `activate` can
  run before Agntree's; open chats only after a short settle or until the command succeeds.
- **One stage per launch.** Writing the stage file before quitting lets the next launch
  continue the scenario without any IPC beyond the filesystem.
- **Never target the real profile.** Use a throwaway `--user-data-dir`; do not write harness
  data under `~/.claude` or read opencode/Codex internal databases.

## Reinstall Extension

```bash
# From the repository root
code --uninstall-extension agntree.agntree
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension agntree-0.1.0.vsix
```

Then reload VS Code window (Cmd+Shift+P > "Developer: Reload Window").

## Debug with Breakpoints

1. Open the extension project in VS Code
2. Press F5 to launch Extension Development Host
3. Set breakpoints in TypeScript files
4. Interact with extension in the new window
5. Breakpoints will trigger in the original window

## Check Storage State

For the installed build, extension-host logs, stored chats, and harness session files, follow
the `inspect-runtime-state` skill. It derives the editor's user-data and extensions
directories at run time instead of assuming a path, and keeps every read read-only.

## Reset Extension State

To clear all stored data, run in VS Code developer console:
```javascript
// Get the extension context and clear globalState
// (requires modifying extension.ts temporarily)
```

Or uninstall and reinstall the extension.
