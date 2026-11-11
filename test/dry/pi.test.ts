/**
 * The Pi adapter and session service against synthetic JSONL records. No Pi
 * install, model turn, or developer profile is involved.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { PiHarness } from '../../src/harnesses/PiHarness';
import { PiSessionService } from '../../src/services/PiSessionService';
import { piEntry, piProfile } from './piFixture';
import { setEnv, stub } from './support';

beforeEach(() => stub.__reset());

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function setup(t: { after(fn: () => void): void }) {
  const profile = piProfile(t);
  const worktree = profile.dir('repo');
  const sub = path.join(worktree, 'pkg');
  fs.mkdirSync(sub, { recursive: true });
  const outside = profile.dir('outside');
  const service = new PiSessionService();
  const harness = new PiHarness({ sessionService: service });
  return { profile, worktree, sub, outside, service, harness };
}

test('discovery keeps sessions in the worktree and its subdirectories, with Pi metadata', async (t) => {
  const { profile, worktree, sub, outside, harness } = setup(t);

  profile.write(
    'named',
    worktree,
    [
      piEntry.modelChange('test-provider', 'test-model', T0),
      piEntry.sessionInfo('Named session', T0 + 1),
      piEntry.user('First prompt', T0 + 2),
      piEntry.assistant('First reply', 'stop', T0 + 3),
    ],
    { at: T0 }
  );
  profile.write('sub', sub, [piEntry.user('Sub prompt', T0 + 10)], {
    at: T0 + 9,
  });
  profile.write('outside', outside, [piEntry.user('Outside', T0 + 20)], {
    at: T0 + 19,
  });
  profile.write(
    'tool',
    worktree,
    [
      piEntry.user('Tool prompt', T0 + 5),
      piEntry.toolUse('bash', T0 + 6),
      piEntry.toolResult('call_1', 'ok', T0 + 7),
    ],
    { at: T0 + 4 }
  );

  const sessions = await harness.listSessionsForWorktree(worktree);
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    ['sub', 'tool', 'named'],
    'newest activity first; outside the worktree is omitted'
  );

  const named = sessions.find((session) => session.sessionId === 'named')!;
  assert.equal(named.summary, 'Named session');
  assert.equal(named.model, 'test-provider/test-model');
  assert.equal(named.messageCount, 2);
  assert.equal(named.turnState, 'done');
  assert.equal(named.turnEndedAt, T0 + 3);

  const subSession = sessions.find((session) => session.sessionId === 'sub')!;
  assert.equal(subSession.summary, 'Sub prompt');
  assert.equal(subSession.turnState, 'working', 'a prompt with no reply is working');

  const tool = sessions.find((session) => session.sessionId === 'tool')!;
  assert.equal(tool.turnState, 'working', 'a tool result means the turn is open');
});

test('metadata and previews come from the user prompts and the last assistant text', async (t) => {
  const { profile, worktree, harness } = setup(t);
  profile.write(
    'meta',
    worktree,
    [
      piEntry.user('First', T0),
      piEntry.assistant('Reply one', 'stop', T0 + 1),
      piEntry.user('Second', T0 + 2),
      piEntry.user('Third', T0 + 3),
      piEntry.user('Fourth', T0 + 4),
      piEntry.assistant('Reply two', 'stop', T0 + 5),
    ],
    { at: T0 - 1 }
  );

  const meta = await harness.getSessionMetadata('meta', worktree);
  assert.deepEqual(meta?.preview.map((message) => message.text), [
    'Second',
    'Third',
    'Fourth',
  ]);
  assert.equal(meta?.lastAsk?.text, 'Fourth');
  assert.equal(meta?.lastReply?.text, 'Reply two');
  assert.equal(meta?.messageCount, 6);
  assert.equal(
    meta?.model,
    'test-provider/test-model',
    'without a model_change, the assistant message names the model'
  );

  assert.deepEqual(
    (await harness.getPreview('meta', 2)).map((message) => message.text),
    ['Third', 'Fourth']
  );
  assert.deepEqual(await harness.getPreview('meta', 0), []);
});

test('the full parser and the tail reader agree at every step of a Pi turn', async (t) => {
  const { profile, worktree, service } = setup(t);
  const file = profile.write('steps', worktree, [piEntry.user('Start', T0)], {
    at: T0,
  });

  const compare = async () => {
    const full = await service.getSessionById('steps', worktree);
    const tail = await service.readTurnState(file);
    assert.deepEqual(tail, {
      turnState: full?.turnState,
      turnEndedAt: full?.turnEndedAt,
    });
    return full;
  };

  assert.equal((await compare())?.turnState, 'working');

  profile.append(file, [piEntry.toolUse('bash', T0 + 10)]);
  assert.equal((await compare())?.turnState, 'working');

  profile.append(file, [piEntry.toolResult('call_1', 'output', T0 + 11)]);
  assert.equal((await compare())?.turnState, 'working');

  profile.append(file, [piEntry.assistant('Done', 'stop', T0 + 12)]);
  const done = await compare();
  assert.equal(done?.turnState, 'done');
  assert.equal(done?.turnEndedAt, T0 + 12);

  profile.append(file, [piEntry.user('Another', T0 + 20)]);
  assert.equal((await compare())?.turnState, 'working');

  profile.append(file, [piEntry.assistant('', 'error', T0 + 21)]);
  const failed = await compare();
  assert.equal(failed?.turnState, 'done', 'an error message still ends the turn');
  assert.equal(failed?.turnEndedAt, T0 + 21);
});

test('launch commands choose the new ID, resume by record path, and fork under a chosen ID', async (t) => {
  const { profile, worktree, sub, harness } = setup(t);
  const source = profile.write('source', worktree, [piEntry.user('Prompt', T0)], {
    at: T0,
  });
  const subSource = profile.write('sub-source', sub, [piEntry.user('Sub', T0)], {
    at: T0,
  });

  assert.equal(harness.buildLaunchCommand({ worktreePath: worktree }), 'pi');
  assert.equal(
    harness.buildLaunchCommand({ worktreePath: worktree, newSessionId: 'new-id' }),
    'pi --session-id new-id'
  );
  assert.equal(
    harness.buildLaunchCommand({ worktreePath: worktree, sessionId: 'source' }),
    `pi --session ${source}`,
    'a resume opens the record, which carries the cwd it was started in'
  );
  assert.equal(
    harness.buildLaunchCommand({ worktreePath: worktree, sessionId: 'sub-source' }),
    `pi --session ${subSource}`,
    'a subdirectory session resumes instead of prompting to fork'
  );
  assert.equal(
    harness.buildLaunchCommand({ worktreePath: worktree, sessionId: 'missing-id' }),
    'pi --session missing-id',
    'a missing record falls back to the ID so Pi reports it'
  );
  assert.equal(
    harness.buildLaunchCommand({
      worktreePath: worktree,
      forkFromSessionId: 'source',
      newSessionId: 'fork-id',
    }),
    'pi --fork source --session-id fork-id'
  );
  assert.throws(
    () =>
      harness.buildLaunchCommand({
        worktreePath: worktree,
        forkFromSessionId: 'source',
      }),
    /chosen new session ID/
  );

  const fork = await harness.forkSession('source', worktree);
  assert.equal(fork.kind, 'terminal');
  assert.match(
    fork.kind === 'terminal' ? fork.pendingSessionId : '',
    /^[0-9a-f-]{36}$/
  );
  await assert.rejects(
    harness.forkSession('missing', worktree),
    /no longer exists/
  );
});

test('resume validation is scoped to the worktree and rejects malformed records', async (t) => {
  const { profile, worktree, outside, harness, service } = setup(t);
  profile.write('local', worktree, [piEntry.user('Prompt', T0)], { at: T0 });
  profile.write('foreign', outside, [piEntry.user('Other', T0)], { at: T0 });

  assert.equal(await harness.isSessionResumable('local', worktree), true);
  assert.equal(await harness.isSessionResumable('local', outside), false);
  assert.equal(await harness.isSessionResumable('foreign', worktree), false);
  assert.equal(await harness.isSessionResumable('missing', worktree), false);

  const dir = profile.sessionDir(worktree);
  fs.writeFileSync(path.join(dir, 'not-a-session.jsonl'), '{"type":"other"}\n');
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  assert.equal(await service.getSessionById('not-a-session'), null);
  assert.equal(await service.getSessionById('empty'), null);
});

test('a sessionDir environment override is discovered and cwd filtering still applies', async (t) => {
  const { profile, worktree, outside, harness } = setup(t);
  const flat = profile.dir('flat-sessions');
  setEnv(t, { PI_CODING_AGENT_SESSION_DIR: flat });

  profile.write('flat-local', worktree, [piEntry.user('Local', T0)], {
    at: T0,
    dir: flat,
  });
  profile.write('flat-foreign', outside, [piEntry.user('Other', T0)], {
    at: T0,
    dir: flat,
  });

  const sessions = await harness.listSessionsForWorktree(worktree);
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    ['flat-local']
  );
  assert.equal(await harness.isSessionResumable('flat-local', worktree), true);
});

test('a project sessionDir setting resolves relative to its worktree', async (t) => {
  const { profile, worktree, harness } = setup(t);
  const relative = 'pi-sessions';
  fs.mkdirSync(path.join(worktree, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, '.pi', 'settings.json'),
    JSON.stringify({ sessionDir: relative })
  );
  profile.write('project-local', worktree, [piEntry.user('Local', T0)], {
    at: T0,
    dir: path.join(worktree, relative),
  });

  const sessions = await harness.listSessionsForWorktree(worktree);
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    ['project-local']
  );
  assert.equal(
    await harness.isSessionResumable('project-local', worktree),
    true
  );
});

test('a worktree sessionDir override still finds subdirectory sessions in the default layout', async (t) => {
  const { profile, worktree, sub, harness } = setup(t);
  const relative = 'pi-sessions';
  fs.mkdirSync(path.join(worktree, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, '.pi', 'settings.json'),
    JSON.stringify({ sessionDir: relative })
  );
  profile.write('project-local', worktree, [piEntry.user('Local', T0)], {
    at: T0,
    dir: path.join(worktree, relative),
  });
  // Pi reads project settings from its process cwd, so one started in the
  // subdirectory ignores the worktree's setting and uses the default layout.
  profile.write('sub-default', sub, [piEntry.user('Sub', T0 + 1)], {
    at: T0 + 1,
  });

  const sessions = await harness.listSessionsForWorktree(worktree);
  assert.deepEqual(
    sessions.map((session) => session.sessionId).sort(),
    ['project-local', 'sub-default']
  );
  assert.equal(await harness.isSessionResumable('sub-default', worktree), true);
});

test('live states read only the requested records and omit unknown sessions', async (t) => {
  const { profile, worktree, harness } = setup(t);
  profile.write(
    'live',
    worktree,
    [piEntry.user('Prompt', T0), piEntry.assistant('Reply', 'stop', T0 + 1)],
    { at: T0 }
  );

  const states = await harness.getLiveStates(['live', 'missing'], worktree);
  assert.deepEqual(states.get('live'), {
    turnState: 'done',
    turnEndedAt: T0 + 1,
  });
  assert.equal(states.has('missing'), false);
});

test('a record rewritten in place, as Pi migrates an older format, is parsed again from its new header', async (t) => {
  const { profile, worktree, service } = setup(t);
  const file = profile.write('migrated', worktree, [piEntry.user('Before', T0)], { at: T0 });
  const [header] = fs.readFileSync(file, 'utf8').split('\n');
  // An older record: the header names version 2 and entries carry no tree ids.
  const legacy = { type: 'message', timestamp: new Date(T0).toISOString(), message: { role: 'user', content: 'Before', timestamp: T0 } };
  fs.writeFileSync(file, `${header.replace('"version":3', '"version":2')}\n${JSON.stringify(legacy)}\n`);
  assert.equal((await service.getSessionById('migrated', worktree))?.summary, 'Before');

  // Pi rewrites the whole file on load, then the conversation continues.
  fs.writeFileSync(
    file,
    [JSON.parse(header), piEntry.user('After migration', T0 + 1), piEntry.assistant('Reply', 'stop', T0 + 2)]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join('')
  );
  const session = await service.getSessionById('migrated', worktree);
  assert.equal(session?.summary, 'After migration');
  assert.equal(session?.messageCount, 2);
  assert.equal(session?.lastReply?.text, 'Reply');
});

test('a truncated trailing line is ignored instead of breaking the session', async (t) => {
  const { profile, worktree, service } = setup(t);
  const file = profile.write(
    'truncated',
    worktree,
    [piEntry.user('Prompt', T0), piEntry.assistant('Reply', 'stop', T0 + 1)],
    { at: T0 }
  );
  fs.appendFileSync(file, '{"type":"message"');

  const session = await service.getSessionById('truncated', worktree);
  assert.equal(session?.turnState, 'done');
  assert.equal(session?.lastReply?.text, 'Reply');
});
