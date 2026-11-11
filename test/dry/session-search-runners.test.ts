/**
 * The Find Session runners for Codex and Pi, against fake CLI processes.
 * Each proves the headless invocation, the follow-up in the same session,
 * the tool activity, and the reply it returns; no real harness is installed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { CodexSearchRunner } from '../../src/harnesses/codexSearch';
import { quoteForCmd } from '../../src/harnesses/commandUtils';
import { PiSearchRunner } from '../../src/harnesses/piSearch';
import { fakeCli, posixOnly, setEnv, tempDir } from './support';

const CODEX_SEARCH_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-codex-search.js');
const PI_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-pi-search.js');

interface CodexCall {
  args: string[];
  prompt: string;
}

interface CodexState {
  replies: string[];
  calls: CodexCall[];
  homes?: string[];
}

test('the Codex runner keeps the user config, disables MCP servers, and re-runs for a correction', posixOnly, async (t) => {
  const dir = tempDir(t, 'agntree-codex-run-');
  const cwd = path.join(dir, 'search');
  fs.mkdirSync(cwd);
  const sourceHome = tempDir(t, 'agntree-codex-source-');
  fs.writeFileSync(
    path.join(sourceHome, 'config.toml'),
    [
      'model = "configured-model"',
      '[mcp_servers.playwright]',
      'command = "npx"',
      '[mcp_servers.node_repl]',
      'command = "node"',
      '[mcp_servers."node.repl"]',
      'command = "node"',
      '[features]',
      'js_repl = false',
    ].join('\n')
  );
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ replies: ['not json', '{"matched":true}'], calls: [] })
  );
  const cli = fakeCli(dir, 'codex', CODEX_SEARCH_FIXTURE, { FAKE_CODEX_STATE: stateFile });
  setEnv(t, { CODEX_HOME: sourceHome });

  const activity: string[] = [];
  const runner = new CodexSearchRunner({
    command: () => cli,
    timeoutMs: 10_000,
  });
  const result = await runner.run({
    prompt: 'first question',
    model: '',
    effort: 'medium',
    cwd,
    readableDirs: [],
    signal: new AbortController().signal,
    onActivity: (step) => activity.push(step),
    followUp: (reply) => (reply === 'not json' ? 'fix the answer' : undefined),
  });

  assert.equal(result, '{"matched":true}');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as CodexState;
  const [first, second] = state.calls;
  const firstArgs = first.args;
  const secondArgs = second.args;
  assert.deepEqual(firstArgs.slice(0, 3), ['exec', '--ephemeral', '--skip-git-repo-check']);
  assert.equal(firstArgs[firstArgs.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(firstArgs.includes('--json'));
  assert.ok(!firstArgs.includes('--ignore-user-config'), 'the user config is loaded');
  assert.ok(!firstArgs.includes('--model'), 'the configured model is used');
  assert.ok(firstArgs.includes('model_reasoning_effort=medium'));
  assert.deepEqual(
    firstArgs.filter((arg) => arg.startsWith('mcp_servers.')),
    ['mcp_servers.playwright.enabled=false', 'mcp_servers.node_repl.enabled=false'],
    'every bare-named configured MCP server is off; a quoted name has no -c switch'
  );
  assert.ok(!firstArgs.includes('first question'), 'the prompt travels on stdin, not as a command argument');
  assert.equal(first.prompt, 'first question');
  for (const arg of firstArgs) {
    assert.doesNotThrow(() => quoteForCmd(arg), `${arg} must survive cmd.exe quoting`);
  }

  assert.deepEqual(secondArgs.slice(0, 3), ['exec', '--ephemeral', '--skip-git-repo-check'], 'an ephemeral run cannot resume');
  assert.ok(!secondArgs.includes('resume'));
  assert.ok(!secondArgs.includes('first question'));
  assert.ok(
    second.prompt.startsWith('first question\n\nYour previous reply was:\nnot json\n\nfix the answer'),
    'the correction carries the prompt and previous reply'
  );
  for (const arg of secondArgs) {
    assert.doesNotThrow(() => quoteForCmd(arg), `${arg} must survive cmd.exe quoting`);
  }

  assert.deepEqual(state.homes, [sourceHome, sourceHome], 'the real profile is used');
  assert.deepEqual(activity, ['Exec rg banana', 'Exec rg banana'], 'each run reports its tool call');
});

test('the Pi runner uses only read-only tools, keeps its session under the search cwd, and resumes it for a correction', posixOnly, async (t) => {
  const dir = tempDir(t, 'agntree-pi-run-');
  const cwd = path.join(dir, 'search');
  fs.mkdirSync(cwd);
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({ replies: ['not json', '{"matched":true}'], calls: [] })
  );
  const cli = fakeCli(dir, 'pi', PI_FIXTURE, { FAKE_PI_STATE: stateFile });

  const activity: string[] = [];
  const runner = new PiSearchRunner({ command: () => cli, timeoutMs: 10_000 });
  const result = await runner.run({
    prompt: 'first question',
    model: '',
    effort: 'medium',
    cwd,
    readableDirs: [],
    signal: new AbortController().signal,
    onActivity: (step) => activity.push(step),
    followUp: (reply) => (reply === 'not json' ? 'fix the answer' : undefined),
  });

  assert.equal(result, '{"matched":true}');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
    calls: Array<{ args: string[]; prompt: string }>;
  };
  const [first, second] = state.calls;
  const firstArgs = first.args;
  const secondArgs = second.args;
  const sessionId = firstArgs[firstArgs.indexOf('--session-id') + 1];
  assert.ok(sessionId, 'the first turn creates the search session');
  assert.equal(firstArgs.includes('--session'), false, 'the first turn creates rather than resumes');
  assert.equal(secondArgs[secondArgs.indexOf('--session') + 1], sessionId, 'the correction resumes the same session');
  assert.equal(secondArgs.includes('--session-id'), false);

  for (const args of [firstArgs, secondArgs]) {
    assert.equal(args[args.indexOf('--session-dir') + 1], path.join(cwd, 'pi-sessions'));
    assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
    assert.equal(args[args.indexOf('--exclude-tools') + 1], 'mcp__*', 'MCP tools are off; the rest of the config stays');
    assert.equal(args[args.indexOf('--thinking') + 1], 'medium');
    for (const flag of ['--no-extensions', '--no-skills', '--no-context-files', '--no-mcp']) {
      assert.ok(!args.includes(flag), `${flag} would discard the user's config`);
    }
    for (const arg of args) {
      assert.doesNotThrow(() => quoteForCmd(arg), `${arg} must survive cmd.exe quoting`);
    }
  }
  assert.ok(!firstArgs.includes('first question'), 'the prompt travels on stdin, not as a command argument');
  assert.equal(first.prompt, 'first question');
  assert.equal(second.prompt, 'fix the answer');
  assert.deepEqual(activity, ['Grep "banana"', 'Grep "banana"']);
  assert.equal(fs.existsSync(path.join(cwd, 'pi-sessions')), true, 'the isolated session dir is inside the search folder');
});
