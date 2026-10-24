import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deriveClaudeTurnState,
  readTurnStateTail,
} from '../../src/services/ClaudeTurnState';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-claude-tail-'));
let serial = 0;

function writeFile(content: string): string {
  const file = path.join(DIR, `session-${++serial}.jsonl`);
  fs.writeFileSync(file, content);
  return file;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function userEntry(
  text = 'Please fix the tests',
  timestamp = '2026-01-01T00:00:00.000Z',
  isSidechain = false
): string {
  return line({
    type: 'user',
    timestamp,
    isSidechain,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

function assistantEntry(
  stopReason: string | null,
  timestamp = '2026-01-01T00:00:01.000Z',
  isSidechain = false,
  text = 'done'
): string {
  return line({
    type: 'assistant',
    timestamp,
    isSidechain,
    message: {
      role: 'assistant',
      stop_reason: stopReason,
      content: [{ type: 'text', text }],
    },
  });
}

function turnDurationEntry(
  pendingAgents?: number,
  timestamp = '2026-01-01T00:00:01.000Z'
): string {
  return line({
    type: 'system',
    subtype: 'turn_duration',
    timestamp,
    ...(pendingAgents === undefined
      ? {}
      : { pendingBackgroundAgentCount: pendingAgents }),
  });
}

function testDerivation(): void {
  console.log('\n== shared derivation ==');
  check(
    deriveClaudeTurnState({
      lastConversation: null,
      pendingBackgroundAgents: null,
    }).turnState === 'working',
    'no conversation is working'
  );
  check(
    deriveClaudeTurnState({
      lastConversation: {
        type: 'user',
        stopReason: null,
        timestamp: 1,
      },
      pendingBackgroundAgents: null,
    }).turnState === 'working',
    'a user entry is working'
  );
  check(
    deriveClaudeTurnState({
      lastConversation: {
        type: 'assistant',
        stopReason: null,
        timestamp: 1,
      },
      pendingBackgroundAgents: null,
    }).turnState === 'working',
    'a streaming assistant entry is working'
  );
  check(
    deriveClaudeTurnState({
      lastConversation: {
        type: 'assistant',
        stopReason: 'tool_use',
        timestamp: 1,
      },
      pendingBackgroundAgents: null,
    }).turnState === 'working',
    'a tool_use assistant entry is working'
  );
  const done = deriveClaudeTurnState({
    lastConversation: {
      type: 'assistant',
      stopReason: 'end_turn',
      timestamp: 1234,
    },
    pendingBackgroundAgents: null,
  });
  check(
    done.turnState === 'done' && done.turnEndedAt === 1234,
    'a terminal assistant entry is done with its timestamp'
  );
  check(
    deriveClaudeTurnState({
      lastConversation: {
        type: 'assistant',
        stopReason: 'end_turn',
        timestamp: 1234,
      },
      pendingBackgroundAgents: 2,
    }).turnState === 'working',
    'a positive pending-agent count keeps the turn open'
  );
  check(
    deriveClaudeTurnState({
      lastConversation: {
        type: 'assistant',
        stopReason: 'end_turn',
        timestamp: 1234,
      },
      pendingBackgroundAgents: 0,
    }).turnState === 'done',
    'zero pending agents ends the turn'
  );
}

async function testTailReader(): Promise<void> {
  console.log('\n== tail reader ==');

  const empty = await readTurnStateTail(writeFile(''));
  check(
    empty?.turnState === 'working' && empty.turnEndedAt === null,
    'an empty transcript is working'
  );

  const summaryOnly = await readTurnStateTail(
    writeFile(line({ type: 'summary', summary: 'A session title' }))
  );
  check(
    summaryOnly?.turnState === 'working',
    'a summary without conversation is working'
  );

  let file = writeFile(userEntry());
  let reading = await readTurnStateTail(file);
  check(reading?.turnState === 'working', 'a user prompt is working');

  fs.appendFileSync(file, assistantEntry('tool_use'));
  reading = await readTurnStateTail(file);
  check(reading?.turnState === 'working', 'a tool_use assistant entry is working');

  fs.appendFileSync(
    file,
    assistantEntry('end_turn', '2026-01-01T00:00:02.000Z')
  );
  reading = await readTurnStateTail(file);
  check(
    reading?.turnState === 'done' &&
      reading.turnEndedAt === Date.parse('2026-01-01T00:00:02.000Z'),
    'a terminal assistant entry is done at its timestamp'
  );

  fs.appendFileSync(file, turnDurationEntry(1));
  reading = await readTurnStateTail(file);
  check(
    reading?.turnState === 'working',
    'a pending background agent keeps the session working'
  );

  fs.appendFileSync(file, turnDurationEntry(0));
  reading = await readTurnStateTail(file);
  check(reading?.turnState === 'done', 'zero pending agents ends the turn');

  const sidechain = await readTurnStateTail(
    writeFile(
      userEntry() +
        assistantEntry('end_turn', '2026-01-01T00:00:02.000Z', true)
    )
  );
  check(
    sidechain?.turnState === 'working',
    'a sidechain assistant entry does not decide the main turn'
  );

  const incomplete = await readTurnStateTail(
    writeFile(`${userEntry()}{"type":"assistant","message":`)
  );
  check(
    incomplete?.turnState === 'working',
    'an incomplete last line is ignored'
  );

  // A very large trailing entry forces the reader past its first windows.
  const hugeText = 'x'.repeat(300 * 1024);
  const hugeTrailing = await readTurnStateTail(
    writeFile(
      userEntry() +
        assistantEntry('end_turn', '2026-01-01T00:00:02.000Z') +
        turnDurationEntry(0) +
        assistantEntry(
          'end_turn',
          '2026-01-01T00:00:03.000Z',
          false,
          hugeText
        )
    )
  );
  check(
    hugeTrailing?.turnState === 'done' &&
      hugeTrailing.turnEndedAt === Date.parse('2026-01-01T00:00:03.000Z'),
    'a large trailing line expands the window and decides the turn'
  );

  // The deciding assistant entry is at the very start, and the only later
  // entry is a multi-megabyte non-conversation line. The reader must expand
  // all the way to the start of the file.
  const padding = 'y'.repeat(5 * 1024 * 1024);
  const expandsToStart = await readTurnStateTail(
    writeFile(
      assistantEntry('end_turn', '2026-01-01T00:00:04.000Z') +
        line({ type: 'system', subtype: 'note', padding })
    )
  );
  check(
    expandsToStart?.turnState === 'done' &&
      expandsToStart.turnEndedAt === Date.parse('2026-01-01T00:00:04.000Z'),
    'the reader expands to the file start when the deciding entry is there'
  );

  const missing = await readTurnStateTail(path.join(DIR, 'missing.jsonl'));
  check(missing === null, 'a missing transcript is omitted');
}

async function main(): Promise<void> {
  testDerivation();
  await testTailReader();

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE TURN STATE CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
