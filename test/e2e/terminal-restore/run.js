#!/usr/bin/env node
/**
 * Optional terminal-restore end-to-end test.
 *
 * Launches the installed VS Code with a throwaway profile and this working
 * copy of the extension, drives three chats through quit/reopen/quit/reopen
 * against a fake harness CLI, and checks that every restored tab carries its
 * Agntree title and resumes its own session without the user touching a tab.
 *
 * Nothing outside the temp directory is read or written: the user-data dir,
 * extensions dir, git workspace, and Claude config all live under a fresh temp
 * root, and the fake CLI never calls a real harness.
 *
 * Run with:
 *   npm run test:e2e
 *
 * Environment:
 *   VSCODE_EXECUTABLE       path to VS Code (same resolver as the integration suite)
 *   AGNTREE_E2E_SCENARIO    default | no-shell-integration | custom-tab-title |
 *                           persistent-sessions-off | revive-never
 *   AGNTREE_E2E_ROOT        parent directory for the temp profile; use a path
 *                           without spaces on Windows
 *   AGNTREE_TEST_KEEP=1     keep the temp profile and logs
 */
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveVSCodeExecutable } = require('../../vscodeExecutable');

const TEST_DIR = __dirname;
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');
const DRIVER_DIR = path.join(TEST_DIR, 'driver');
const FAKE_CLI = path.join(TEST_DIR, 'fake-claude.js');
const LAUNCH_TIMEOUT_MS = 180000;

const manifest = require(path.join(REPO_ROOT, 'package.json'));
const EXTENSION_ID = `${manifest.publisher}.${manifest.name}`;

const SCENARIOS = {
  default: { settings: {}, resumes: 3, titles: true },
  'no-shell-integration': {
    settings: { 'terminal.integrated.shellIntegration.enabled': false },
    resumes: 3,
    titles: true,
  },
  'custom-tab-title': {
    settings: { 'terminal.integrated.tabs.title': '${cwdFolder}' },
    resumes: 3,
    titles: true,
  },
  'persistent-sessions-off': {
    settings: { 'terminal.integrated.enablePersistentSessions': false },
    resumes: 0,
    titles: false,
  },
  'revive-never': {
    settings: { 'terminal.integrated.persistentSessionReviveProcess': 'never' },
    resumes: 0,
    titles: false,
  },
};

function skip(reason) {
  console.log(`SKIP  ${reason}`);
  process.exit(0);
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

function shQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function prepareRepo(repoPath) {
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, 'README.md'),
    '# Agntree terminal-restore E2E workspace\n'
  );
  runGit(['init'], repoPath);
  runGit(['add', 'README.md'], repoPath);
  runGit(
    [
      '-c',
      'user.name=Agntree E2E',
      '-c',
      'user.email=e2e@example.invalid',
      'commit',
      '-m',
      'Initial commit',
    ],
    repoPath
  );
}

/**
 * Mirrors GitService.generateWorktreeId for the seeded repository. Keep the
 * hash and seed string in sync with src/services/GitService.ts.
 */
function seededWorktreeId(worktreePath) {
  return `wt-${simpleHash(`e2e-repo:${path.resolve(worktreePath)}`)}`;
}

/**
 * Add one linked worktree per chat. The workspace folder is the repository
 * root, so a resumed tab that forgets to change directory runs there instead
 * of in the chat's worktree.
 */
function prepareWorktrees(repoPath, root) {
  return ['alpha', 'bravo', 'charlie'].map((name) => {
    const worktreePath = path.join(root, `worktree-${name}`);
    runGit(['worktree', 'add', '-b', `e2e-${name}`, worktreePath], repoPath);
    return { id: seededWorktreeId(worktreePath), path: worktreePath };
  });
}

function makeChats(worktrees) {
  return [
    ['aaaaaaaa-0000-4000-8000-000000000001', 'E2E Alpha', 'e2e-session-alpha'],
    ['bbbbbbbb-0000-4000-8000-000000000002', 'E2E Bravo', 'e2e-session-bravo'],
    ['cccccccc-0000-4000-8000-000000000003', 'E2E Charlie', 'e2e-session-charlie'],
  ].map(([id, name, pending], index) => ({
    id,
    worktreeId: worktrees[index].id,
    worktreePath: worktrees[index].path,
    name,
    harness: 'claude',
    harnessSessionId: null,
    pendingHarnessSessionId: pending,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    status: 'idle',
    baseCommit: null,
  }));
}

