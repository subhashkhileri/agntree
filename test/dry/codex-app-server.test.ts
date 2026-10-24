import * as path from 'path';
import {
  CodexAppServer,
  CodexAppServerError,
} from '../../src/services/CodexAppServer';

const FIXTURE = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'fake-codex-app-server.js'
);

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function makeClient(
  overrides: {
    requestTimeoutMs?: number;
    idleTimeoutMs?: number;
  } = {}
): CodexAppServer {
  return new CodexAppServer({
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 2_000,
    idleTimeoutMs: 0,
    ...overrides,
  });
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 10);
  });
}

async function expectReject(
  promise: Promise<unknown>,
  includes: string
): Promise<void> {
  try {
    await promise;
    check(false, `expected rejection containing "${includes}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(
      message.includes(includes),
      `rejection contains "${includes}": ${message}`
    );
  }
}

async function main(): Promise<void> {
  console.log('\n== handshake + typed helpers ==');
  const client = makeClient();
  const threads = await client.listThreads({ useStateDbOnly: true });
  check(threads.data.length === 2, 'thread/list returns rows');
  check(threads.data[0]?.id === 'thread-1', 'thread IDs are mapped');
  check(
    client.serverInfo?.platformOs === 'test',
    'initialize result is exposed as serverInfo'
  );

  const read = await client.readThread('thread-1');
  check(read.thread.cwd.length > 0, 'thread/read returns the thread cwd');
  check(
    read.thread.gitInfo?.branch === 'main',
    'thread/read keeps git branch metadata'
  );

  const items = await client.listItems('thread-1', {
    limit: 4,
    sortDirection: 'desc',
  });
  check(items.data.length === 4, 'thread/items/list returns items');
  check(
    items.data[0]?.item.type === 'agentMessage',
    'items are newest-first with sortDirection=desc'
  );

  const fork = await client.forkThread('thread-1', '/tmp/fork-target');
  check(fork.id.startsWith('fork-'), `thread/fork returns a new ID: ${fork.id}`);
  check(fork.cwd === '/tmp/fork-target', 'thread/fork uses the requested cwd');

  await client.deleteThread(fork.id);
  await expectReject(client.readThread(fork.id), 'thread not found');

  console.log('\n== concurrent requests ==');
  const echoed = await Promise.all(
    [1, 2, 3, 4, 5].map((n) => client.request<any>('test/echo', { n }))
  );
  check(
    echoed.every((response, index) => response.params?.n === index + 1),
    'concurrent responses are matched by request ID'
  );

  console.log('\n== errors and timeouts ==');
  await expectReject(
    client.request('test/error', {}),
    'method not found'
  );
  await expectReject(
    client.request('test/hang', {}, 200),
    'timed out after 200ms'
  );
  try {
    await client.request('does/not/exist', {});
    check(false, 'unknown methods reject');
  } catch (error) {
    check(
      error instanceof CodexAppServerError && error.code === -32601,
      'unknown methods surface the JSON-RPC code'
    );
  }

  console.log('\n== restart after exit ==');
  const firstPid = (await client.request<any>('test/pid', {})).pid;
  await client.request('test/exit', {});
  check(
    await waitFor(() => !client.isRunning),
    'the client notices the server exit'
  );
  const secondPid = (await client.request<any>('test/pid', {})).pid;
  check(
    secondPid !== firstPid,
    `a new process is started on the next request (${firstPid} -> ${secondPid})`
  );
  client.dispose();

  console.log('\n== idle shutdown ==');
  const idleClient = makeClient({ idleTimeoutMs: 150 });
  const idleFirstPid = (await idleClient.request<any>('test/pid', {})).pid;
  check(idleClient.isRunning, 'the server is running after a request');
  check(
    await waitFor(() => !idleClient.isRunning, 2_000),
    'the server stops after the idle period'
  );
  const idleSecondPid = (await idleClient.request<any>('test/pid', {})).pid;
  check(
    idleSecondPid !== idleFirstPid,
    'the next request lazily starts a new server'
  );
  idleClient.dispose();

  console.log('\n== failed start backoff ==');
  const failing = new CodexAppServer({
    command: process.execPath,
    args: ['-e', 'process.exit(1)'],
    requestTimeoutMs: 2_000,
    idleTimeoutMs: 0,
  });
  await expectReject(failing.request('test/pid', {}), 'Codex app-server');
  const retryStarted = Date.now();
  await expectReject(failing.request('test/pid', {}), 'unavailable');
  check(
    Date.now() - retryStarted < 1_000,
    'a failed start is not retried immediately'
  );
  failing.dispose();

  console.log('\n== dispose ==');
  const disposed = makeClient();
  await disposed.request('test/pid', {});
  disposed.dispose();
  check(!disposed.isRunning, 'dispose stops the server');
  await expectReject(disposed.request('test/pid', {}), 'was disposed');

  console.log(
    `\n${failures === 0 ? 'ALL CODEX APP-SERVER CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
