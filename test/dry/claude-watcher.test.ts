import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeSessionWatcher } from '../../src/services/ClaudeSessionWatcher';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-claude-watcher-'));
const HOME = path.join(ROOT, 'home');
const WORKTREE = path.join(ROOT, 'worktree');
const encodeProjectPath = (value: string): string =>
  path.resolve(value).replace(/[/\\.]/g, '-');
const PROJECT_DIR = path.join(
  HOME,
  '.claude',
  'projects',
  encodeProjectPath(WORKTREE)
);
const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
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
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.mkdirSync(WORKTREE, { recursive: true });

  const chats = new Map<string, any>();
  chats.set('chat-1', {
    id: 'chat-1',
    worktreeId: 'wt-1',
    name: 'New Session',
    harness: 'claude',
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

  const previousHome = process.env.HOME;
  process.env.HOME = HOME;

  const watcher = new ClaudeSessionWatcher(storage as any);
  let nameEvent: { chatId: string; name: string } | null = null;
  watcher.onChatNameUpdated((event) => {
    nameEvent = event;
  });

  console.log('\n== watcher startup ==');
  watcher.startWatching();
  watcher.registerPendingChat('chat-1', WORKTREE);
  check(true, 'watcher started and registered a pending chat');

  await new Promise((resolve) => setTimeout(resolve, 300));
  const filePath = path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`);
  const lines = [
    {
      type: 'user',
      message: { role: 'user', content: 'Dry test first prompt' },
      timestamp: new Date().toISOString(),
    },
    { type: 'summary', summary: 'Dry test session name' },
  ];
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);

  console.log('\n== linkage + auto-name ==');
  const linked = await waitFor(() => Boolean(chats.get('chat-1').harnessSessionId), 12000);
  check(linked, `chat.harnessSessionId was linked (${chats.get('chat-1').harnessSessionId})`);
  check(
    chats.get('chat-1').harnessSessionId === SESSION_ID,
    'linked to the newly created session'
  );
  check(chats.get('chat-1').harness === 'claude', 'chat harness remains claude');

  const renamed = await waitFor(
    () => chats.get('chat-1').name !== 'New Session',
    12000
  );
  check(renamed, `chat was auto-renamed (${chats.get('chat-1').name})`);
  check(chats.get('chat-1').name === 'Dry test session name', 'renamed from the summary entry');
  check(nameEvent !== null, 'onChatNameUpdated fired');
  if (nameEvent) {
    check(
      (nameEvent as any).chatId === 'chat-1' &&
        (nameEvent as any).name === 'Dry test session name',
      'name event payload is correct'
    );
  }

  console.log('\n== ignore already-linked sessions ==');
  chats.set('chat-2', {
    id: 'chat-2',
    worktreeId: 'wt-1',
    name: 'New Session',
    harness: 'claude',
    harnessSessionId: null,
    status: 'active',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    baseCommit: null,
  });
  watcher.registerPendingChat('chat-2', WORKTREE);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const secondId = '66666666-7777-8888-9999-000000000000';
  fs.writeFileSync(
    path.join(PROJECT_DIR, `${secondId}.jsonl`),
    `${JSON.stringify({ type: 'summary', summary: 'Second session name' })}\n`
  );
  const secondLinked = await waitFor(
    () => Boolean(chats.get('chat-2').harnessSessionId),
    12000
  );
  check(secondLinked, `second chat linked (${chats.get('chat-2').harnessSessionId})`);
  check(chats.get('chat-2').harnessSessionId === secondId, 'second chat got the new session');

  watcher.dispose();
  check(true, 'watcher disposed cleanly');

  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE WATCHER CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
