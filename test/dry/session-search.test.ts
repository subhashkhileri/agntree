/**
 * The session finder against a fake `claude` (fixtures/fake-claude-search.js)
 * and synthetic transcripts. No model runs: the fake replays, turn by turn,
 * the stream-json events and text replies a real search produces.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { SessionSearchService } from '../../src/services/SessionSearchService';
import { encodeClaudeProjectPath } from '../../src/utils/paths';
import { claudeProfile, entry } from './claudeFixture';
import { makeStorage, memento, stub, tempDir, waitFor } from './support';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-claude-search.js');
const posixOnly = { skip: process.platform === 'win32' ? 'the fake CLI is a POSIX shell wrapper' : false };

const MOD_SESSION = '0b1c2d3e-0000-4000-8000-000000000001';
const ECHO_SESSION = '0b1c2d3e-0000-4000-8000-000000000002';
const STARTED = '2026-11-08T01:17:20.719Z';

interface Call {
  args: string[];
  /** Every message the CLI received, in order. */
  prompts: string[];
  cwd: string;
  pid: number;
  grandchildPid?: number;
}

/** A Claude profile with two sessions, the finder, and a fake CLI playing `scenario`. */
function setup(t: { after(fn: () => void): void }, scenario: object | ((projectDirName: string) => object)) {
  stub.__reset();
  const profile = claudeProfile(t);
  const home = profile.dir('home');
  // The work happened here, in a session named for something else.
  profile.write(MOD_SESSION, home, [
    entry.aiTitle('Laptop USB persistence setup'),
    entry.injected('<system-reminder>Claude usage mod: /opt/mods/usage-line</system-reminder>'),
    entry.user('Set up persistence on the USB stick', '2026-11-07T16:41:45.997Z'),
    {
      type: 'user',
      timestamp: STARTED,
      message: { role: 'user', content: 'i would like to install a claude mod that shows the context window and subscription limits' },
    },
    entry.assistant('Installed usage-line.'),
  ]);
  // Here the mod appears only in context Claude injected.
  profile.write(ECHO_SESSION, home, [
    entry.injected('Claude usage mod: /opt/mods/usage-line'),
    entry.user('what is my browser version'),
  ]);

  const dir = tempDir(t, 'agntree-search-');
  const scenarioFile = path.join(dir, 'scenario.json');
  const cli = path.join(dir, 'claude');
  const played = typeof scenario === 'function' ? scenario(path.basename(profile.projectDir(home))) : scenario;
  fs.writeFileSync(scenarioFile, JSON.stringify(played));
  fs.writeFileSync(cli, `#!/bin/sh\nFAKE_CLAUDE_SEARCH='${scenarioFile}' exec '${process.execPath}' '${FIXTURE}' "$@"\n`, {
    mode: 0o755,
  });
  stub.__setConfiguration('harnessCommands', { claude: cli });

  const scratch = path.join(dir, 'scratch');
  const storage = makeStorage();
  const registry = new HarnessRegistry([new ClaudeHarness({ sessionService: new ClaudeSessionService() })]);
  const finder = new SessionSearchService(storage, registry, scratch);
  t.after(() => finder.dispose());
  return {
    profile,
    home,
    scratch,
    storage,
    registry,
    finder,
    /** The pid of every CLI process started so far. */
    starts: () => (fs.existsSync(`${scenarioFile}.starts`) ? fs.readFileSync(`${scenarioFile}.starts`, 'utf8').trim().split('\n') : []),
    call: () => waitFor(() => fs.existsSync(`${scenarioFile}.call.json`), 'the CLI to start').then(
      () => JSON.parse(fs.readFileSync(`${scenarioFile}.call.json`, 'utf8')) as Call
    ),
    /** Play a different scenario on the next run. */
    play: (next: object) => {
      fs.rmSync(`${scenarioFile}.call.json`, { force: true });
      fs.writeFileSync(scenarioFile, JSON.stringify(next));
    },
  };
}

const toolUse = (name: string, input: object) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
});

/** The event that ends a turn with `reply` as the agent's text. */
const reply = (text: string, costUsd?: number) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  total_cost_usd: costUsd,
});

/** The JSON Schema the prompt ends with. */
const promptSchema = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));

const MOD_MATCH = { harness: 'claude', sessionId: MOD_SESSION, quote: 'i would like to install a claude mod', reason: 'Asks for the mod.' };

