import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { deriveTurnState } from '../../src/services/OpencodeSessionService';
import {
  applyAttentionHooks,
  attentionHooksInstalled,
  hasAttentionHooks,
  mergeAttentionHooks,
  removeAttentionHooks,
  revertAttentionHooks,
} from '../../src/services/ClaudeAttentionHooks';
import { ATTENTION_HOOK_COMMAND } from '../../src/services/attentionLog';
import { parseAttentionLines } from '../../src/services/SessionAttentionService';
import { escapeAppleScript } from '../../src/services/NotificationService';
import { encodeClaudeProjectPath } from '../../src/utils/paths';

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
  return JSON.stringify(value);
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/* ------------------------------------------------------------------ */
/* Claude transcript turn state                                        */
/* ------------------------------------------------------------------ */

function userEntry(text: string, timestamp: string, cwd: string): string {
  return json({
    type: 'user',
    timestamp,
    cwd,
    sessionId: 'session-1',
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function toolResultEntry(timestamp: string, cwd: string): string {
  return json({
    type: 'user',
    timestamp,
    cwd,
    sessionId: 'session-1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
    },
  });
}

function assistantEntry(
  timestamp: string,
  cwd: string,
  stopReason: string | null,
  blockType: 'text' | 'tool_use' = 'text'
): string {
  return json({
    type: 'assistant',
    timestamp,
    cwd,
    sessionId: 'session-1',
    message: {
      role: 'assistant',
      stop_reason: stopReason,
      content:
        blockType === 'text'
          ? [{ type: 'text', text: 'done' }]
          : [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: {} }],
    },
  });
}

function asyncAgentResultEntry(
  timestamp: string,
  cwd: string,
  toolUseId: string,
  agentId: string
): string {
  return json({
    type: 'user',
    timestamp,
    cwd,
    sessionId: 'session-1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content:
            'Async agent launched successfully.\n' +
            `agentId: ${agentId} (internal ID - do not mention to user.)\n` +
            'The agent is working in the background.',
        },
      ],
    },
  });
}

function taskNotificationEntry(
  timestamp: string,
  cwd: string,
  agentIds: string[],
  status = 'completed'
): string {
  return userEntry(
    '<task-notification>\n' +
      agentIds.map((id) => `<task-id>${id}</task-id>`).join('\n') +
      `\n<status>${status}</status>\n</task-notification>`,
    timestamp,
    cwd
  );
}

function turnDurationEntry(
  timestamp: string,
  cwd: string,
  pendingAgents?: number
): string {
  return json({
    type: 'system',
    subtype: 'turn_duration',
    timestamp,
    cwd,
    sessionId: 'session-1',
    durationMs: 1200,
    ...(pendingAgents === undefined
      ? {}
      : { pendingBackgroundAgentCount: pendingAgents }),
  });
}

