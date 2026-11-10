/**
 * The JSON-RPC client for `codex app-server`, driven against a fake server
 * process from `fixtures/`. No Codex CLI is needed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { CODEX_APP_SERVER_ARGS, CodexAppServer, CodexAppServerError } from '../../src/services/CodexAppServer';
import { waitFor } from './support';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'fake-codex-app-server.js');

function client(t: { after(fn: () => void): void }, options: { idleTimeoutMs?: number; args?: string[] } = {}) {
  const server = new CodexAppServer({
    command: process.execPath,
    args: options.args ?? [FIXTURE],
    requestTimeoutMs: 2_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 0,
  });
  t.after(() => server.dispose());
  return server;
}
const pid = async (server: CodexAppServer) => (await server.request<{ pid: number }>('test/pid', {})).pid;

test('one lazily started server answers typed and concurrent requests by request ID', async (t) => {
  const server = client(t);
  assert.equal(server.isRunning, false, 'nothing starts until the first request');
  const threads = await server.listThreads({ useStateDbOnly: true });
  assert.deepEqual(threads.data.map((thread) => thread.id), ['thread-1', 'thread-older']);

  const echoed = await Promise.all([1, 2, 3, 4, 5].map((n) => server.request<{ params: { n: number } }>('test/echo', { n })));
  assert.deepEqual(echoed.map((response) => response.params.n), [1, 2, 3, 4, 5]);
});

test('a fork lands in the requested cwd and releases its writer lock for the terminal', async (t) => {
  const server = client(t);
  const fork = await server.forkThread('thread-1', '/tmp/fork-target');
  assert.match(fork.id, /^fork-/);
  assert.equal(fork.cwd, '/tmp/fork-target');
  assert.equal((await server.request<{ count: number }>('test/unsubscribe-count', {})).count, 1);
  assert.ok(CODEX_APP_SERVER_ARGS.includes('thread_unload_delay_secs=0'), 'the private server unloads immediately');
});

test('server errors keep their JSON-RPC code, and a hung request times out', async (t) => {
  const server = client(t);
  await assert.rejects(server.request('test/error', {}), /method not found/);
  await assert.rejects(
    server.request('does/not/exist', {}),
    (error: unknown) => error instanceof CodexAppServerError && error.code === -32601
  );
  await assert.rejects(server.request('test/hang', {}, 200), /timed out after 200ms/);
});

test('an exited or idle server is replaced by a new process on the next request', async (t) => {
  const server = client(t);
  const first = await pid(server);
  await server.request('test/exit', {});
  await waitFor(() => !server.isRunning, 'the exit to be noticed');
  assert.notEqual(await pid(server), first);

  const idle = client(t, { idleTimeoutMs: 150 });
  const before = await pid(idle);
  await waitFor(() => !idle.isRunning, 'the idle shutdown');
  assert.notEqual(await pid(idle), before);
});

test('a failed start backs off instead of respawning per request; dispose rejects later requests', async (t) => {
  const failing = client(t, { args: ['-e', 'process.exit(1)'] });
  await assert.rejects(failing.request('test/pid', {}), /Codex app-server/);
  const retried = Date.now();
  await assert.rejects(failing.request('test/pid', {}), /unavailable/);
  assert.ok(Date.now() - retried < 1_000, 'the second call fails fast');

  const server = client(t);
  await pid(server);
  server.dispose();
  assert.equal(server.isRunning, false);
  await assert.rejects(server.request('test/pid', {}), /was disposed/);
});
