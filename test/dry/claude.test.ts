import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { ClaudeAgentsService } from '../../src/services/ClaudeAgentsService';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { claudeProfile, entry } from './claudeFixture';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('a transcript is resumable only once it holds conversation', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const service = new ClaudeSessionService();

  const file = profile.write(SESSION_ID, repo, []);
  assert.equal(await service.isSessionResumable(SESSION_ID), false, 'empty');
  fs.writeFileSync(file, `${JSON.stringify(entry.summary('Only a title'))}\n`);
  assert.equal(await service.isSessionResumable(SESSION_ID), false, 'title only');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests')]);
  assert.equal(await service.isSessionResumable(SESSION_ID), true);
});

test('a session is named by its harness title, then a summary, then its first prompt', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const service = new ClaudeSessionService();
  const summary = async () => (await service.getSessionById(SESSION_ID))?.summary;

  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests'), entry.assistant('done')]);
  assert.equal(await summary(), 'Please fix the tests');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests'), entry.summary('A summary')]);
  assert.equal(await summary(), 'A summary');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests'), entry.aiTitle('Test suite audit'), entry.summary('An older summary')]);
  assert.equal(await summary(), 'Test suite audit');
});

test('names and previews come only from prompts the user typed', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [
    entry.injected('Base directory for this skill: /tmp/skills'),
    entry.user('Fix the flaky login test'),
    entry.compactSummary('This session is being continued from a previous conversation.'),
  ]);
  const harness = new ClaudeHarness();

  const [listed] = await harness.listSessionsForWorktree(repo);
  assert.equal(listed.summary, 'Fix the flaky login test');
  assert.deepEqual((await harness.getPreview(SESSION_ID)).map((m) => m.text), ['Fix the flaky login test']);
});

test('metadata stays lean: activity, the last exchange, and capped previews only', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [
    entry.user('First', '2026-01-01T00:00:00.000Z'),
    entry.assistant('One', 'end_turn', '2026-01-01T00:00:01.000Z'),
    entry.user('Second', '2026-01-01T00:00:02.000Z'),
    entry.assistant('Two', 'end_turn', '2026-01-01T00:00:03.000Z'),
  ]);
  const harness = new ClaudeHarness();

  const meta = await harness.getSessionMetadata(SESSION_ID);
  assert.equal(meta?.lastActivity, Date.parse('2026-01-01T00:00:02.000Z'));
  assert.equal(meta?.lastReply?.text, 'Two');
  assert.deepEqual([meta?.messageCount, meta?.model], [undefined, undefined]);
  assert.deepEqual((await harness.getPreview(SESSION_ID, 1)).map((m) => m.text), ['Second']);

  const [listed] = await harness.listSessionsForWorktree(repo);
  assert.deepEqual([listed.gitBranch, listed.messageCount], [null, 0]);
});

test('launch commands choose, resume, and fork session IDs with quoted values', () => {
  const harness = new ClaudeHarness();
  const launch = (options: object) => harness.buildLaunchCommand({ worktreePath: '/repo', ...options });

  assert.equal(launch({}), 'claude');
  assert.equal(launch({ newSessionId: 'id with space' }), "claude --session-id 'id with space'");
  assert.equal(launch({ sessionId: SESSION_ID }), `claude --resume ${SESSION_ID}`);
  assert.equal(
    launch({ forkFromSessionId: SESSION_ID, newSessionId: 'fork-id' }),
    `claude --resume ${SESSION_ID} --fork-session --session-id fork-id`
  );
  assert.throws(() => launch({ forkFromSessionId: SESSION_ID }), 'a fork without a chosen ID fails visibly');
});

test('forks choose a fresh ID, and a worktree fork validates its source first', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [entry.user('Please fix the tests')]);
  const harness = new ClaudeHarness();

  const same = await harness.forkSession(SESSION_ID);
  const other = await harness.prepareForkToNewWorktree(SESSION_ID, repo, profile.dir('fork-target'));
  assert.ok(same.kind === 'terminal' && UUID.test(same.pendingSessionId));
  assert.ok(other.kind === 'terminal' && UUID.test(other.pendingSessionId));
  assert.notEqual(same.pendingSessionId, other.pendingSessionId);

  await assert.rejects(
    harness.prepareForkToNewWorktree('00000000-0000-0000-0000-000000000000', repo, profile.dir('missing')),
    /no longer exists/
  );
});

test('live states come from the transcript tail plus the waiting reason from claude agents', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  profile.write(SESSION_ID, repo, [entry.user('Go'), entry.assistant('Done', 'end_turn', '2026-01-01T00:00:03.000Z')]);
  let agentCalls = 0;
  const harness = new ClaudeHarness({
    agentsService: new ClaudeAgentsService({
      command: () => 'fake-claude',
      enabled: () => true,
      exec: async () => {
        agentCalls++;
        return JSON.stringify([{ sessionId: SESSION_ID, status: 'waiting', waitingFor: 'permission prompt' }]);
      },
    }),
  });

  const live = await harness.getLiveStates([SESSION_ID, 'missing-id']);
  assert.deepEqual(live.get(SESSION_ID), {
    turnState: 'done',
    turnEndedAt: Date.parse('2026-01-01T00:00:03.000Z'),
    waitingFor: 'permission prompt',
  });
  assert.ok(!live.has('missing-id'), 'a missing transcript is omitted');

  assert.equal((await harness.getLiveStates([])).size, 0);
  assert.equal(agentCalls, 1, 'no session IDs means no agents call');
});

test('a relocated entry moves the session to its new cwd', async (t) => {
  const profile = claudeProfile(t);
  const repo = profile.dir('repo');
  const moved = profile.dir('moved');
  profile.write(SESSION_ID, repo, [entry.user('Go'), { type: 'relocated', relocatedCwd: moved }]);
  assert.equal((await new ClaudeSessionService().getSessionById(SESSION_ID))?.cwd, moved);
});
