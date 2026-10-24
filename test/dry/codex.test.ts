import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CodexAppServer,
  CodexItemEntry,
  CodexThread,
} from '../../src/services/CodexAppServer';
import { CodexRolloutService } from '../../src/services/CodexRollout';
import { CodexHarness } from '../../src/harnesses/CodexHarness';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function rolloutLine(payload: Record<string, unknown>): string {
  return line({ type: 'event_msg', payload });
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-codex-'));
const ROLLOUT = path.join(ROOT, 'rollout.jsonl');
const nowSeconds = Math.floor(Date.now() / 1000);

fs.writeFileSync(
  ROLLOUT,
  line({ type: 'session_meta', payload: { id: 'thread-1' } }) +
    rolloutLine({ type: 'task_started', turn_id: 'turn-1' }) +
    rolloutLine({
      type: 'item_completed',
      item: { type: 'UserMessage', id: 'u1' },
    }) +
    rolloutLine({
      type: 'item_completed',
      item: { type: 'AgentMessage', id: 'a1' },
    }) +
    rolloutLine({
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1_200,
          output_tokens: 300,
          reasoning_output_tokens: 100,
          cached_input_tokens: 800,
          cache_write_input_tokens: 50,
          total_tokens: 1_500,
        },
      },
    }) +
    rolloutLine({
      type: 'task_complete',
      completed_at: nowSeconds,
      last_agent_message: 'The final answer',
    })
);

const items: CodexItemEntry[] = [
  {
    turnId: 'turn-1',
    item: {
      type: 'agentMessage',
      id: 'a2',
      text: 'The final answer',
      phase: 'final_answer',
    },
    startedAtMs: 5_000,
    completedAtMs: 5_100,
  },
  {
    turnId: 'turn-1',
    item: {
      type: 'userMessage',
      id: 'u3',
      content: [{ type: 'text', text: 'third prompt' }],
    },
    startedAtMs: 4_000,
    completedAtMs: 4_000,
  },
  {
    turnId: 'turn-1',
    item: {
      type: 'agentMessage',
      id: 'a1',
      text: 'Working on it',
      phase: 'commentary',
    },
    startedAtMs: 3_000,
    completedAtMs: 3_100,
  },
  {
    turnId: 'turn-1',
    item: {
      type: 'userMessage',
      id: 'u2',
      content: [{ type: 'text', text: 'second prompt' }],
    },
    startedAtMs: 2_000,
    completedAtMs: 2_000,
  },
  {
    turnId: 'turn-1',
    item: {
      type: 'userMessage',
      id: 'u1',
      content: [{ type: 'text', text: 'first prompt' }],
    },
    startedAtMs: 1_000,
    completedAtMs: 1_000,
  },
];

const threads: CodexThread[] = [
  {
    id: 'thread-1',
    name: 'First thread',
    preview: 'first prompt',
    cwd: '/repo/wt-a',
    model: 'gpt-5-codex',
    createdAt: nowSeconds - 100,
    updatedAt: nowSeconds,
    path: ROLLOUT,
    gitInfo: { branch: 'feature-a' },
  },
  {
    id: 'thread-2',
    name: null,
    preview: 'a prompt from a subdirectory',
    cwd: '/repo/wt-a/sub',
    model: 'gpt-5-codex',
    createdAt: nowSeconds - 200,
    updatedAt: nowSeconds - 10,
    path: null,
    gitInfo: { branch: 'feature-a' },
  },
  {
    id: 'thread-3',
    name: 'Other worktree',
    preview: 'other',
    cwd: '/repo/wt-b',
    createdAt: nowSeconds - 300,
    updatedAt: nowSeconds - 20,
    path: null,
  },
  {
    id: 'thread-subagent',
    name: 'Subagent',
    preview: 'subagent',
    cwd: '/repo/wt-a',
    parentThreadId: 'thread-1',
    createdAt: nowSeconds - 50,
    updatedAt: nowSeconds - 5,
    path: null,
  },
  {
    id: 'thread-ephemeral',
    name: 'Ephemeral',
    preview: 'ephemeral',
    cwd: '/repo/wt-a',
    ephemeral: true,
    createdAt: nowSeconds - 50,
    updatedAt: nowSeconds - 5,
    path: null,
  },
];

