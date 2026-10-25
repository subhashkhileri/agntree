const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const OUT = process.env.AGNTREE_E2E_OUT;
const STATE = process.env.AGNTREE_E2E_STATE;
const RUNS = process.env.AGNTREE_E2E_RUNS;
const CHATS = JSON.parse(process.env.AGNTREE_E2E_CHATS);
const EXPECT_RESUMES = Number(process.env.AGNTREE_E2E_EXPECT_RESUMES || 3);
const EXPECT_TITLES = process.env.AGNTREE_E2E_EXPECT_TITLES !== '0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stage = 0;

function log(entry) {
  fs.appendFileSync(OUT, JSON.stringify({ at: Date.now(), stage, ...entry }) + '\n');
}

function check(name, ok, detail) {
  log({ kind: 'check', name, ok: Boolean(ok), detail });
}

function observe(name, detail) {
  log({ kind: 'observation', name, detail });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { stage: 0 };
  }
}

function writeState(next) {
  fs.writeFileSync(STATE, JSON.stringify(next));
}

function readRuns() {
  try {
    return fs
      .readFileSync(RUNS, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { args: line.split(' '), raw: line };
        }
      });
  } catch {
    return [];
  }
}

function runText(run) {
  return Array.isArray(run.args) ? run.args.join(' ') : String(run.raw ?? '');
}

function parseShortId(name) {
  const match = name.match(/\[([a-f0-9]{6})\]$/);
  return match ? match[1] : undefined;
}

function expectedName(chat) {
  return `Agntree: ${chat.name} [${chat.id.substring(0, 6)}]`;
}

async function pidOf(terminal) {
  try {
    return await Promise.race([
      Promise.resolve(terminal.processId),
      sleep(500).then(() => undefined),
    ]);
  } catch {
    return undefined;
  }
}

async function readTerminals() {
  const terminals = [];
  for (const terminal of vscode.window.terminals) {
    terminals.push({
      name: terminal.name,
      pid: await pidOf(terminal),
      exit: terminal.exitStatus ? terminal.exitStatus.code : null,
      active: terminal === vscode.window.activeTerminal,
    });
  }
  return terminals;
}

async function snapshot() {
  const terminals = await readTerminals();
  observe(
    'terminals',
    JSON.stringify({
      active: vscode.window.activeTerminal?.name,
      terminals,
    })
  );
  return terminals;
}

async function waitFor(condition, what, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) {
      return true;
    }
    await sleep(250);
  }
  log({ kind: 'observation', name: 'timeout', detail: what });
  return false;
}

function waitForCommand(id) {
  return waitFor(
    async () => (await vscode.commands.getCommands(true)).includes(id),
    `${id} to be registered`
  );
}

async function isRestored(terminals, expectedRuns, activeName) {
  if (terminals.length !== 3) {
    return false;
  }
  const chatsByShortId = new Map(
    CHATS.map((chat) => [chat.id.substring(0, 6), chat])
  );
  const everyTab = terminals.every((terminal) => {
    const shortId = parseShortId(terminal.name);
    const chat = shortId ? chatsByShortId.get(shortId) : undefined;
    return (
      Boolean(chat) &&
      terminal.name === expectedName(chat) &&
      typeof terminal.pid === 'number' &&
      terminal.exit === null
    );
  });
  return (
    everyTab &&
    readRuns().length >= expectedRuns &&
    vscode.window.activeTerminal?.name === activeName
  );
}

async function openChat(chat) {
  const item = {
    itemType: 'chat',
    label: chat.name,
    collapsibleState: 0,
    data: chat,
  };
  await vscode.commands.executeCommand('agntree.openChat', item);
}

function shortIdsIn(runs) {
  const found = [];
  for (const run of runs) {
    const text = runText(run);
    for (const chat of CHATS) {
      if (text.includes(chat.pendingHarnessSessionId)) {
        found.push(chat.pendingHarnessSessionId);
      }
    }
  }
  return found;
}