async function testClaudeTurnState(): Promise<void> {
  const originalHome = process.env.HOME;
  const home = tempDir('agntree-attention-home-');
  process.env.HOME = home;

  try {
    const repoPath = path.join(home, 'repo');
    fs.mkdirSync(repoPath, { recursive: true });
    const projectDir = path.join(
      home,
      '.claude',
      'projects',
      encodeClaudeProjectPath(repoPath)
    );
    fs.mkdirSync(projectDir, { recursive: true });
    const transcript = path.join(projectDir, 'session-1.jsonl');

    const service = new ClaudeSessionService();
    const read = async () => {
      const sessions = await service.findSessionsForWorktree(repoPath);
      return sessions[0];
    };

    fs.writeFileSync(
      transcript,
      `${userEntry('Please fix the tests', '2026-01-01T00:00:00.000Z', repoPath)}\n`
    );
    let session = await read();
    check(session?.turnState === 'working', 'a new prompt is working');
    check(session?.turnEndedAt === null, 'no turn end while working');

    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:01.000Z', repoPath, 'tool_use', 'tool_use')}\n`
    );
    session = await read();
    check(session?.turnState === 'working', 'a tool_use stop reason is working');

    fs.appendFileSync(
      transcript,
      `${toolResultEntry('2026-01-01T00:00:02.000Z', repoPath)}\n`
    );
    session = await read();
    check(session?.turnState === 'working', 'a tool result keeps the turn open');

    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:03.000Z', repoPath, 'end_turn')}\n`
    );
    session = await read();
    check(session?.turnState === 'done', 'an end_turn stop reason is done');
    check(
      session?.turnEndedAt === Date.parse('2026-01-01T00:00:03.000Z'),
      `turnEndedAt records the end (${session?.turnEndedAt})`
    );

    fs.appendFileSync(
      transcript,
      `${userEntry('Next question', '2026-01-01T00:00:04.000Z', repoPath)}\n`
    );
    session = await read();
    check(session?.turnState === 'working', 'a new prompt reopens the turn');

    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:05.000Z', repoPath, 'max_tokens')}\n`
    );
    session = await read();
    check(session?.turnState === 'done', 'max_tokens also ends the turn');

    // A background agent outlives the parent turn: `end_turn` while one runs
    // is still working, and the task notification closes it.
    fs.appendFileSync(
      transcript,
      `${asyncAgentResultEntry(
        '2026-01-01T00:00:06.000Z',
        repoPath,
        'tool-agent',
        'agent-1'
      )}\n`
    );
    session = await read();
    check(session?.turnState === 'working', 'an async agent launch is working');

    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:07.000Z', repoPath, 'end_turn')}\n`
    );
    session = await read();
    check(
      session?.turnState === 'working',
      'a running background agent outlasts the parent turn'
    );
    check(session?.turnEndedAt === null, 'no turn end while an agent runs');

    fs.appendFileSync(
      transcript,
      `${taskNotificationEntry(
        '2026-01-01T00:00:08.000Z',
        repoPath,
        ['agent-1']
      )}\n`
    );
    session = await read();
    check(
      session?.turnState === 'working',
      'the agent notification reopens the turn'
    );

    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:09.000Z', repoPath, 'end_turn')}\n`
    );
    session = await read();
    check(
      session?.turnState === 'done',
      'the turn ends once the agent has reported'
    );

    // One notification can report several stopped agents at once.
    fs.appendFileSync(
      transcript,
      `${asyncAgentResultEntry(
        '2026-01-01T00:00:10.000Z',
        repoPath,
        'tool-agent-a',
        'agent-2'
      )}\n`
    );
    fs.appendFileSync(
      transcript,
      `${asyncAgentResultEntry(
        '2026-01-01T00:00:10.000Z',
        repoPath,
        'tool-agent-b',
        'agent-3'
      )}\n`
    );
    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:11.000Z', repoPath, 'end_turn')}\n`
    );
    fs.appendFileSync(
      transcript,
      `${taskNotificationEntry(
        '2026-01-01T00:00:12.000Z',
        repoPath,
        ['agent-2', 'agent-3'],
        'stopped'
      )}\n`
    );
    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:13.000Z', repoPath, 'end_turn')}\n`
    );
    session = await read();
    check(
      session?.turnState === 'done',
      'a notification clearing several agents ends the turn'
    );

    // Claude's turn_duration entry carries the authoritative count. It is
    // written at every turn end and omits the field when nothing is pending.
    fs.appendFileSync(
      transcript,
      `${asyncAgentResultEntry(
        '2026-01-01T00:00:14.000Z',
        repoPath,
        'tool-agent-c',
        'agent-4'
      )}\n`
    );
    fs.appendFileSync(
      transcript,
      `${assistantEntry('2026-01-01T00:00:15.000Z', repoPath, 'end_turn')}\n`
    );
    fs.appendFileSync(
      transcript,
      `${turnDurationEntry('2026-01-01T00:00:15.000Z', repoPath, 1)}\n`
    );
    session = await read();
    check(
      session?.turnState === 'working',
      'a turn_duration count keeps the session working'
    );

    fs.appendFileSync(
      transcript,
      `${turnDurationEntry('2026-01-01T00:00:16.000Z', repoPath)}\n`
    );
    session = await read();
    check(
      session?.turnState === 'done',
      'a turn_duration without a count clears the agents'
    );
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* opencode turn state                                                 */
/* ------------------------------------------------------------------ */

function testOpencodeTurnState(): void {
  check(
    deriveTurnState({ created: 1, updated: 10, idle: 10 }).turnState === 'done',
    'opencode idle session is done'
  );
  check(
    deriveTurnState({ created: 1, updated: 20, idle: 10 }).turnState === 'working',
    'opencode session updated after idle is working'
  );
  check(
    deriveTurnState({ created: 1, updated: 20 }).turnState === 'working',
    'opencode session without idle is working'
  );
}

/* ------------------------------------------------------------------ */
/* Hook log parsing                                                    */
/* ------------------------------------------------------------------ */