const forkCalls: { threadId: string; cwd: string }[] = [];
let disposed = false;
let forkSerial = 0;

const fakeAppServer = {
  listThreads: async () => ({ data: threads, nextCursor: null }),
  readThread: async (threadId: string) => {
    const thread = threads.find((entry) => entry.id === threadId);
    if (!thread) {
      throw new Error('thread not found');
    }
    return { thread };
  },
  listItems: async () => ({ data: items, nextCursor: null }),
  forkThread: async (threadId: string, cwd: string) => {
    forkCalls.push({ threadId, cwd });
    forkSerial += 1;
    return {
      ...threads[0],
      id: `fork-${forkSerial}`,
      cwd,
    };
  },
  deleteThread: async () => undefined,
  dispose: () => {
    disposed = true;
  },
} as unknown as CodexAppServer;

async function main(): Promise<void> {
  const harness = new CodexHarness({
    appServer: fakeAppServer,
    rollouts: new CodexRolloutService(),
  });

  console.log('\n== adapter surface ==');
  check(harness.id === 'codex', 'id is codex');
  check(harness.displayName === 'Codex', 'displayName is Codex');
  check(harness.capabilities.fork, 'fork capability is on');
  check(!harness.capabilities.move, 'move capability is off');
  check(!harness.capabilities.newSessionId, 'chosen session IDs are unsupported');
  check(harness.capabilities.preview === 'inline', 'previews are inline');
  check(Boolean(harness.treeIcons), 'custom tree icons are exposed');

  console.log('\n== launch commands ==');
  check(
    harness.buildLaunchCommand({ worktreePath: '/repo/wt-a' }) === 'codex',
    'new sessions launch codex'
  );
  check(
    harness.buildLaunchCommand({
      worktreePath: '/repo/wt-a',
      sessionId: 'thread-1',
    }) === 'codex resume thread-1 --cd /repo/wt-a',
    'resume uses --cd'
  );
  check(
    harness.buildLaunchCommand({
      worktreePath: '/repo/wt-a',
      forkFromSessionId: 'thread-1',
    }) === 'codex fork thread-1 --cd /repo/wt-a',
    'terminal fork fallback uses codex fork'
  );
  check(
    harness.buildLaunchCommand({
      worktreePath: '/repo/wt a',
      sessionId: 'thread-1',
    }) === "codex resume thread-1 --cd '/repo/wt a'",
    'paths with spaces are quoted'
  );

  console.log('\n== discovery ==');
  const worktreeSessions = await harness.listSessionsForWorktree('/repo/wt-a');
  check(
    worktreeSessions.length === 2,
    `worktree list kept ${worktreeSessions.length} sessions`
  );
  check(
    worktreeSessions.every((session) =>
      session.cwd.startsWith('/repo/wt-a')
    ),
    'worktree list filters by cwd with isWithin'
  );
  check(
    !worktreeSessions.some(
      (session) =>
        session.sessionId === 'thread-subagent' ||
        session.sessionId === 'thread-ephemeral'
    ),
    'subagent and ephemeral threads are excluded'
  );

  const first = worktreeSessions.find(
    (session) => session.sessionId === 'thread-1'
  );
  check(first?.summary === 'First thread', 'thread name is the summary');
  check(first?.gitBranch === 'feature-a', 'git branch is mapped');
  check(first?.turnState === 'done', 'finished turn is reported as done');
  check(
    first?.turnEndedAt === nowSeconds * 1000,
    `turn end is the task_complete timestamp: ${first?.turnEndedAt}`
  );
  check(
    first?.tokens?.input === 1_200 &&
      first?.tokens.output === 300 &&
      first?.tokens.reasoning === 100 &&
      first?.tokens.cacheRead === 800 &&
      first?.tokens.cacheWrite === 50,
    'token usage is mapped from the rollout'
  );
  check(first?.messageCount === 2, 'message count comes from item_completed');

  const second = worktreeSessions.find(
    (session) => session.sessionId === 'thread-2'
  );
  check(
    second?.summary === 'a prompt from a subdirectory',
    'preview is the summary fallback'
  );

  const repoSessions = await harness.listSessionsForRepository('/repo', [
    '/repo/wt-a',
    '/repo/wt-b',
  ]);
  check(
    repoSessions.length === 3,
    `repository list kept ${repoSessions.length} top-level sessions`
  );
  check(
    repoSessions[0]?.sessionId === 'thread-1',
    'repository list is newest-first'
  );

  console.log('\n== metadata + preview ==');
  const metadata = await harness.getSessionMetadata('thread-1');
  check(metadata?.model === 'gpt-5-codex', 'metadata carries the model');
  check(metadata?.preview.length === 3, 'metadata returns the last 3 prompts');
  check(
    metadata?.preview[2]?.text === 'third prompt',
    'preview is oldest-first'
  );
  check(
    metadata?.lastAsk?.text === 'third prompt',
    'lastAsk is the newest prompt'
  );
  check(
    metadata?.lastReply?.text === 'The final answer',
    'lastReply prefers the final answer'
  );
  check(metadata?.messageCount === 2, 'metadata carries the message count');
  check(
    metadata?.tokens?.input === 1_200,
    'metadata carries token usage'
  );
  check(
    (await harness.getSessionMetadata('missing')) === null,
    'missing threads return null metadata'
  );

  const preview = await harness.getPreview('thread-1', 2);
  check(preview.length === 2, 'preview honors maxMessages');
  check(
    preview[0]?.text === 'second prompt' && preview[1]?.text === 'third prompt',
    'preview returns the newest prompts oldest-first'
  );

  console.log('\n== resumability + forks ==');
  check(await harness.isSessionResumable('thread-1'), 'known threads resume');
  check(
    !(await harness.isSessionResumable('missing')),
    'missing threads do not resume'
  );

  const fork = await harness.forkSession('thread-1', '/repo/wt-a');
  check(
    fork.kind === 'linked' && fork.sessionId === 'fork-1',
    'same-worktree fork returns a linked ID'
  );
  check(
    forkCalls[0]?.cwd === '/repo/wt-a',
    'same-worktree fork uses the worktree cwd'
  );

  const moved = await harness.prepareForkToNewWorktree(
    'thread-1',
    '/repo/wt-a',
    '/repo/wt-new'
  );
  check(
    moved.kind === 'linked' && moved.sessionId === 'fork-2',
    'new-worktree fork returns a linked ID'
  );
  check(
    forkCalls[1]?.cwd === '/repo/wt-new',
    'new-worktree fork materializes in the destination'
  );

  let moveRejected = false;
  try {
    await harness.moveSession('thread-1', '/repo/wt-b');
  } catch {
    moveRejected = true;
  }
  check(moveRejected, 'moveSession is rejected');

  console.log('\n== live rollout updates ==');
  const rollouts = new CodexRolloutService();
  const done = await rollouts.read(ROLLOUT);
  check(done?.turnState === 'done', 'initial rollout state is done');

  fs.appendFileSync(
    ROLLOUT,
    rolloutLine({ type: 'task_started', turn_id: 'turn-2' })
  );
  const working = await rollouts.read(ROLLOUT);
  check(working?.turnState === 'working', 'appended task_started flips to working');
  check(working?.turnEndedAt === null, 'working state clears turnEndedAt');

  fs.appendFileSync(
    ROLLOUT,
    rolloutLine({
      type: 'turn_aborted',
      completed_at: nowSeconds + 1,
    })
  );
  const aborted = await rollouts.read(ROLLOUT);
  check(aborted?.turnState === 'done', 'turn_aborted counts as finished');
  check(
    aborted?.turnEndedAt === (nowSeconds + 1) * 1000,
    'turn_aborted timestamp is used'
  );

  harness.dispose();
  check(disposed, 'dispose stops the injected app-server');

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL CODEX HARNESS CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
