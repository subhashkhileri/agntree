/**
 * Find Session across every harness: one Claude search agent, one source per
 * harness, and each harness confirming its own session. The harnesses are
 * represented by fake processes and synthetic records; no model, network, or
 * installed CLI is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { CodexHarness } from '../../src/harnesses/CodexHarness';
import { OpencodeHarness } from '../../src/harnesses/OpencodeHarness';
import { OpencodeSessionSearch } from '../../src/harnesses/opencodeSearch';
import { PiHarness } from '../../src/harnesses/PiHarness';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { CodexAppServer } from '../../src/services/CodexAppServer';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { OpencodeSessionService } from '../../src/services/OpencodeSessionService';
import { PiSessionService } from '../../src/services/PiSessionService';
import { SessionSearchService } from '../../src/services/SessionSearchService';
import { claudeProfile, entry } from './claudeFixture';
import { piEntry, piProfile } from './piFixture';
import { fakeAdapter, makeStorage, setEnv, stub, tempDir, waitFor } from './support';

const CLAUDE_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-claude-search.js');
const CODEX_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-codex-app-server.js');
const OPENCODE_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-opencode.js');
const posixOnly = { skip: process.platform === 'win32' ? 'the fake CLIs are POSIX shell wrappers' : false };

const CLAUDE_SESSION = '0b1c2d3e-0000-4000-8000-000000000001';
const PI_SESSION = '33333333-3333-4333-8333-333333333333';
const OPENCODE_SESSION = 'ses_review';
const OPENCODE_CWD = '/tmp/opencode-repo';

interface OpencodeState {
  sessions: object[];
  exports: Record<string, { messages: object[] }>;
  calls: string[][];
  listDelayMs?: number;
  messageDelayMs?: number;
  terminated?: number;
}

/** A fake `opencode` CLI whose state is the JSON file the fixture reads. */
function fakeOpencode(t: { after(fn: () => void): void }, state: Omit<OpencodeState, 'calls'>) {
  const dir = tempDir(t, 'agntree-opencode-');
  const stateFile = path.join(dir, 'state.json');
  const cli = path.join(dir, 'opencode');
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, calls: [] }));
  fs.writeFileSync(
    cli,
    `#!/bin/sh\nFAKE_OPENCODE_STATE='${stateFile}' exec '${process.execPath}' '${OPENCODE_FIXTURE}' "$@"\n`,
    { mode: 0o755 }
  );
  return {
    cli,
    read: (): OpencodeState => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
  };
}

