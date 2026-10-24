---
name: inspect-runtime-state
description: Read Agntree's live state from a running VS Code editor — installed bundle, extension-host logs, globalState database, and harness session files. Use when a symptom in the running extension does not match the code, a session or chat row behaves oddly, or a freshly installed build still seems stale.
allowed-tools:
  - Bash
  - Read
  - Grep
---

# Inspect runtime state

The extension under test is an installed VSIX inside the user's editor. Its state is not in the
repository: it lives in the editor's user-data directory and in each harness's own session
store. This is the map. **Derive every path at run time** — the editor edition, platform, and
any `--user-data-dir` all move them.

## Ground rules

- **Read-only.** Never write to the editor's state database or to a harness profile. Copy the
  database before querying it; run `--help` / `--json` reads instead of anything that creates a
  session.
- **Never open opencode's or Codex's internal databases** (see `AGENTS.md`). Their CLIs are the
  supported surface; Claude offers only its JSONL transcripts.
- **Quote paths.** The macOS user-data path contains spaces.
- **Report evidence, not conclusions.** Timestamps, session IDs, and file names let the user
  check the answer.

## 1. Which build is actually running

An open window keeps the code it activated with; a new VSIX changes nothing until
**Developer: Reload Window**.

```bash
code --list-extensions --show-versions | grep -i agntree
```

The installed folder is `<extensions-dir>/<publisher>.<name>-<version>` — normally
`~/.vscode/extensions` (macOS/Linux), `%USERPROFILE%\.vscode\extensions` (Windows), or an
edition-specific sibling (`~/.vscode-insiders`, `~/.vscode-server`, `~/.cursor`). `stat` its
`out/extension.js` and `grep` it for a symbol the change introduced. If the symbol is absent,
the fix is a reload, not a code change.

## 2. Extension-host logs

`console.log` and `logOperation` output go to the editor's log tree, not the terminal.

```bash
# user-data dir: $HOME/Library/Application Support/Code (macOS),
#                $HOME/.config/Code (Linux), %APPDATA%\Code (Windows),
#                plus edition suffixes such as "Code - Insiders" or "VSCodium"
ls -dt "<user-data-dir>/logs"/*/window*/exthost/exthost.log 2>/dev/null | head -3
```

Search the newest file for a subsystem prefix (`[ClaudeSessionWatcher]`, `[Agntree]`) rather
than for the symptom's wording. The Agntree Operations output channel (`logOperation`) holds
destructive actions and refusals.

## 3. Stored chats and worktrees

Agntree keeps everything in one `globalState` entry. Copy the database first so a running
editor cannot lock it and so any WAL content is included:

```bash
DB="<user-data-dir>/globalStorage/state.vscdb"
TMP=$(mktemp -d)
cp "$DB" "$DB"-wal "$DB"-shm "$TMP"/ 2>/dev/null
sqlite3 "$TMP/state.vscdb" \
  "select value from ItemTable where key='subhashkhileri.agntree';" \
| python3 -c '
import json, sys
d = json.load(sys.stdin)
for c in d.get("agntree.chats") or []:
    print({k: c.get(k) for k in (
        "name", "harness", "harnessSessionId", "pendingHarnessSessionId",
        "forkedFromSessionId", "status", "createdAt")})
'
```

The key is `<publisher>.<name>` from `package.json`, so it is the same for every developer.
`getChats()` migrates on read, so the stored shape can be older (`claudeSessionId`); do not
assume a field exists.

| Field | Tells you |
| --- | --- |
| `harnessSessionId` | the linked native session — the transcript or record to look for |
| `pendingHarnessSessionId` | a chosen ID with no linkage yet |
| `forkedFromSessionId` | a terminal fork whose source may have moved or vanished |
| `status` | `active` only while a live terminal is mapped |
| `createdAt` | aligns with transcript mtimes and log lines |

## 4. Harness evidence

- **Claude** — `<profile>/projects/<encoded-cwd>/<session-id>.jsonl`, with the profile at
  `~/.claude` or `CLAUDE_CONFIG_DIR`. The file name is the session ID. Read only what the
  question needs: the tail for turn state, the first message UUIDs to prove fork provenance (a
  fork copies the source's entries and re-stamps `sessionId`), `relocated` / `relocatedCwd`
  for a moved transcript. Claude writes no transcript until the first prompt.
- **Live process state** — `claude agents --json` needs no TTY and reports `status`, `pid`,
  `cwd`, and `startedAt` for running sessions. The same `sessionId` can appear under two PIDs.
- **opencode / Codex** — use `opencode api …` and the Codex app-server; never their databases.

## 5. Terminals

Terminals outlive their mapping and their process. Names are
`Agntree: <chat name> [<first 6 of chat id>]`. A terminal can still be listed in
`window.terminals` with no running process (`exitStatus !== undefined`), so when a row claims
to be open, compare the chat record with the live terminals before blaming linkage.

## 6. Confirm the fix

Correlate three timestamps: the installed bundle's mtime, the log line for the action, and the
native session file's mtime. Then have the user repeat the exact click sequence — a
close/reopen path and a fresh-launch path usually fail for different reasons.