function sqliteSeeder() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return (dbPath, sql) => {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(sql);
      } finally {
        db.close();
      }
    };
  } catch {
    // Older Node without node:sqlite (or without --experimental-sqlite).
  }

  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return (dbPath, sql) => {
    execFileSync('sqlite3', [dbPath], { input: sql, stdio: ['pipe', 'ignore', 'ignore'] });
  };
}

function seedGlobalState(seeder, dbPath, value) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });

  const escape = (text) => text.replace(/'/g, "''");
  const sql = `CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
INSERT INTO ItemTable (key, value) VALUES ('${escape(EXTENSION_ID)}', '${escape(value)}');`;
  seeder(dbPath, sql);
}

function writeFakeCommand(root, runsPath) {
  if (process.platform === 'win32') {
    const cmdPath = path.join(root, 'fake-claude.cmd');
    fs.writeFileSync(
      cmdPath,
      `@echo off\r\n"${process.execPath}" "${FAKE_CLI}" --e2e-runs "${runsPath}" %*\r\n`
    );
    return cmdPath;
  }

  const shPath = path.join(root, 'fake-claude');
  fs.writeFileSync(
    shPath,
    `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(
      FAKE_CLI
    )} --e2e-runs ${shQuote(runsPath)} "$@"\n`
  );
  fs.chmodSync(shPath, 0o755);
  return shPath;
}

function writeSettings(userDataDir, fakeCommand, scenario) {
  const settings = {
    'agntree.harnessCommands.claude': fakeCommand,
    'terminal.integrated.enablePersistentSessions': true,
    'workbench.startupEditor': 'none',
    'window.restoreWindows': 'none',
    'telemetry.telemetryLevel': 'off',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'update.mode': 'none',
    'workbench.welcomePage.walkthroughs.openOnInstall': false,
    ...scenario.settings,
  };
  fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userDataDir, 'User', 'settings.json'),
    JSON.stringify(settings, null, 2)
  );
}

function stageExtension(extensionsDir) {
  const target = path.join(extensionsDir, 'agntree');
  const outFile = path.join(REPO_ROOT, 'out', 'extension.js');
  if (!fs.existsSync(outFile)) {
    throw new Error(`Missing ${outFile}; run npm run compile first`);
  }

  fs.mkdirSync(path.join(target, 'out'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
    const source = path.join(REPO_ROOT, file);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(target, file));
    }
  }
  fs.copyFileSync(outFile, path.join(target, 'out', 'extension.js'));
  fs.cpSync(path.join(REPO_ROOT, 'resources'), path.join(target, 'resources'), {
    recursive: true,
  });
}

function launch(exe, args, env) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, LAUNCH_TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stderr, error });
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stderr });
    });
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function readLog(file, from) {
  if (!fs.existsSync(file)) {
    return { entries: [], next: from };
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines.slice(from)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ kind: 'error', message: `Unreadable log line: ${line}` });
    }
  }
  return { entries, next: lines.length };
}

function report(entries) {
  let failed = 0;
  for (const entry of entries) {
    if (entry.kind === 'check') {
      if (entry.ok) {
        console.log(`PASS  ${entry.name}`);
      } else {
        failed++;
        const detail = entry.detail ? ` (${entry.detail})` : '';
        console.error(`FAIL  ${entry.name}${detail}`);
      }
    } else if (entry.kind === 'observation') {
      const detail = entry.detail ? `: ${entry.detail}` : '';
      console.log(`INFO  ${entry.name}${detail}`);
    } else if (entry.kind === 'error') {
      failed++;
      console.error(`ERROR ${entry.message}`);
    }
  }
  return failed;
}