test('a search runs the cheap default read-only with no saved session, and keeps only sessions Claude confirms', posixOnly, async (t) => {
  const answer = (projectDirName: string) => ({
    answer: 'The mod was set up inside the laptop USB setup session on 8 November.',
    matches: [
      { harness: 'claude', sessionId: MOD_SESSION, quote: 'I would like to install a Claude mod', reason: 'Asks for the usage mod.' },
      { harness: 'claude', sessionId: ECHO_SESSION, quote: 'Claude usage mod: /mnt', reason: 'Mentions the mod.' },
      // Not a session ID: a path that climbs into a real transcript.
      { harness: 'claude', sessionId: `../${projectDirName}/${MOD_SESSION}`, quote: 'Set up persistence', reason: 'Invented.' },
    ],
  });
  let expected: ReturnType<typeof answer> | undefined;
  const { profile, home, scratch, storage, registry, finder, call } = setup(t, (projectDirName) => ({
    leftover: true,
    turns: [
      [
        { type: 'system', subtype: 'init' },
        toolUse('Grep', { pattern: 'claude mod|usage limits', output_mode: 'files_with_matches' }),
        toolUse('Read', { file_path: `/profile/projects/-home/${MOD_SESSION}.jsonl`, offset: 3, limit: 1 }),
        reply(JSON.stringify((expected = answer(projectDirName))), 0.0076),
      ],
    ],
  }));

  const engine = finder.engine();
  assert.deepEqual(engine, { harness: 'claude', model: 'haiku', effort: 'medium' });
  const search = await finder.search('which session set up the usage mod', engine!);

  assert.equal(search.state, 'done');
  assert.equal(search.answer, expected?.answer);
  assert.deepEqual(
    search.matches.map((match) => [match.sessionId, match.title, match.cwd, match.prompt?.timestamp]),
    [
      [MOD_SESSION, 'Laptop USB persistence setup', home, Date.parse(STARTED)],
      // The session exists, but the quote is injected context, not a prompt.
      [ECHO_SESSION, 'what is my browser version', home, undefined],
    ]
  );
  assert.equal(search.discarded, 1, 'the path posing as an ID is hidden');
  assert.deepEqual(search.activity, ['Grep "claude mod|usage limits"', `Read ${MOD_SESSION}.jsonl`]);
  assert.equal(search.costUsd, 0.0076);

  const { args, prompts, cwd } = await call();
  const [prompt] = prompts;
  const flag = (name: string) => args[args.indexOf(name) + 1];
  assert.deepEqual(
    [flag('--model'), flag('--effort'), flag('--tools'), flag('--add-dir'), flag('--input-format'), flag('--output-format')],
    ['haiku', 'medium', 'Read,Grep,Glob', profile.projects, 'stream-json', 'stream-json']
  );
  assert.ok(args.includes('--print') && args.includes('--no-session-persistence'));
  assert.ok(!args.some((arg) => arg.startsWith('--allowed')), 'no allow list: reads stay inside the added directory');
  assert.equal(prompts.length, 1, 'a valid reply needs no follow-up');
  assert.deepEqual(promptSchema(prompt).properties.matches.items.properties.harness.enum, ['claude']);
  assert.ok(prompt.includes('"which session set up the usage mod"'));
  assert.ok(prompt.includes('How to search Claude Code sessions'));
  assert.equal(path.dirname(cwd), fs.realpathSync(scratch), 'the agent runs in a folder of its own');
  assert.equal(fs.existsSync(cwd), false, 'which is removed afterwards');

  const leftovers = path.join(profile.projects, encodeClaudeProjectPath(cwd));
  assert.ok(prompt.includes(`Never search ${leftovers}`));
  assert.equal(fs.existsSync(leftovers), false, "the search's own project directory is removed");
  assert.ok(fs.existsSync(profile.projectDir(home)), 'real sessions are untouched');

  const reloaded = new SessionSearchService(storage, registry, scratch);
  assert.deepEqual(reloaded.searches().map((stored) => stored.id), [search.id], 'kept across a reload');
});

test('stopping a search ends the agent and everything it started, and keeps nothing', posixOnly, async (t) => {
  // The grandchild holds the output open, as the ripgrep behind a Grep does.
  const { finder, storage, call } = setup(t, { hang: true, grandchild: true });

  const pending = finder.search('anything', finder.engine()!);
  const { pid, grandchildPid } = await call();
  t.after(() => {
    try {
      process.kill(grandchildPid!, 'SIGKILL');
    } catch {
      // Stopped by the search, as it should be.
    }
  });
  assert.equal(finder.searches()[0].state, 'running');
  finder.cancel();

  assert.equal((await pending).state, 'cancelled');
  const gone = (processId: number) => {
    try {
      process.kill(processId, 0);
      return false;
    } catch {
      return true;
    }
  };
  assert.ok(gone(pid), 'the CLI process is gone');
  await waitFor(() => gone(grandchildPid!), 'what it started to exit');
  assert.deepEqual(storage.getSessionSearches(), []);
  assert.deepEqual(finder.searches(), []);
});

test('a new question stops the running search, and one overtaken while waiting never starts', posixOnly, async (t) => {
  const { finder, storage, call, play, starts } = setup(t, { hang: true });
  const first = finder.search('first question', finder.engine()!);
  const { pid } = await call();

  play({ turns: [[reply(JSON.stringify({ answer: 'Nothing matched.', matches: [] }))]] });
  const second = finder.search('second question', finder.engine()!);
  const third = finder.search('third question', finder.engine()!);

  assert.deepEqual(
    [(await first).state, (await second).state, (await third).state],
    ['cancelled', 'cancelled', 'done']
  );
  assert.throws(() => process.kill(pid, 0), 'the first agent is gone');
  assert.equal(starts().length, 2, 'the second question never started an agent');
  assert.deepEqual(storage.getSessionSearches().map((search) => search.query), ['third question']);
});