function checkRestored(stageIndex, terminals, state) {
  check(`stage ${stageIndex}: three tabs are open`, terminals.length === 3, String(terminals.length));

  const chatsByShortId = new Map(
    CHATS.map((chat) => [chat.id.substring(0, 6), chat])
  );
  for (const terminal of terminals) {
    const shortId = parseShortId(terminal.name);
    const chat = shortId ? chatsByShortId.get(shortId) : undefined;
    check(
      `stage ${stageIndex}: tab ${shortId ?? '?'} carries its Agntree title`,
      Boolean(chat) && terminal.name === expectedName(chat),
      terminal.name
    );
    check(
      `stage ${stageIndex}: tab ${shortId ?? '?'} has a running pty`,
      typeof terminal.pid === 'number' && terminal.exit === null,
      String(terminal.pid)
    );
  }

  check(
    `stage ${stageIndex}: the expected tab is active`,
    vscode.window.activeTerminal?.name === state.activeName,
    vscode.window.activeTerminal?.name
  );

  const runs = readRuns();
  const expectedTotal = 3 + stageIndex * EXPECT_RESUMES;
  check(
    `stage ${stageIndex}: ${expectedTotal} harness launches in total`,
    runs.length === expectedTotal,
    String(runs.length)
  );

  // Stage 0 is the initial launch of every chat; later stages are resumes.
  const expectedCount = stageIndex === 0 ? 3 : EXPECT_RESUMES;
  const start = stageIndex === 0 ? 0 : 3 + (stageIndex - 1) * EXPECT_RESUMES;
  const action = stageIndex === 0 ? 'launched' : 'resumed';
  const attempted = runs.slice(start, start + expectedCount);
  const attemptedIds = shortIdsIn(attempted).sort();
  const expectedIds = CHATS.map((chat) => chat.pendingHarnessSessionId).sort();
  check(
    `stage ${stageIndex}: every tab ${action} its own session`,
    JSON.stringify(attemptedIds) === JSON.stringify(expectedIds),
    attemptedIds.join(', ')
  );

  // The workspace folder is the repository root. A resumed tab starts there
  // unless the restore path changes into the chat's linked worktree first.
  for (const run of attempted) {
    const text = runText(run);
    const chat = CHATS.find((candidate) =>
      text.includes(candidate.pendingHarnessSessionId)
    );
    if (!chat) {
      continue;
    }
    check(
      `stage ${stageIndex}: ${chat.name} ${action} in its worktree`,
      path.resolve(run.cwd || '') === path.resolve(chat.worktreePath),
      run.cwd
    );
  }
}

function checkNoRestore(stageIndex, terminals) {
  observe(
    `stage ${stageIndex}: tabs restored by VS Code`,
    JSON.stringify(terminals.map((terminal) => terminal.name))
  );

  const runs = readRuns();
  check(
    `stage ${stageIndex}: no harness resume was attempted`,
    runs.length === 3,
    `${runs.length} launches`
  );

  const agntreeNamed = terminals.filter((terminal) => parseShortId(terminal.name));
  check(
    `stage ${stageIndex}: no tab claims an Agntree identity`,
    agntreeNamed.length === 0,
    agntreeNamed.map((terminal) => terminal.name).join(', ')
  );
}

async function quit() {
  await sleep(500);
  try {
    await vscode.commands.executeCommand('workbench.action.quit');
  } catch {
    // The window is already shutting down.
  }
}

exports.activate = async function activate() {
  const state = readState();
  stage = state.stage || 0;
  log({ kind: 'observation', name: 'activate', detail: String(stage) });

  try {
    if (stage === 0) {
      const ready = await waitForCommand('agntree.openChat');
      check('stage 0: agntree.openChat is available', ready);
      if (!ready) {
        await quit();
        return;
      }

      for (const chat of CHATS) {
        await openChat(chat);
      }

      const target = { activeName: expectedName(CHATS[CHATS.length - 1]) };
      const settled = await waitFor(
        async () => isRestored(await readTerminals(), 3, target.activeName),
        'the three chats to open'
      );
      const terminals = await snapshot();
      check('stage 0: the three chats settled', settled, String(terminals.length));
      checkRestored(0, terminals, target);

      writeState({
        stage: 1,
        activeName: vscode.window.activeTerminal?.name,
      });
      await quit();
      return;
    }

    if (stage === 1 || stage === 2) {
      if (EXPECT_TITLES) {
        const expectedRuns = 3 + stage * EXPECT_RESUMES;
        const settled = await waitFor(
          async () =>
            isRestored(await readTerminals(), expectedRuns, state.activeName),
          'the restored tabs to resume',
          30000
        );
        const terminals = await snapshot();
        check(
          `stage ${stage}: restored tabs settled`,
          settled,
          String(terminals.length)
        );
        checkRestored(stage, terminals, state);
      } else {
        // A resume that should not happen has no event to poll; give it time
        // to appear before asserting its absence.
        await sleep(5000);
        const terminals = await snapshot();
        checkNoRestore(stage, terminals);
      }

      writeState({
        stage: stage + 1,
        activeName: state.activeName,
      });
      await quit();
      return;
    }

    log({ kind: 'error', message: `unexpected stage ${stage}` });
    await quit();
  } catch (error) {
    log({
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await quit();
  }
};