async function main() {
  const scenarioName = process.env.AGNTREE_E2E_SCENARIO || 'default';
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(
      `Unknown AGNTREE_E2E_SCENARIO "${scenarioName}". Known: ${Object.keys(
        SCENARIOS
      ).join(', ')}`
    );
  }

  if (
    process.platform === 'linux' &&
    !process.env.DISPLAY &&
    !process.env.WAYLAND_DISPLAY
  ) {
    skip('no display server; this test opens a real VS Code window');
  }
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    skip('git is required to create the throwaway workspace');
  }
  const seeder = sqliteSeeder();
  if (!seeder) {
    skip(
      'seeding the throwaway profile needs node:sqlite (Node 24, or Node 22 with --experimental-sqlite) or the sqlite3 CLI'
    );
  }

  const exe = resolveVSCodeExecutable();
  // VS Code's IPC socket lives inside the user-data dir, and macOS limits a
  // unix socket path to 103 characters. os.tmpdir() is long on macOS, so use
  // /tmp there; the override must also stay short.
  const defaultRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const parent = process.env.AGNTREE_E2E_ROOT
    ? path.resolve(process.env.AGNTREE_E2E_ROOT)
    : defaultRoot;
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(parent, 'agntree-e2e-'))
  );
  if (process.platform === 'win32' && root.includes(' ')) {
    throw new Error(
      'The temp path contains a space. Set AGNTREE_E2E_ROOT to a path without ' +
        'spaces; Windows shell quoting is POSIX-only in the harness launch command.'
    );
  }
  const repoPath = path.join(root, 'repo');
  const userDataDir = path.join(root, 'user-data');
  const extensionsDir = path.join(root, 'extensions');
  const claudeProfile = path.join(root, 'claude-profile');
  const logPath = path.join(root, 'log.jsonl');
  const statePath = path.join(root, 'state.json');
  const runsPath = path.join(root, 'fake-runs.log');
  const keep = process.env.AGNTREE_TEST_KEEP === '1';

  console.log(`VS Code:   ${exe}`);
  console.log(`Scenario:  ${scenarioName}`);
  console.log(`Profile:   ${root}`);

  let failures = 0;
  try {
    fs.mkdirSync(claudeProfile, { recursive: true });
    fs.mkdirSync(path.join(claudeProfile, 'projects'), { recursive: true });

    stageExtension(extensionsDir);

    prepareRepo(repoPath);
    const worktrees = prepareWorktrees(repoPath, root);
    const chats = makeChats(worktrees);
    seedGlobalState(
      seeder,
      path.join(userDataDir, 'User', 'globalStorage', 'state.vscdb'),
      JSON.stringify({
        'agntree.repositories': [
          { id: 'e2e-repo', name: 'e2e-repo', rootPath: repoPath },
        ],
        'agntree.chats': chats,
        'agntree.activeChat': null,
        'agntree.activeWorktreeId': null,
        'agntree.prWorktrees': {},
        'agntree.starredChats': [],
      })
    );

    const fakeCommand = writeFakeCommand(root, runsPath);
    writeSettings(userDataDir, fakeCommand, scenario);
    fs.writeFileSync(statePath, JSON.stringify({ stage: 0 }));

    const env = {
      ...process.env,
      AGNTREE_E2E_OUT: logPath,
      AGNTREE_E2E_STATE: statePath,
      AGNTREE_E2E_CHATS: JSON.stringify(chats),
      AGNTREE_E2E_RUNS: runsPath,
      AGNTREE_E2E_EXPECT_RESUMES: String(scenario.resumes),
      AGNTREE_E2E_EXPECT_TITLES: scenario.titles ? '1' : '0',
      CLAUDE_CONFIG_DIR: claudeProfile,
    };
    const args = [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      `--extensionDevelopmentPath=${DRIVER_DIR}`,
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--new-window',
      repoPath,
    ];

    let logIndex = 0;
    for (let stage = 0; stage < 3; stage++) {
      console.log(`\n== launch ${stage + 1} of 3: stage ${stage} ==`);
      const result = await launch(exe, args, env);
      console.log(`VS Code exited code=${result.code} signal=${result.signal}`);

      const log = readLog(logPath, logIndex);
      logIndex = log.next;
      failures += report(log.entries);

      const state = readJson(statePath);
      if (!state || state.stage !== stage + 1) {
        failures++;
        console.error(
          `FAIL  stage ${stage} did not complete (state: ${JSON.stringify(state)})`
        );
      }
      if (result.error) {
        failures++;
        console.error(`FAIL  could not launch VS Code: ${result.error.message}`);
      }
      if (result.timedOut) {
        failures++;
        console.error(`FAIL  VS Code did not exit within ${LAUNCH_TIMEOUT_MS} ms`);
      }
      if (result.code !== 0) {
        failures++;
        console.error(`FAIL  VS Code exited with code ${result.code}`);
      }

      if (failures > 0) {
        const stderrTail = result.stderr.trim().split('\n').slice(-30).join('\n');
        if (stderrTail) {
          console.error(stderrTail);
        }
        break;
      }
    }

    if (fs.existsSync(runsPath)) {
      const runs = fs.readFileSync(runsPath, 'utf8').trim().split('\n').filter(Boolean);
      console.log(`\nFake harness launches: ${runs.length}`);
    }

    if (failures === 0) {
      console.log('\nTERMINAL RESTORE E2E PASSED');
    } else {
      console.error(`\n${failures} FAILURE(S)`);
      process.exitCode = 1;
    }
  } finally {
    if (keep) {
      console.log(`Kept profile at ${root}`);
    } else {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    }
  }
}

main().catch((error) => {
  console.error('TERMINAL RESTORE E2E FAILED', error);
  process.exit(1);
});