test('one search reads Claude, Codex, opencode, and Pi records and keeps only what each harness confirms', posixOnly, async (t) => {
  stub.__reset();
  const claude = claudeProfile(t);
  const claudeHome = claude.dir('home');
  claude.write(CLAUDE_SESSION, claudeHome, [
    entry.aiTitle('Claude mod work'),
    entry.user('install the context mod'),
    entry.assistant('Installed it.'),
  ]);

  const pi = piProfile(t);
  const piHome = pi.dir('repo');
  pi.write(PI_SESSION, piHome, [
    piEntry.sessionInfo('Pi banana work'),
    piEntry.user('investigate the banana importer'),
    piEntry.assistant('Done.'),
  ]);

  const opencode = fakeOpencode(t, {
    sessions: [
      {
        id: OPENCODE_SESSION,
        title: 'Reviewing uncommitted code changes',
        agent: 'build',
        time: { created: 1, updated: 10 },
        location: { directory: OPENCODE_CWD },
      },
    ],
    exports: {
      [OPENCODE_SESSION]: {
        messages: [
          { type: 'user', text: 'please review the parser change', time: { created: 2 } },
          { type: 'assistant', content: [{ type: 'text', text: 'Reviewed.' }] },
        ],
      },
    },
  });

  const codexHome = tempDir(t, 'agntree-codex-home-');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  setEnv(t, { CODEX_HOME: codexHome, FAKE_CODEX_CWD: process.cwd() });
  const appServer = new CodexAppServer({
    command: process.execPath,
    args: [CODEX_FIXTURE],
    requestTimeoutMs: 2_000,
    idleTimeoutMs: 0,
  });
  t.after(() => appServer.dispose());

  const dir = tempDir(t, 'agntree-cross-');
  const scenarioFile = path.join(dir, 'scenario.json');
  const claudeCli = path.join(dir, 'claude');
  const answer = {
    answer: 'I found the Codex, opencode, and Pi sessions.',
    matches: [
      { harness: 'codex', sessionId: 'thread-1', quote: 'first prompt', reason: 'Starts the first thread.' },
      { harness: 'opencode', sessionId: OPENCODE_SESSION, quote: 'please review the parser change', reason: 'Reviews the change.' },
      { harness: 'pi', sessionId: PI_SESSION, quote: 'investigate the banana importer', reason: 'Investigates the importer.' },
    ],
  };
  fs.writeFileSync(
    scenarioFile,
    JSON.stringify({
      turns: [[
        { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(answer) },
      ]],
    })
  );
  fs.writeFileSync(
    claudeCli,
    `#!/bin/sh\nFAKE_CLAUDE_SEARCH='${scenarioFile}' exec '${process.execPath}' '${CLAUDE_FIXTURE}' "$@"\n`,
    { mode: 0o755 }
  );
  stub.__setConfiguration('harnessCommands', {
    claude: claudeCli,
    codex: process.execPath,
    opencode: opencode.cli,
    pi: 'pi',
  });

  const storage = makeStorage();
  const registry = new HarnessRegistry([
    new ClaudeHarness({ sessionService: new ClaudeSessionService() }),
    new OpencodeHarness(),
    new CodexHarness({ appServer }),
    new PiHarness({ sessionService: new PiSessionService() }),
  ]);
  const finder = new SessionSearchService(storage, registry, path.join(dir, 'scratch'));
  t.after(() => finder.dispose());

  const engine = await finder.engine();
  assert.deepEqual(engine, { harness: 'claude', model: '', effort: '' });
  const search = await finder.search('which session touched the banana importer', engine!);

  assert.equal(search.state, 'done');
  assert.deepEqual(
    search.matches.map((match) => [match.harness, match.sessionId, match.title, match.cwd, match.prompt?.text]),
    [
      ['codex', 'thread-1', 'First thread', process.cwd(), 'first prompt'],
      ['opencode', OPENCODE_SESSION, 'Reviewing uncommitted code changes', OPENCODE_CWD, 'please review the parser change'],
      ['pi', PI_SESSION, 'Pi banana work', piHome, 'investigate the banana importer'],
    ]
  );

  const call = await waitFor(
    () => fs.existsSync(`${scenarioFile}.call.json`),
    'the search CLI to start'
  ).then(() => JSON.parse(fs.readFileSync(`${scenarioFile}.call.json`, 'utf8')) as {
    args: string[];
    prompts: string[];
    cwd: string;
  });
  const [prompt] = call.prompts;
  const schema = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n{') + 2));
  assert.deepEqual(
    schema.properties.matches.items.properties.harness.enum,
    ['claude', 'opencode', 'codex', 'pi'],
    'every installed source is offered, in registry order'
  );
  assert.ok(prompt.includes('How to search Codex sessions (harness "codex")'));
  assert.ok(prompt.includes('How to search opencode sessions (harness "opencode")'));
  assert.ok(prompt.includes('How to search Pi sessions (harness "pi")'));
  assert.ok(prompt.includes('The snapshot is ' + path.join(call.cwd, 'opencode-sessions')));
  assert.ok(prompt.includes('holding 1 recent top-level, non-archived sessions'));

  const added = call.args.flatMap((arg, index) => (arg === '--add-dir' ? [call.args[index + 1]] : []));
  assert.ok(added.includes(claude.projects), 'Claude transcripts are readable');
  assert.ok(added.includes(path.join(codexHome, 'sessions')), 'Codex rollouts are readable');
  assert.ok(added.includes(path.join(process.env.PI_CODING_AGENT_DIR!, 'sessions')), 'Pi records are readable');

  assert.equal(fs.existsSync(call.cwd), false, 'the search folder and its snapshot are removed');
  assert.ok(opencode.read().calls.some((args) => args.includes('session.message.list')), 'the snapshot used the message API');
});

test('stopping an opencode snapshot ends the session listing and unblocks preparation', posixOnly, async (t) => {
  stub.__reset();
  const opencode = fakeOpencode(t, {
    sessions: [
      { id: 'ses_one', title: 'One', time: { created: 1, updated: 1 }, location: { directory: '/tmp/repo' } },
      { id: 'ses_two', title: 'Two', time: { created: 2, updated: 2 }, location: { directory: '/tmp/repo' } },
    ],
    exports: {
      ses_one: { messages: [{ type: 'user', text: 'first prompt' }] },
      ses_two: { messages: [{ type: 'user', text: 'second prompt' }] },
    },
    listDelayMs: 10_000,
  });
  stub.__setConfiguration('harnessCommands', { opencode: opencode.cli });
  const source = new OpencodeSessionSearch(new OpencodeSessionService());
  const controller = new AbortController();
  t.after(() => controller.abort());
  const cwd = tempDir(t, 'agntree-opencode-abort-');

  const pending = source.prepare({ cwd, signal: controller.signal });
  await waitFor(
    () => opencode.read().calls.some((args) => args.includes('session.list')),
    'the session listing to start'
  );
  controller.abort();
  await assert.rejects(pending, /Search cancelled/);
  await waitFor(() => opencode.read().terminated, 'the listing process to stop');
});

test('the opencode preparation budget covers the session listing', posixOnly, async (t) => {
  stub.__reset();
  const opencode = fakeOpencode(t, {
    sessions: [
      { id: 'ses_one', title: 'One', time: { created: 1, updated: 3 }, location: { directory: '/tmp/repo' } },
      { id: 'ses_two', title: 'Two', time: { created: 2, updated: 2 }, location: { directory: '/tmp/repo' } },
      { id: 'ses_three', title: 'Three', time: { created: 3, updated: 1 }, location: { directory: '/tmp/repo' } },
    ],
    exports: {
      ses_one: { messages: [{ type: 'user', text: 'first prompt' }] },
      ses_two: { messages: [{ type: 'user', text: 'second prompt' }] },
      ses_three: { messages: [{ type: 'user', text: 'third prompt' }] },
    },
    listDelayMs: 100,
  });
  stub.__setConfiguration('harnessCommands', { opencode: opencode.cli });
  const source = new OpencodeSessionSearch(new OpencodeSessionService(), { budgetMs: 30 });
  const cwd = tempDir(t, 'agntree-opencode-budget-');

  const preparation = await source.prepare({ cwd, signal: new AbortController().signal });
  const calls = opencode.read().calls;
  assert.equal(
    calls.filter((args) => args[1] === 'session.list').length,
    1,
    'the first page runs, and the deadline stops the second'
  );
  assert.equal(calls.some((args) => args.includes('session.message.list')), false, 'no message fetch starts after the budget');
  assert.match(preparation.instructions, /holding 0 recent/);
});

test('the opencode snapshot stops at its byte budget and says so', posixOnly, async (t) => {
  stub.__reset();
  const text = 'x'.repeat(100);
  const sessions = ['ses_one', 'ses_two', 'ses_three'].map((id, index) => ({
    id,
    title: `Session ${index}`,
    time: { created: index, updated: index },
    location: { directory: '/tmp/repo' },
  }));
  const opencode = fakeOpencode(t, {
    sessions,
    exports: Object.fromEntries(
      sessions.map((session) => [
        session.id,
        { messages: [{ type: 'user', text: `${text} ${session.id}`, time: { created: 1 } }] },
      ])
    ),
  });
  stub.__setConfiguration('harnessCommands', { opencode: opencode.cli });
  const source = new OpencodeSessionSearch(new OpencodeSessionService(), { maxBytes: 500 });
  const cwd = tempDir(t, 'agntree-opencode-bytes-');

  const preparation = await source.prepare({ cwd, signal: new AbortController().signal });
  const dir = path.join(cwd, 'opencode-sessions');
  const files = fs.readdirSync(dir);
  const total = files.reduce((sum, file) => sum + fs.statSync(path.join(dir, file)).size, 0);
  assert.ok(files.length > 0, 'the newest session fits');
  assert.ok(files.length < sessions.length, 'the budget stops before every session is written');
  assert.ok(total <= 500, `the snapshot stays inside its cap (${total} bytes)`);
  assert.match(preparation.instructions, /reached its size budget/);
});

test('a Claude profile without its CLI is not an installed search runner', async (t) => {
  stub.__reset();
  const profile = claudeProfile(t);
  fs.mkdirSync(profile.projects, { recursive: true });
  stub.__setConfiguration('harnessCommands', {
    claude: path.join(tempDir(t, 'agntree-missing-'), 'claude'),
  });

  const harness = new ClaudeHarness({ sessionService: new ClaudeSessionService() });
  assert.equal(await harness.isInstalled(), true, 'a profile is enough to show sessions');
  assert.equal(
    await harness.sessionSearchRunner!.isAvailable!(),
    false,
    'but not enough to run a search'
  );
});

test('a search skips a runner whose CLI is missing even if its harness looks installed', async (t) => {
  stub.__reset();
  const runner = (available: boolean) => ({
    defaultModel: '',
    suggestedModels: [],
    efforts: ['low'],
    isAvailable: async () => available,
    run: async () => ({ reply: JSON.stringify({ answer: 'Nothing matched.', matches: [] }) }),
  });
  const registry = new HarnessRegistry([
    fakeAdapter('claude', { sessionSearchRunner: runner(false) }),
    fakeAdapter('codex', { sessionSearchRunner: runner(true) }),
  ]);
  stub.__setConfiguration('sessionSearch.harness', 'claude');
  const finder = new SessionSearchService(
    makeStorage(),
    registry,
    path.join(tempDir(t, 'agntree-available-'), 'scratch')
  );
  t.after(() => finder.dispose());

  assert.deepEqual(await finder.engine(), { harness: 'codex', model: '', effort: '' });
  await assert.rejects(
    () => finder.search('anything', { harness: 'claude', model: '', effort: '' }),
    /not installed/
  );
});

test('changing the harness clears a model and effort chosen for the previous one', async (t) => {
  stub.__reset();
  const runner = () => ({
    defaultModel: '',
    suggestedModels: [],
    efforts: ['low', 'high'],
    isAvailable: async () => true,
    run: async () => ({ reply: JSON.stringify({ answer: 'Nothing matched.', matches: [] }) }),
  });
  const registry = new HarnessRegistry([
    fakeAdapter('claude', { sessionSearchRunner: runner() }),
    fakeAdapter('codex', { sessionSearchRunner: runner() }),
  ]);
  const finder = new SessionSearchService(
    makeStorage(),
    registry,
    path.join(tempDir(t, 'agntree-engine-'), 'scratch')
  );
  t.after(() => finder.dispose());
  const config = vscode.workspace.getConfiguration('agntree');

  stub.__setConfiguration('sessionSearch.harness', 'claude');
  stub.__setConfiguration('sessionSearch.model', 'haiku');
  stub.__setConfiguration('sessionSearch.effort', 'high');
  assert.deepEqual(await finder.engine(), { harness: 'claude', model: 'haiku', effort: 'high' });

  // Only the harness changed: the choices belonged to Claude, not Codex.
  stub.__setConfiguration('sessionSearch.harness', 'codex');
  assert.deepEqual(await finder.engine(), { harness: 'codex', model: '', effort: '' });
  assert.equal(config.get('sessionSearch.model'), undefined);
  assert.equal(config.get('sessionSearch.effort'), undefined);

  // A harness and its own choices changed together are kept.
  stub.__setConfiguration('sessionSearch.harness', 'claude');
  stub.__setConfiguration('sessionSearch.model', 'sonnet');
  stub.__setConfiguration('sessionSearch.effort', 'low');
  assert.deepEqual(await finder.engine(), { harness: 'claude', model: 'sonnet', effort: 'low' });
});

test('a source that cannot prepare is dropped with a step, and the remaining source still answers', async (t) => {  stub.__reset();
  const prompts: string[] = [];
  const good = fakeAdapter('claude', {
    sessionSearch: {
      instructions: () => 'Search the fake Claude records.',
      readableDirs: () => [],
      verify: async () => null,
    },
    sessionSearchRunner: {
      defaultModel: 'small',
      suggestedModels: [],
      efforts: ['medium'],
      run: async (request) => {
        prompts.push(request.prompt);
        return {
          reply: JSON.stringify({ answer: 'Nothing matched.', matches: [] }),
        };
      },
    },
  });
  const bad = fakeAdapter('opencode', {
    sessionSearch: {
      prepare: async () => {
        throw new Error('opencode is not answering');
      },
      instructions: () => 'Search the fake opencode snapshot.',
      readableDirs: () => [],
      verify: async () => null,
    },
  });

  const storage = makeStorage();
  const registry = new HarnessRegistry([good, bad]);
  const finder = new SessionSearchService(
    storage,
    registry,
    path.join(tempDir(t, 'agntree-prepare-'), 'scratch')
  );
  t.after(() => finder.dispose());

  const engine = await finder.engine();
  const search = await finder.search('anything', engine!);

  assert.equal(search.state, 'done');
  assert.ok(
    search.activity.some((step) =>
      step.includes('Could not search opencode sessions: opencode is not answering')
    )
  );
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes('Search the fake Claude records.'));
  assert.equal(prompts[0].includes('Search the fake opencode snapshot.'), false);
  const schema = JSON.parse(prompts[0].slice(prompts[0].lastIndexOf('\n\n{') + 2));
  assert.deepEqual(
    schema.properties.matches.items.properties.harness.enum,
    ['claude'],
    'a harness that could not prepare is not offered in the answer'
  );
});
