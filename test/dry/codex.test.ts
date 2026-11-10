/**
 * The Codex adapter with an injected fake app-server and synthetic rollout
 * files. No Codex CLI is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { CodexAppServer, CodexItemEntry, CodexThread } from '../../src/services/CodexAppServer';
import { CodexRolloutService } from '../../src/services/CodexRollout';
import { CodexHarness } from '../../src/harnesses/CodexHarness';
import { tempDir } from './support';

const NOW = Math.floor(Date.now() / 1000);
const event = (payload: object) => `${JSON.stringify({ type: 'event_msg', payload })}\n`;

function writeRollout(dir: string): string {
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } })}\n` +
      event({ type: 'task_started', turn_id: 'turn-1' }) +
      event({ type: 'item_completed', item: { type: 'UserMessage', id: 'u1' } }) +
      event({ type: 'item_completed', item: { type: 'AgentMessage', id: 'a1' } }) +
      event({
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1_200,
            output_tokens: 300,
            reasoning_output_tokens: 100,
            cached_input_tokens: 800,
            cache_write_input_tokens: 50,
          },
        },
      }) +
      event({ type: 'task_complete', completed_at: NOW, last_agent_message: 'The final answer' })
  );
  return file;
}

const prompt = (id: string, text: string, at: number): CodexItemEntry => ({
  turnId: 'turn-1',
  item: { type: 'userMessage', id, content: [{ type: 'text', text }] },
  startedAtMs: at,
  completedAtMs: at,
});
const reply = (id: string, text: string, phase: 'commentary' | 'final_answer', at: number): CodexItemEntry => ({
  turnId: 'turn-1',
  item: { type: 'agentMessage', id, text, phase },
  startedAtMs: at,
  completedAtMs: at,
});

function setup(t: { after(fn: () => void): void }) {
  const rollout = writeRollout(tempDir(t, 'agntree-codex-'));
  const thread = (id: string, cwd: string, updatedAgo: number, extra: Partial<CodexThread> = {}): CodexThread => ({
    id,
    name: id,
    preview: `${id} prompt`,
    cwd,
    createdAt: NOW - 500,
    updatedAt: NOW - updatedAgo,
    path: null,
    ...extra,
  });
  const threads = [
    thread('thread-1', '/repo/wt-a', 0, { model: 'gpt-5-codex', path: rollout, gitInfo: { branch: 'feature-a' } }),
    thread('thread-2', '/repo/wt-a/sub', 10, { name: null }),
    thread('thread-3', '/repo/wt-b', 20),
    thread('thread-subagent', '/repo/wt-a', 5, { parentThreadId: 'thread-1' }),
    thread('thread-ephemeral', '/repo/wt-a', 5, { ephemeral: true }),
  ];
  const forks: { threadId: string; cwd: string }[] = [];
  let disposed = false;
  const appServer = {
    listThreads: async () => ({ data: threads, nextCursor: null }),
    readThread: async (threadId: string) => {
      const found = threads.find((entry) => entry.id === threadId);
      if (!found) throw new Error('thread not found');
      return { thread: found };
    },
    // Newest first, as the client requests.
    listItems: async () => ({
      data: [
        reply('a2', 'The final answer', 'final_answer', 5_000),
        prompt('u3', 'third prompt', 4_000),
        reply('a1', 'Working on it', 'commentary', 3_000),
        prompt('u2', 'second prompt', 2_000),
        prompt('u1', 'first prompt', 1_000),
      ],
      nextCursor: null,
    }),
    forkThread: async (threadId: string, cwd: string) => {
      forks.push({ threadId, cwd });
      return { ...threads[0], id: `fork-${forks.length}`, cwd };
    },
    dispose: () => {
      disposed = true;
    },
  } as unknown as CodexAppServer;
  const harness = new CodexHarness({ appServer, rollouts: new CodexRolloutService() });
  return { harness, rollout, forks, disposed: () => disposed };
}

test('resume and fork run in the worktree through a quoted --cd', () => {
  const harness = new CodexHarness();
  assert.equal(harness.buildLaunchCommand({ worktreePath: '/repo/wt-a' }), 'codex');
  assert.equal(harness.buildLaunchCommand({ worktreePath: '/repo/wt a', sessionId: 'thread-1' }), "codex resume thread-1 --cd '/repo/wt a'");
  assert.equal(harness.buildLaunchCommand({ worktreePath: '/repo/wt-a', forkFromSessionId: 'thread-1' }), 'codex fork thread-1 --cd /repo/wt-a');
  harness.dispose();
});

test('discovery keeps top-level threads under the worktree with their rollout state', async (t) => {
  const { harness } = setup(t);
  const sessions = await harness.listSessionsForWorktree('/repo/wt-a');
  assert.deepEqual(sessions.map((s) => s.sessionId).sort(), ['thread-1', 'thread-2'], 'subagents and ephemeral threads are hidden');
  const [first] = sessions.filter((s) => s.sessionId === 'thread-1');
  assert.equal(first.summary, 'thread-1');
  assert.equal(sessions.find((s) => s.sessionId === 'thread-2')?.summary, 'thread-2 prompt', 'an unnamed thread uses its first prompt');
  assert.deepEqual([first.gitBranch, first.turnState, first.turnEndedAt, first.messageCount], ['feature-a', 'done', NOW * 1000, 2]);
  assert.deepEqual(first.tokens, { input: 1_200, output: 300, reasoning: 100, cacheRead: 800, cacheWrite: 50 });

  const repo = await harness.listSessionsForRepository('/repo', ['/repo/wt-a', '/repo/wt-b']);
  assert.deepEqual(repo.map((s) => s.sessionId), ['thread-1', 'thread-2', 'thread-3'], 'newest first');
});

test('previews come from thread items, oldest first, with the final answer as the reply', async (t) => {
  const { harness } = setup(t);
  const meta = await harness.getSessionMetadata('thread-1');
  assert.deepEqual(meta?.preview.map((m) => m.text), ['first prompt', 'second prompt', 'third prompt']);
  assert.equal(meta?.lastReply?.text, 'The final answer', 'commentary is not a reply');
  assert.deepEqual([meta?.model, meta?.messageCount, meta?.tokens?.input], ['gpt-5-codex', 2, 1_200]);
  assert.deepEqual((await harness.getPreview('thread-1', 2)).map((m) => m.text), ['second prompt', 'third prompt']);

  assert.equal(await harness.getSessionMetadata('missing'), null);
  assert.equal(await harness.isSessionResumable('missing'), false);
});

test('forks are created by the app-server in the target cwd; dispose stops the server', async (t) => {
  const { harness, forks, disposed } = setup(t);
  assert.deepEqual(await harness.forkSession('thread-1', '/repo/wt-a'), { kind: 'linked', sessionId: 'fork-1' });
  assert.deepEqual(await harness.prepareForkToNewWorktree('thread-1', '/repo/wt-a', '/repo/wt-new'), { kind: 'linked', sessionId: 'fork-2' });
  assert.deepEqual(forks.map((fork) => fork.cwd), ['/repo/wt-a', '/repo/wt-new']);
  harness.dispose();
  assert.ok(disposed());
});

test('the rollout reader follows appended turns: started is working, aborted is done at its time', async (t) => {
  const { rollout } = setup(t);
  const rollouts = new CodexRolloutService();
  assert.equal((await rollouts.read(rollout))?.turnState, 'done');
  fs.appendFileSync(rollout, event({ type: 'task_started', turn_id: 'turn-2' }));
  assert.deepEqual(
    [(await rollouts.read(rollout))?.turnState, (await rollouts.read(rollout))?.turnEndedAt],
    ['working', null]
  );
  fs.appendFileSync(rollout, event({ type: 'turn_aborted', completed_at: NOW + 1 }));
  const aborted = await rollouts.read(rollout);
  assert.deepEqual([aborted?.turnState, aborted?.turnEndedAt], ['done', (NOW + 1) * 1000]);
});