function testParseAttentionLines(): void {
  const text = [
    json({ hook_event_name: 'Notification', session_id: 'abc', message: 'permission' }),
    'not json',
    '',
    json({ hook_event_name: 'Stop', session_id: 'def' }),
  ].join('\n');

  const events = parseAttentionLines(text);
  check(events.length === 2, `parsed ${events.length} events (expected 2)`);
  check(events[0]?.session_id === 'abc', 'first event session id');
  check(events[1]?.hook_event_name === 'Stop', 'second event name');
  check(parseAttentionLines('{"broken":').length === 0, 'a partial line is skipped');

  check(
    escapeAppleScript('He said "hi"') === 'He said \\"hi\\"',
    'AppleScript text escapes quotes'
  );
  check(
    escapeAppleScript('one\ntwo') === 'one two',
    'AppleScript text flattens newlines'
  );
}

/* ------------------------------------------------------------------ */
/* Claude settings surgery                                             */
/* ------------------------------------------------------------------ */

function existingSettings(): Record<string, unknown> {
  return {
    model: 'opus',
    hooks: {
      Stop: [
        { hooks: [{ type: 'command', command: '/Users/me/.config/iterm2/cc-status' }] },
      ],
      Notification: [
        { hooks: [{ type: 'command', command: '/Users/me/.config/iterm2/cc-status' }] },
      ],
      PostToolUse: [
        { hooks: [{ type: 'command', command: '/Users/me/.config/iterm2/cc-status' }] },
      ],
    },
  };
}

function testHookMerging(): void {
  const original = existingSettings();
  const before = JSON.stringify(original);

  const merged = mergeAttentionHooks(original);
  check(JSON.stringify(original) === before, 'merge does not mutate its input');
  check(hasAttentionHooks(merged), 'merged settings have the attention hooks');

  const hooks = merged.hooks as Record<string, Array<Record<string, unknown>>>;
  check(hooks.Stop.length === 2, 'Stop keeps the existing hook and adds one');
  check(hooks.Notification.length === 2, 'Notification keeps the existing hook');
  check(
    (hooks.Notification[1]?.matcher as string) ===
      'permission_prompt|idle_prompt|elicitation_dialog',
    'Notification matcher is limited to prompts'
  );
  check(hooks.PostToolUse.length === 1, 'unrelated hooks are untouched');

  const again = mergeAttentionHooks(merged);
  check(JSON.stringify(again) === JSON.stringify(merged), 'merge is idempotent');

  const removed = removeAttentionHooks(merged);
  check(
    JSON.stringify(removed) === JSON.stringify(original),
    'remove restores the original settings exactly'
  );
  check(!hasAttentionHooks(removed), 'removed settings report no attention hooks');
}

function testHookFiles(): void {
  const dir = tempDir('agntree-attention-settings-');
  const settingsPath = path.join(dir, 'settings.json');
  const original = existingSettings();
  fs.writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`);

  const first = applyAttentionHooks(settingsPath);
  check(first.changed && !first.error, 'apply writes the hooks');
  check(
    fs.existsSync(`${settingsPath}.agntree-backup`),
    'a one-time backup is written'
  );
  check(attentionHooksInstalled(settingsPath), 'installed hooks are detected');

  const second = applyAttentionHooks(settingsPath);
  check(!second.changed && !second.error, 'apply is idempotent on disk');

  const reverted = revertAttentionHooks(settingsPath);
  check(reverted.changed && !reverted.error, 'revert removes the hooks');
  check(!attentionHooksInstalled(settingsPath), 'reverted hooks are not detected');

  const onDisk = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  check(
    JSON.stringify(onDisk) === JSON.stringify(original),
    'the settings file is back to its original shape'
  );

  const badPath = path.join(dir, 'bad.json');
  fs.writeFileSync(badPath, '{ this is not json');
  const bad = applyAttentionHooks(badPath);
  check(Boolean(bad.error), 'invalid JSON is refused');
  check(
    fs.readFileSync(badPath, 'utf-8') === '{ this is not json',
    'the invalid file is left untouched'
  );

  const freshPath = path.join(dir, 'fresh.json');
  const fresh = applyAttentionHooks(freshPath);
  check(fresh.changed && !fresh.error, 'a missing settings file is created');
  const freshSettings = JSON.parse(fs.readFileSync(freshPath, 'utf-8'));
  check(
    (freshSettings.hooks?.Stop?.[0]?.hooks?.[0]?.command as string) ===
      ATTENTION_HOOK_COMMAND,
    'the hook command is the documented one'
  );

  fs.rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log('\n== claude turn state ==');
  await testClaudeTurnState();

  console.log('\n== opencode turn state ==');
  testOpencodeTurnState();

  console.log('\n== hook log parsing ==');
  testParseAttentionLines();

  console.log('\n== hook settings ==');
  testHookMerging();
  testHookFiles();

  console.log(`\n${failures === 0 ? 'ALL ATTENTION CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
