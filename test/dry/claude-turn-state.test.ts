import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { readTurnStateTail } from '../../src/services/ClaudeTurnState';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { encodeClaudeProjectPath } from '../../src/utils/paths';
import { tempDir } from './support';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
/** The cwd Claude records on each entry; discovery maps sessions by it. */
let cwd = '/repo';
const line = (value: object) => `${JSON.stringify({ cwd, sessionId: SESSION_ID, ...value })}\n`;
const at = (second: number) => `2026-01-01T00:00:0${second}.000Z`;
const user = (second: number, content: unknown = [{ type: 'text', text: 'Please fix the tests' }]) =>
  line({ type: 'user', timestamp: at(second), message: { role: 'user', content } });
const assistant = (second: number, stopReason: string | null, options: { sidechain?: boolean; text?: string } = {}) =>
  line({
    type: 'assistant',
    timestamp: at(second),
    isSidechain: options.sidechain ?? false,
    message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text: options.text ?? 'done' }] },
  });
const turnDuration = (second: number, pending?: number) =>
  line({
    type: 'system',
    subtype: 'turn_duration',
    timestamp: at(second),
    ...(pending === undefined ? {} : { pendingBackgroundAgentCount: pending }),
  });

test('every step of a turn reads the same through the tail reader and the full parser', async (t) => {
  const root = tempDir(t, 'agntree-claude-turn-');
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  cwd = repo;
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, 'config');
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  const transcript = path.join(root, 'config', 'projects', encodeClaudeProjectPath(repo), `${SESSION_ID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  const service = new ClaudeSessionService();

  const steps: [string, string, 'working' | 'done', number | null][] = [
    ['a prompt opens the turn', user(0), 'working', null],
    ['a tool_use reply keeps it open', assistant(1, 'tool_use'), 'working', null],
    ['a tool result keeps it open', user(2, [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]), 'working', null],
    ['end_turn finishes it at its timestamp', assistant(3, 'end_turn'), 'done', Date.parse(at(3))],
    ['a pending background agent reopens it', turnDuration(3, 1), 'working', null],
    ['turn_duration without a count clears the agents', turnDuration(4), 'done', Date.parse(at(3))],
    ['a new prompt opens the next turn', user(5), 'working', null],
    ['a sidechain reply does not end the main turn', assistant(6, 'end_turn', { sidechain: true }), 'working', null],
    ['a still-streaming reply is not an end', assistant(7, null), 'working', null],
  ];

  for (const [step, entry, turnState, turnEndedAt] of steps) {
    fs.appendFileSync(transcript, entry);
    const tail = await readTurnStateTail(transcript);
    const [parsed] = await service.findSessionsForWorktree(repo);
    assert.deepEqual(tail, { turnState, turnEndedAt }, `tail: ${step}`);
    assert.deepEqual({ turnState: parsed.turnState, turnEndedAt: parsed.turnEndedAt ?? null }, { turnState, turnEndedAt }, `parser: ${step}`);
  }
});

test('the tail reader skips a partial last line and widens its window until the turn is decided', async (t) => {
  const dir = tempDir(t, 'agntree-claude-tail-');
  let serial = 0;
  const read = (content: string) => {
    const file = path.join(dir, `${++serial}.jsonl`);
    fs.writeFileSync(file, content);
    return readTurnStateTail(file);
  };

  assert.deepEqual(await read(''), { turnState: 'working', turnEndedAt: null });
  assert.equal(await readTurnStateTail(path.join(dir, 'missing.jsonl')), null);
  assert.equal(
    (await read(`${user(0)}{"type":"assistant","message":`))?.turnState,
    'working',
    'a line still being written is not a fact'
  );
  assert.deepEqual(
    await read(user(0) + assistant(2, 'end_turn') + turnDuration(2, 0) + assistant(3, 'end_turn', { text: 'x'.repeat(300 * 1024) })),
    { turnState: 'done', turnEndedAt: Date.parse(at(3)) },
    'a trailing line larger than the window is read whole'
  );
  assert.deepEqual(
    await read(assistant(4, 'end_turn') + line({ type: 'system', subtype: 'note', padding: 'y'.repeat(5 * 1024 * 1024) })),
    { turnState: 'done', turnEndedAt: Date.parse(at(4)) },
    'the reader reaches the file start when the deciding entry is there'
  );
});
