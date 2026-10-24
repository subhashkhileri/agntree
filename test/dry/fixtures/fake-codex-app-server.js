#!/usr/bin/env node
/**
 * Minimal fake Codex app-server for dry tests.
 *
 * Speaks newline-delimited JSON-RPC on stdio and implements only the methods
 * CodexAppServer uses, plus test helpers under `test/*`.
 */
const readline = require('readline');

const cwd = process.env.FAKE_CODEX_CWD || process.cwd();
const rollout = process.env.FAKE_CODEX_ROLLOUT || null;
let forkSerial = 0;
let unsubscribeCount = 0;

const threads = [
  {
    id: 'thread-1',
    sessionId: 'thread-1',
    name: 'First thread',
    preview: 'first prompt',
    cwd,
    model: 'gpt-5-codex',
    modelProvider: 'openai',
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100,
    recencyAt: 1_700_000_100,
    path: rollout,
    forkedFromId: null,
    parentThreadId: null,
    ephemeral: false,
    gitInfo: { branch: 'main' },
    status: { type: 'notLoaded' },
  },
  {
    id: 'thread-older',
    sessionId: 'thread-older',
    name: null,
    preview: 'older prompt',
    cwd,
    model: 'gpt-5-codex',
    modelProvider: 'openai',
    createdAt: 1_699_000_000,
    updatedAt: 1_699_000_100,
    recencyAt: 1_699_000_100,
    path: rollout,
    forkedFromId: null,
    parentThreadId: null,
    ephemeral: false,
    gitInfo: null,
    status: { type: 'notLoaded' },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ id, result: value });
}

function error(id, code, message) {
  send({ id, error: { code, message } });
}

function itemEntry(item, startedAtMs, completedAtMs) {
  return {
    turnId: 'turn-1',
    item,
    startedAtMs,
    completedAtMs,
  };
}

const items = [
  itemEntry(
    {
      type: 'agentMessage',
      id: 'msg-2',
      text: 'The final answer',
      phase: 'final_answer',
    },
    3_000,
    3_100
  ),
  itemEntry(
    {
      type: 'userMessage',
      id: 'user-2',
      content: [{ type: 'text', text: 'second prompt', text_elements: [] }],
    },
    2_000,
    2_000
  ),
  itemEntry(
    {
      type: 'agentMessage',
      id: 'msg-1',
      text: 'Working on it',
      phase: 'commentary',
    },
    1_500,
    1_600
  ),
  itemEntry(
    {
      type: 'userMessage',
      id: 'user-1',
      content: [{ type: 'text', text: 'first prompt', text_elements: [] }],
    },
    1_000,
    1_000
  ),
];

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id == null) {
    // `initialized` and other notifications need no response.
    return;
  }

  const { id, method, params } = message;
  switch (method) {
    case 'initialize':
      result(id, {
        userAgent: 'agntree-test/0.0.0 (Test OS) fake',
        codexHome: cwd,
        platformFamily: 'unix',
        platformOs: 'test',
      });
      return;
    case 'thread/list':
      result(id, {
        data: threads,
        nextCursor: null,
      });
      return;
    case 'thread/read': {
      const thread = threads.find((entry) => entry.id === params?.threadId);
      if (!thread) {
        error(id, -32000, 'thread not found');
        return;
      }
      result(id, { thread });
      return;
    }
    case 'thread/items/list':
      result(id, {
        data: items,
      });
      return;
    case 'thread/fork': {
      const source = threads.find(
        (entry) => entry.id === params?.threadId
      );
      if (!source) {
        error(id, -32000, 'thread not found');
        return;
      }
      forkSerial += 1;
      const fork = {
        ...source,
        id: `fork-${forkSerial}`,
        sessionId: `fork-${forkSerial}`,
        name: source.name,
        cwd: params?.cwd || source.cwd,
        path: rollout,
        forkedFromId: source.id,
        createdAt: 1_700_001_000 + forkSerial,
        updatedAt: 1_700_001_000 + forkSerial,
        recencyAt: 1_700_001_000 + forkSerial,
      };
      threads.push(fork);
      result(id, { thread: fork });
      return;
    }
    case 'thread/delete': {
      const index = threads.findIndex(
        (entry) => entry.id === params?.threadId
      );
      if (index >= 0) {
        threads.splice(index, 1);
      }
      result(id, {});
      return;
    }
    case 'thread/unsubscribe':
      unsubscribeCount += 1;
      result(id, { status: 'unsubscribed' });
      return;
    case 'test/unsubscribe-count':
      result(id, { count: unsubscribeCount });
      return;
    case 'test/echo':
      result(id, { params });
      return;
    case 'test/pid':
      result(id, { pid: process.pid });
      return;
    case 'test/error':
      error(id, -32601, 'method not found');
      return;
    case 'test/exit':
      result(id, { ok: true });
      setTimeout(() => process.exit(0), 20);
      return;
    case 'test/hang':
      // Intentionally never responds.
      return;
    default:
      error(id, -32601, `unknown method: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
