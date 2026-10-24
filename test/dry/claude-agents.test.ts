import * as fs from 'fs';
import * as path from 'path';
import {
  ClaudeAgentsService,
  parseClaudeAgents,
} from '../../src/services/ClaudeAgentsService';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function fixture(): string {
  return fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'claude-agents.json'),
    'utf8'
  );
}

function testParsing(): void {
  console.log('\n== agents JSON parsing ==');
  const states = parseClaudeAgents(fixture());
  check(states.size === 3, `parsed ${states.size} sessions`);
  check(
    states.get('11111111-1111-1111-1111-111111111111')?.waitingFor ===
      undefined,
    'a busy session has no waiting reason'
  );
  check(
    states.get('22222222-2222-2222-2222-222222222222')?.waitingFor ===
      'permission prompt',
    'a waiting session keeps the raw reason'
  );
  check(
    states.has('33333333-3333-3333-3333-333333333333'),
    'an idle session is parsed'
  );

  const missingReason = parseClaudeAgents(
    JSON.stringify([{ sessionId: 's1', status: 'waiting' }])
  );
  check(
    missingReason.get('s1')?.waitingFor === 'input needed',
    'waiting without a reason still produces one'
  );

  const duplicate = parseClaudeAgents(
    JSON.stringify([
      { sessionId: 'dup', status: 'busy', startedAt: 10, pid: 1 },
      {
        sessionId: 'dup',
        status: 'waiting',
        waitingFor: 'permission prompt',
        startedAt: 5,
        pid: 2,
      },
    ])
  );
  check(
    duplicate.get('dup')?.waitingFor === 'permission prompt',
    'a real waiting reason wins a duplicate, even when older'
  );

  const newest = parseClaudeAgents(
    JSON.stringify([
      { sessionId: 'dup', status: 'idle', startedAt: 5 },
      { sessionId: 'dup', status: 'busy', startedAt: 10 },
    ])
  );
  check(
    newest.get('dup')?.startedAt === 10,
    'without a waiting reason the newest startedAt wins'
  );

  const unknownFields = parseClaudeAgents(
    JSON.stringify([
      { sessionId: 's2', status: 'busy', secret: 'ignored', pid: 'not-a-number' },
    ])
  );
  check(
    unknownFields.get('s2')?.startedAt === undefined,
    'unknown and mistyped fields are absent'
  );
  check(
    parseClaudeAgents(JSON.stringify([{ status: 'busy' }])).size === 0,
    'rows without a session ID are skipped'
  );
  check(parseClaudeAgents('').size === 0, 'empty output is an empty map');

  let malformedThrew = false;
  try {
    parseClaudeAgents('{not json');
  } catch {
    malformedThrew = true;
  }
  check(malformedThrew, 'malformed JSON throws for the service to handle');

  let shapeThrew = false;
  try {
    parseClaudeAgents('{"sessions":[]}');
  } catch {
    shapeThrew = true;
  }
  check(shapeThrew, 'a non-array payload throws');
}

async function testService(): Promise<void> {
  console.log('\n== agents service cache and failure ==');

  let execCalls = 0;
  let now = 0;
  let output = fixture();
  let optionsSeen: Record<string, unknown> | undefined;

  const service = new ClaudeAgentsService({
    command: () => 'fake-claude',
    enabled: () => true,
    now: () => now,
    env: { CLAUDE_CONFIG_DIR: '/tmp/claude-profile' },
    exec: async (_command, args, options) => {
      execCalls++;
      optionsSeen = options as Record<string, unknown>;
      check(
        args.join(' ') === 'agents --json',
        'the service asks for agents --json'
      );
      return output;
    },
  });

  const first = await service.getStates();
  check(first.size === 3, 'the first call parses the output');
  check(
    Boolean(
      optionsSeen?.env &&
        (optionsSeen.env as NodeJS.ProcessEnv).CLAUDE_CONFIG_DIR ===
          '/tmp/claude-profile'
    ),
    'CLAUDE_CONFIG_DIR is passed to the CLI'
  );
  check(
    optionsSeen?.shell === (process.platform === 'win32'),
    'the Windows .cmd shim runs through a shell'
  );

  await service.getStates();
  check(execCalls === 1, 'a second call within 10s uses the cache');

  now = 10_001;
  await service.getStates();
  check(execCalls === 2, 'the cache expires after 10s');

  // In-flight calls share one process.
  execCalls = 0;
  let release: ((value: string) => void) | undefined;
  const shared = new ClaudeAgentsService({
    command: () => 'fake-claude',
    enabled: () => true,
    exec: () =>
      new Promise<string>((resolve) => {
        execCalls++;
        release = resolve;
      }),
  });
  const a = shared.getStates();
  const b = shared.getStates();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release?.(fixture());
  const [firstShared, secondShared] = await Promise.all([a, b]);
  check(execCalls === 1, 'concurrent callers share one CLI call');
  check(
    firstShared === secondShared && firstShared.size === 3,
    'both concurrent callers receive the same map'
  );

  // Disabled: no spawn and no cache lookup.
  let disabledExec = 0;
  const disabled = new ClaudeAgentsService({
    command: () => 'fake-claude',
    enabled: () => false,
    exec: async () => {
      disabledExec++;
      return fixture();
    },
  });
  check((await disabled.getStates()).size === 0, 'disabled returns an empty map');
  check(disabledExec === 0, 'disabled never spawns the CLI');

  // A failure disables the interface until restart.
  let failingExec = 0;
  const failing = new ClaudeAgentsService({
    command: () => 'fake-claude',
    enabled: () => true,
    exec: async () => {
      failingExec++;
      throw new Error('CLI failed');
    },
  });
  check((await failing.getStates()).size === 0, 'a failure returns an empty map');
  check(
    (await failing.getStates()).size === 0 && failingExec === 1,
    'a failure is not retried on every tick'
  );

  // Malformed output follows the same path.
  let malformedExec = 0;
  output = '{not json';
  const malformed = new ClaudeAgentsService({
    command: () => 'fake-claude',
    enabled: () => true,
    exec: async () => {
      malformedExec++;
      return output;
    },
  });
  check(
    (await malformed.getStates()).size === 0 && malformedExec === 1,
    'malformed output is treated as unavailable'
  );
}

async function main(): Promise<void> {
  testParsing();
  await testService();

  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE AGENTS CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