test('confirming a quote reads the transcript in one pass and leaves no file open', { skip: fs.existsSync('/proc/self/fd') ? false : 'counts open files in /proc' }, async (t) => {
  const { home } = setup(t, {});
  const sessions = new ClaudeSessionService();
  const openFiles = () => fs.readdirSync('/proc/self/fd').length;
  const before = openFiles();

  // Uncached: parsed on the same pass that finds the prompt.
  const first = await sessions.findSessionPrompt(MOD_SESSION, 'I would like to install a Claude mod');
  // Cached: read only until the prompt turns up.
  const second = await sessions.findSessionPrompt(MOD_SESSION, 'set up   persistence');

  assert.deepEqual([first?.session.cwd, first?.session.summary, first?.prompt?.timestamp], [home, 'Laptop USB persistence setup', Date.parse(STARTED)]);
  assert.equal(second?.prompt?.text, 'Set up persistence on the USB stick');
  assert.equal(second?.session, first?.session, 'the second lookup reused the parse');
  assert.equal(await sessions.findSessionPrompt(MOD_SESSION, 'never typed').then((found) => found && found.prompt), undefined);
  assert.equal(openFiles(), before);
});

test('a reply that breaks the schema goes back to the same agent with what is wrong, and the fixed reply is kept', posixOnly, async (t) => {
  const answer = { answer: 'The mod was installed on 8 November.', matches: [MOD_MATCH] };
  const { finder, call } = setup(t, {
    turns: [
      [reply(`Here it is:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``)],
      [reply(JSON.stringify({ answer: answer.answer, matches: [{ ...MOD_MATCH, harness: 'codex', quote: undefined }] }))],
      [reply(JSON.stringify(answer), 0.012)],
    ],
  });

  const search = await finder.search('the usage mod', finder.engine()!);

  assert.equal(search.state, 'done');
  assert.deepEqual(search.matches.map((match) => match.sessionId), [MOD_SESSION]);
  assert.equal(search.costUsd, 0.012, "the conversation's total");
  const { prompts } = await call();
  assert.equal(prompts.length, 3, 'one process heard the question and both corrections');
  assert.match(prompts[1], /- the reply is not valid JSON on its own\n/);
  assert.match(prompts[2], /- matches\[0\]\.quote is missing\n- matches\[0\]\.harness must be one of "claude"\n/);
  assert.deepEqual(search.activity, [
    'Fixing its answer: the reply is not valid JSON on its own',
    'Fixing its answer: matches[0].quote is missing',
  ]);
});

test('an agent that never fixes its reply fails the search after two corrections', posixOnly, async (t) => {
  const { finder, storage, call } = setup(t, { turns: [[reply('no idea')], [reply('still no idea')], [reply('{}')]] });

  const search = await finder.search('the usage mod', finder.engine()!);

  assert.equal(search.state, 'failed');
  assert.equal(search.error, 'The answer did not follow the requested format: answer is missing');
  assert.equal((await call()).prompts.length, 3);
  assert.deepEqual(storage.getSessionSearches().map((stored) => stored.state), ['failed']);
});

test("a CLI that fails without an answer leaves a failed search carrying its error", posixOnly, async (t) => {
  const { finder, storage } = setup(t, { exitCode: 1, stderr: 'Error: Invalid API key · Please run /login' });

  const search = await finder.search('anything', finder.engine()!);

  assert.equal(search.state, 'failed');
  assert.match(search.error ?? '', /Invalid API key/);
  assert.deepEqual(storage.getSessionSearches().map((stored) => stored.state), ['failed']);
});

test('the newest ten searches are kept, and a malformed record or a harness this build lacks is skipped', async () => {
  const state = memento();
  const known = { harness: 'claude', sessionId: 'a', cwd: '/w', title: 'A', lastUpdated: 1, reason: '' };
  await state.update('agntree.sessionSearches', [
    { id: 'broken' },
    // Saved by a newer build that knows a harness this one does not.
    { id: 'newer', query: 'q', engine: { harness: 'aider', model: 'm', effort: 'medium' }, startedAt: 0, state: 'done', matches: [], activity: [] },
    { id: 'mixed', query: 'q', engine: { harness: 'claude', model: 'm', effort: 'medium' }, startedAt: 0, state: 'done', matches: [known, { ...known, harness: 'aider' }], activity: [] },
  ]);
  assert.deepEqual(
    makeStorage(state).getSessionSearches().map((search) => [search.id, search.matches.map((match) => match.harness)]),
    [['mixed', ['claude']]]
  );
  const storage = makeStorage(state);
  for (let i = 0; i < 12; i++) {
    await storage.saveSessionSearch({
      id: `s${i}`,
      query: `q${i}`,
      engine: { harness: 'claude', model: 'haiku', effort: 'medium' },
      startedAt: i,
      state: 'done',
      matches: [],
      activity: [],
    });
  }
  assert.deepEqual(
    storage.getSessionSearches().map((search) => search.id),
    ['s11', 's10', 's9', 's8', 's7', 's6', 's5', 's4', 's3', 's2']
  );
});
