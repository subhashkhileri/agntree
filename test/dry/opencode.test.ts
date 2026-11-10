/**
 * The opencode adapter against a fake `opencode` CLI (fixtures/fake-opencode.js)
 * at the process boundary. No opencode install, model turn, or real session
 * database is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { OpencodeHarness } from '../../src/harnesses/OpencodeHarness';
import { deriveTurnState, OpencodeSessionService } from '../../src/services/OpencodeSessionService';
import { stub, tempDir } from './support';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-opencode.js');
const posixOnly = { skip: process.platform === 'win32' ? 'the fake CLI is a POSIX shell wrapper' : false };

interface FakeState {
  sessions: object[];
  exports: Record<string, { messages: object[] }>;
  failMove?: boolean;
  serviceDown?: boolean;
  calls: string[][];
}

/** Point the adapter at the fake CLI with this state; returns state accessors. */
function fakeOpencode(t: { after(fn: () => void): void }, state: Omit<FakeState, 'calls'>) {
  const dir = tempDir(t, 'agntree-opencode-');
  const stateFile = path.join(dir, 'state.json');
  const cli = path.join(dir, 'opencode');
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, calls: [] }));
  fs.writeFileSync(cli, `#!/bin/sh\nFAKE_OPENCODE_STATE='${stateFile}' exec '${process.execPath}' '${FIXTURE}' "$@"\n`, { mode: 0o755 });
  stub.__reset();
  stub.__setConfiguration('harnessCommands', { opencode: cli });
  const read = (): FakeState => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return {
    dir,
    read,
    update: (change: Partial<FakeState>) => fs.writeFileSync(stateFile, JSON.stringify({ ...read(), ...change })),
    calls: (operation: string) => read().calls.filter((args) => args.includes(operation)).length,
  };
}

const session = (id: string, directory: string, extra: object = {}) => ({
  id,
  title: id,
  time: { created: 1, updated: 10 },
  location: { directory },
  ...extra,
});

test('discovery follows the API cursor once for concurrent callers and keeps top-level sessions in the worktree', posixOnly, async (t) => {
  const fake = fakeOpencode(t, { sessions: [], exports: {} });
  const worktree = path.join(fake.dir, 'repo');
  fs.mkdirSync(path.join(worktree, 'sub'), { recursive: true });
  fake.update({
    sessions: [
      session('ses_main', worktree),
      session('ses_sub', path.join(worktree, 'sub')),
      session('ses_child', worktree, { parentID: 'ses_main' }),
      session('ses_archived', worktree, { time: { created: 1, updated: 10, archived: 11 } }),
      session('ses_other', fake.dir),
    ],
  });
  const harness = new OpencodeHarness();

  const [first, second] = await Promise.all([harness.listSessionsForWorktree(worktree), harness.listSessionsForWorktree(worktree)]);
  assert.deepEqual(first.map((s) => s.sessionId).sort(), ['ses_main', 'ses_sub']);
  assert.deepEqual(second, first);
  assert.equal(fake.calls('session.list'), 3, 'one pass over three pages, shared by both callers');
});

test('previews come from one export, and metadata only uses an export that is already cached', posixOnly, async (t) => {
  const fake = fakeOpencode(t, { sessions: [], exports: {} });
  fake.update({
    sessions: [
      session('ses_main', fake.dir, {
        time: { created: 1, updated: 10, idle: 10 },
        model: { providerID: 'provider', id: 'model' },
        agent: 'build',
        cost: 0.12,
        tokens: { input: 10, output: 5 },
      }),
    ],
    exports: {
      ses_main: {
        messages: [
          { type: 'user', text: 'First', time: { created: 1 } },
          { type: 'assistant', content: [{ type: 'text', text: 'Reply one' }], time: { created: 2 } },
          { type: 'user', text: '<system-reminder>not a prompt</system-reminder>' },
          { type: 'user', text: 'Second', time: { created: 3 } },
          { type: 'assistant', content: [{ type: 'text', text: 'Reply two' }, { type: 'tool' }], time: { created: 4 } },
        ],
      },
    },
  });
  const harness = new OpencodeHarness();

  const before = await harness.getSessionMetadata('ses_main', fake.dir);
  assert.deepEqual(before?.preview, [], 'metadata never starts an export');
  assert.equal(fake.calls('export'), 0);

  await Promise.all([harness.getPreview('ses_main'), harness.getPreview('ses_main')]);
  assert.equal(fake.calls('export'), 1, 'concurrent previews share one export');
  const meta = await harness.getSessionMetadata('ses_main', fake.dir);
  assert.deepEqual(meta?.preview.map((m) => m.text), ['First', 'Second']);
  assert.equal(meta?.lastReply?.text, 'Reply two');
  assert.equal(meta?.messageCount, 5, 'the count covers every message, shown or not');
  assert.deepEqual([meta?.model, meta?.agent, meta?.cost, meta?.tokens?.output], ['provider/model', 'build', 0.12, 5]);
});

test('a fork into a new worktree is forked, then moved; a failed move deletes the orphan fork', posixOnly, async (t) => {
  const fake = fakeOpencode(t, { sessions: [], exports: {} });
  fake.update({ sessions: [session('ses_main', fake.dir)] });
  const harness = new OpencodeHarness();
  const destination = path.join(fake.dir, 'feature');

  const fork = await harness.prepareForkToNewWorktree('ses_main', fake.dir, destination);
  assert.equal(fork.kind, 'linked');
  const forkId = fork.kind === 'linked' ? fork.sessionId : '';
  assert.deepEqual(fake.read().sessions.find((s: any) => s.id === forkId), {
    ...session(forkId, destination),
    title: 'ses_main (fork)',
  });
  assert.ok(
    harness.buildLaunchCommand({ worktreePath: destination, sessionId: forkId }).endsWith(` --session ${forkId}`),
    'the terminal resumes the fork'
  );

  fake.update({ failMove: true });
  await assert.rejects(harness.prepareForkToNewWorktree('ses_main', fake.dir, destination), /move failed/);
  assert.deepEqual(
    fake.read().sessions.map((s: any) => s.id),
    ['ses_main', forkId],
    'the orphan from the failed move is gone'
  );
});

test('a down background service falls back to a standalone API server', posixOnly, async (t) => {
  const fake = fakeOpencode(t, { sessions: [], exports: {}, serviceDown: true });
  fake.update({ sessions: [session('ses_main', fake.dir)] });
  assert.equal(await new OpencodeHarness().isSessionResumable('ses_main', fake.dir), true);
  assert.ok(fake.read().calls.some((args) => args[1] === '--standalone'));
});

test('cleanup refuses to delete anything that is not a session ID', async () => {
  const service = new OpencodeSessionService();
  await assert.rejects(service.deleteSession('../../etc/passwd', '/tmp'), /not a valid session ID/);
  await assert.rejects(service.deleteSession('', '/tmp'), /not a valid session ID/);
});

test('a session is done once it went idle after its last update', () => {
  assert.deepEqual(deriveTurnState({ created: 1, updated: 10, idle: 10 }), { turnState: 'done', turnEndedAt: 10 });
  assert.equal(deriveTurnState({ created: 1, updated: 20, idle: 10 }).turnState, 'working');
  assert.equal(deriveTurnState({ created: 1, updated: 20 }).turnState, 'working');
});
