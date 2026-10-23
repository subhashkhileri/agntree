import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { OpencodeHarness } from '../../src/harnesses/OpencodeHarness';
import { OpencodeSessionWatcher } from '../../src/services/OpencodeSessionWatcher';

const WORKTREE = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-opencode-watcher-'));
let failures = 0;
const createdSessionIds: string[] = [];

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function createSession(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'opencode',
      [
        'api',
        'session.create',
        '--data',
        JSON.stringify({
          title: 'agntree watcher scratch',
          location: { directory: WORKTREE },
        }),
      ],
      { cwd: WORKTREE, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\n${stderr}`));
          return;
        }
        try {
          resolve((JSON.parse(stdout) as { data: { id: string } }).data.id);
        } catch (parseError) {
          reject(parseError);
        }
      }
    );
  });
}

function deleteSession(id: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'opencode',
      ['session', 'delete', id],
      { cwd: WORKTREE, timeout: 30000 },
      () => resolve()
    );
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
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
    }, 200);
  });
}

async function main(): Promise<void> {
  const chats = new Map<string, any>();
  chats.set('chat-oc-1', {
    id: 'chat-oc-1',
    worktreeId: 'wt-1',
    name: 'New Session',
    harness: 'opencode',
    harnessSessionId: null,
    status: 'active',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    baseCommit: null,
  });

  const storage = {
    getChat: (id: string) => chats.get(id),
    getChats: () => Array.from(chats.values()),
    updateChat: (id: string, updates: Record<string, unknown>) => {
      const chat = chats.get(id);
      if (chat) Object.assign(chat, updates);
      return chat;
    },
    renameChat: (id: string, name: string) => {
      const chat = chats.get(id);
      if (chat) chat.name = name;
    },
  };

  const harness = new OpencodeHarness();
  const watcher = new OpencodeSessionWatcher(storage as any, harness);
  let nameEvent: { chatId: string; name: string } | null = null;
  watcher.onChatNameUpdated((event) => {
    nameEvent = event;
  });

  console.log('\n== opencode watcher ==');
  watcher.startWatching();
  watcher.registerPendingChat('chat-oc-1', WORKTREE);
  check(true, 'watcher started and registered a pending opencode chat');

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const sessionId = await createSession();
  createdSessionIds.push(sessionId);
  console.log(`      created scratch session ${sessionId}`);

  const linked = await waitFor(
    () => Boolean(chats.get('chat-oc-1').harnessSessionId),
    12000
  );
  check(
    linked,
    `chat.harnessSessionId was linked (${chats.get('chat-oc-1').harnessSessionId})`
  );
  check(
    chats.get('chat-oc-1').harnessSessionId === sessionId,
    'linked to the newly created opencode session'
  );
  check(chats.get('chat-oc-1').harness === 'opencode', 'chat harness remains opencode');

  const renamed = await waitFor(
    () => chats.get('chat-oc-1').name !== 'New Session',
    8000
  );
  check(renamed, `chat was auto-renamed (${chats.get('chat-oc-1').name})`);
  check(
    chats.get('chat-oc-1').name === 'agntree watcher scratch',
    'renamed from the opencode title'
  );
  check(nameEvent !== null, 'onChatNameUpdated fired');

  watcher.dispose();
  check(true, 'watcher disposed cleanly');

  for (const id of createdSessionIds) {
    await deleteSession(id);
  }
  createdSessionIds.length = 0;
  fs.rmSync(WORKTREE, { recursive: true, force: true });

  console.log(
    `\n${failures === 0 ? 'ALL OPENCODE WATCHER CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error('UNEXPECTED FAILURE', error);
  for (const id of createdSessionIds) {
    await deleteSession(id).catch(() => undefined);
  }
  process.exit(1);
});
