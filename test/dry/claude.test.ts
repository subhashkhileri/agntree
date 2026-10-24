import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { ClaudeAgentsService } from '../../src/services/ClaudeAgentsService';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { encodeClaudeProjectPath } from '../../src/utils/paths';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-claude-'));
const CONFIG_DIR = path.join(ROOT, 'config');
const REPO = path.join(ROOT, 'repo');
// Create the directory before encoding it: the encoder realpaths the worktree,
// and an unmade path would encode differently on macOS (/var vs /private/var).
fs.mkdirSync(REPO, { recursive: true });
const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const TRANSCRIPT = path.join(
  CONFIG_DIR,
  'projects',
  encodeClaudeProjectPath(REPO),
  `${SESSION_ID}.jsonl`
);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function userEntry(text: string, timestamp: string): string {
  return json({
    type: 'user',
    timestamp,
    cwd: REPO,
    sessionId: SESSION_ID,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function toolResultEntry(timestamp: string): string {
  return json({
    type: 'user',
    timestamp,
    cwd: REPO,
    sessionId: SESSION_ID,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
    },
  });
}

function assistantEntry(
  stopReason: string,
  timestamp: string,
  options: { toolUse?: boolean; sidechain?: boolean } = {}
): string {
  return json({
    type: 'assistant',
    timestamp,
    cwd: REPO,
    sessionId: SESSION_ID,
    isSidechain: options.sidechain ?? false,
    message: {
      role: 'assistant',
      stop_reason: stopReason,
      content: options.toolUse
        ? [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }]
        : [{ type: 'text', text: 'done' }],
    },
  });
}

function turnDuration(timestamp: string, pending?: number): string {
  return json({
    type: 'system',
    subtype: 'turn_duration',
    timestamp,
    cwd: REPO,
    sessionId: SESSION_ID,
    ...(pending === undefined ? {} : { pendingBackgroundAgentCount: pending }),
  });
}

async function main(): Promise<void> {
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });

  const service = new ClaudeSessionService();
  const harness = new ClaudeHarness();
  const read = async () => (await service.findSessionsForWorktree(REPO))[0];

  try {
    console.log('\n== resume validation ==');
    fs.writeFileSync(TRANSCRIPT, '');
    check(
      !(await service.isSessionResumable(SESSION_ID)),
      'an empty transcript is not resumable'
    );
    fs.writeFileSync(
      TRANSCRIPT,
      json({ type: 'summary', summary: 'Only a title' })
    );
    check(
      !(await service.isSessionResumable(SESSION_ID)),
      'a transcript without conversation is not resumable'
    );

    console.log('\n== discovery + full parser ==');
    fs.writeFileSync(
      TRANSCRIPT,
      userEntry('Please fix the tests', '2026-01-01T00:00:00.000Z')
    );
    let session = await read();
    check(
      session.cwd === REPO &&
        session.hasMessages &&
        session.lastAsk?.text === 'Please fix the tests',
      'the prompt is parsed with its cwd'
    );
    check(session.turnState === 'working', 'a prompt is working');
    check(
      await service.isSessionResumable(SESSION_ID),
      'a prompted transcript is resumable'
    );
    check(
      service.isClaudeInstalled(),
      'isClaudeInstalled() honors CLAUDE_CONFIG_DIR'
    );

    fs.appendFileSync(
      TRANSCRIPT,
      assistantEntry('tool_use', '2026-01-01T00:00:01.000Z', { toolUse: true })
    );
    check((await read()).turnState === 'working', 'a tool_use stop reason is working');

    fs.appendFileSync(
      TRANSCRIPT,
      toolResultEntry('2026-01-01T00:00:02.000Z')
    );
    check((await read()).turnState === 'working', 'a tool result keeps the turn open');

    fs.appendFileSync(
      TRANSCRIPT,
      assistantEntry('end_turn', '2026-01-01T00:00:03.000Z')
    );
    session = await read();
    check(
      session.turnState === 'done' &&
        session.turnEndedAt === Date.parse('2026-01-01T00:00:03.000Z'),
      'an end_turn is done at its timestamp'
    );
    check(session.lastReply?.text === 'done', 'the last assistant text is captured');
    check(
      session.summary === 'Please fix the tests',
      'summary falls back to the first prompt'
    );

    fs.appendFileSync(
      TRANSCRIPT,
      userEntry('Next question', '2026-01-01T00:00:04.000Z')
    );
    check((await read()).turnState === 'working', 'a new prompt reopens the turn');

    fs.appendFileSync(
      TRANSCRIPT,
      assistantEntry('end_turn', '2026-01-01T00:00:05.000Z', {
        sidechain: true,
      })
    );
    check(
      (await read()).turnState === 'working',
      'a sidechain entry does not end the main turn'
    );

    fs.appendFileSync(
      TRANSCRIPT,
      assistantEntry('end_turn', '2026-01-01T00:00:06.000Z')
    );
    fs.appendFileSync(
      TRANSCRIPT,
      turnDuration('2026-01-01T00:00:06.000Z', 1)
    );
    check(
      (await read()).turnState === 'working',
      'a pending background agent keeps the turn open'
    );

    fs.appendFileSync(
      TRANSCRIPT,
      turnDuration('2026-01-01T00:00:07.000Z')
    );
    check(
      (await read()).turnState === 'done',
      'a turn_duration without a count clears the agents'
    );

    const byId = await service.getSessionById(SESSION_ID);
    check(
      byId?.sessionId === SESSION_ID && byId.cwd === REPO,
      'getSessionById resolves the transcript'
    );
    const preview = await service.getSessionPreview(SESSION_ID, 2);
    check(
      preview.length === 2 && preview[1].text === 'Next question',
      'getSessionPreview returns the newest prompts'
    );
    check(
      (await service.findSessionsForRepository(REPO, [])).length === 1,
      'findSessionsForRepository includes the worktree session'
    );

    console.log('\n== adapter commands ==');
    check(
      harness.buildLaunchCommand({ worktreePath: REPO }) === 'claude',
      'no IDs launches a plain new session'
    );
    check(
      harness.buildLaunchCommand({
        worktreePath: REPO,
        newSessionId: 'chosen-new-id',
      }) === 'claude --session-id chosen-new-id',
      'a chosen new-session ID uses --session-id'
    );
    check(
      harness.buildLaunchCommand({
        worktreePath: REPO,
        newSessionId: 'id with space',
      }) === "claude --session-id 'id with space'",
      'session IDs are shell-quoted'
    );
    check(
      harness.buildLaunchCommand({
        worktreePath: REPO,
        sessionId: SESSION_ID,
      }) === `claude --resume ${SESSION_ID}`,
      'resume command uses --resume'
    );
    check(
      harness.buildLaunchCommand({
        worktreePath: REPO,
        forkFromSessionId: SESSION_ID,
        newSessionId: 'chosen-fork-id',
      }) ===
        `claude --resume ${SESSION_ID} --fork-session --session-id chosen-fork-id`,
      'fork command uses --fork-session and the chosen ID'
    );

    let missingForkIdThrew = false;
    try {
      harness.buildLaunchCommand({
        worktreePath: REPO,
        forkFromSessionId: SESSION_ID,
      });
    } catch {
      missingForkIdThrew = true;
    }
    check(missingForkIdThrew, 'a fork without a chosen ID fails visibly');
    check(
      harness.capabilities.fork &&
        !harness.capabilities.move &&
        harness.capabilities.newSessionId,
      'Claude capabilities are fork/new ID without move'
    );

    console.log('\n== lean metadata ==');
    const metadata = await harness.getSessionMetadata(SESSION_ID);
    check(
      metadata?.lastActivity === Date.parse('2026-01-01T00:00:04.000Z'),
      'metadata keeps the last activity'
    );
    check(
      metadata?.messageCount === undefined &&
        metadata?.model === undefined &&
        metadata?.tokens === undefined,
      'metadata omits message count, model, and tokens'
    );
    check(
      (await harness.getPreview(SESSION_ID, 2)).length === 2,
      'adapter getPreview is capped'
    );

    const adapterSessions = await harness.listSessionsForWorktree(REPO);
    check(adapterSessions.length === 1, 'adapter discovery returns the session');
    const lean = adapterSessions[0];
    check(
      lean.gitBranch === null &&
        lean.messageCount === 0 &&
        lean.model === undefined &&
        lean.tokens === undefined,
      'adapter sessions are lean'
    );

    console.log('\n== forks choose IDs ==');
    const fork = await harness.forkSession(SESSION_ID);
    check(
      fork.kind === 'terminal' && UUID.test(fork.pendingSessionId),
      `same-worktree fork chooses a pending ID (${fork.kind === 'terminal' ? fork.pendingSessionId : '-'})`
    );
    const prepared = await harness.prepareForkToNewWorktree(
      SESSION_ID,
      REPO,
      path.join(ROOT, 'fork-target')
    );
    check(
      prepared.kind === 'terminal' && UUID.test(prepared.pendingSessionId),
      `worktree fork chooses a pending ID (${prepared.kind === 'terminal' ? prepared.pendingSessionId : '-'})`
    );
    check(
      fork.kind === 'terminal' &&
        prepared.kind === 'terminal' &&
        fork.pendingSessionId !== prepared.pendingSessionId,
      'each fork chooses a distinct ID'
    );

    let missingSourceThrew = false;
    try {
      await harness.prepareForkToNewWorktree(
        '00000000-0000-0000-0000-000000000000',
        REPO,
        path.join(ROOT, 'missing-fork-target')
      );
    } catch (error) {
      missingSourceThrew = String(error).includes('no longer exists');
    }
    check(missingSourceThrew, 'a worktree fork validates its source session');

    console.log('\n== live states ==');
    const liveHarness = new ClaudeHarness({
      agentsService: new ClaudeAgentsService({
        command: () => 'fake-claude',
        enabled: () => true,
        exec: async () =>
          JSON.stringify([
            {
              sessionId: SESSION_ID,
              status: 'waiting',
              waitingFor: 'permission prompt',
            },
          ]),
      }),
    });
    const live = await liveHarness.getLiveStates([SESSION_ID, 'missing-id']);
    check(
      live.get(SESSION_ID)?.turnState === 'done',
      'live state reads the transcript tail'
    );
    check(
      live.get(SESSION_ID)?.waitingFor === 'permission prompt',
      'the waiting reason is merged from agents --json'
    );
    check(!live.has('missing-id'), 'missing transcripts are omitted');
    check(
      (await liveHarness.getLiveStates([])).size === 0,
      'no session IDs means no agents call and an empty map'
    );

    console.log('\n== relocation ==');
    const relocatedCwd = path.join(ROOT, 'moved-worktree');
    fs.appendFileSync(
      TRANSCRIPT,
      json({
        type: 'relocated',
        relocatedCwd,
        timestamp: '2026-01-01T00:00:08.000Z',
      })
    );
    check(
      (await service.getSessionById(SESSION_ID))?.cwd === relocatedCwd,
      'a relocated entry updates the session cwd'
    );
  } finally {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
