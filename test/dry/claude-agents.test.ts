import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeAgentsService, parseClaudeAgents } from '../../src/services/ClaudeAgentsService';

const fixture = () => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-agents.json'), 'utf8');
const parse = (rows: object[]) => parseClaudeAgents(JSON.stringify(rows));

test('parsing keeps the raw waiting reason, fills a missing one, and drops unusable fields and rows', () => {
  const states = parseClaudeAgents(fixture());
  assert.deepEqual(
    [...states].map(([id, state]) => [id.slice(0, 2), state.waitingFor]),
    [['11', undefined], ['22', 'permission prompt'], ['33', undefined]]
  );
  assert.equal(parse([{ sessionId: 's1', status: 'waiting' }]).get('s1')?.waitingFor, 'input needed');
  assert.equal(parse([{ sessionId: 's2', status: 'busy', pid: 'not-a-number' }]).get('s2')?.startedAt, undefined);
  assert.equal(parse([{ status: 'busy' }]).size, 0, 'a row without a session ID is skipped');
});

test('one session under two PIDs merges deterministically: waiting wins, else the newest start', () => {
  const waiting = parse([
    { sessionId: 'dup', status: 'busy', startedAt: 10, pid: 1 },
    { sessionId: 'dup', status: 'waiting', waitingFor: 'permission prompt', startedAt: 5, pid: 2 },
  ]);
  assert.equal(waiting.get('dup')?.waitingFor, 'permission prompt');
  const newest = parse([
    { sessionId: 'dup', status: 'idle', startedAt: 5 },
    { sessionId: 'dup', status: 'busy', startedAt: 10 },
  ]);
  assert.equal(newest.get('dup')?.startedAt, 10);
});

test('empty output is no sessions; malformed or non-array output throws', () => {
  assert.equal(parseClaudeAgents('').size, 0);
  assert.throws(() => parseClaudeAgents('{not json'));
  assert.throws(() => parseClaudeAgents('{"sessions":[]}'));
});

test('the service runs agents --json in the profile, caches for 10s, and shares an in-flight call', async () => {
  const calls: { args: string; env?: NodeJS.ProcessEnv; shell?: unknown }[] = [];
  let now = 0;
  let release: (output: string) => void = () => undefined;
  const service = new ClaudeAgentsService({
    command: () => 'fake-claude',
    enabled: () => true,
    now: () => now,
    env: { CLAUDE_CONFIG_DIR: '/tmp/claude-profile' },
    exec: (_command, args, options) => {
      calls.push({ args: args.join(' '), env: options.env, shell: options.shell });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });

  const first = service.getStates();
  const second = service.getStates();
  release(fixture());
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1, 'concurrent callers share one process');
  assert.equal(a, b);
  assert.equal(calls[0].args, 'agents --json');
  assert.equal(calls[0].env?.CLAUDE_CONFIG_DIR, '/tmp/claude-profile');
  assert.equal(calls[0].shell, process.platform === 'win32', 'the Windows .cmd shim needs a shell');

  await service.getStates();
  assert.equal(calls.length, 1, 'cached within 10s');
  now = 10_001;
  const refreshed = service.getStates();
  release(fixture());
  await refreshed;
  assert.equal(calls.length, 2, 'the cache expires');
});

test('a disabled setting never spawns; a failure or malformed output stops further calls', async () => {
  for (const [label, enabled, exec] of [
    ['disabled', false, async () => fixture()],
    ['failing', true, async () => { throw new Error('CLI failed'); }],
    ['malformed', true, async () => '{not json'],
  ] as const) {
    let spawns = 0;
    const service = new ClaudeAgentsService({
      command: () => 'fake-claude',
      enabled: () => enabled,
      exec: async () => {
        spawns++;
        return exec();
      },
    });
    assert.equal((await service.getStates()).size, 0, label);
    assert.equal((await service.getStates()).size, 0, label);
    assert.equal(spawns, enabled ? 1 : 0, `${label}: not retried on every tick`);
  }
});
