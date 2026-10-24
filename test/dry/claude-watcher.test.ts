import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { ClaudeSessionWatcher } from '../../src/services/ClaudeSessionWatcher';
import { encodeClaudeProjectPath } from '../../src/utils/paths';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-claude-watcher-'));
const CONFIG_DIR = path.join(ROOT, 'config');
const PROJECTS = path.join(CONFIG_DIR, 'projects');
const WORKTREE = path.join(ROOT, 'worktree');
const WORKTREE_PROJECT = path.join(
  PROJECTS,
  encodeClaudeProjectPath(WORKTREE)
);

const SESSION_ONE = '11111111-2222-3333-4444-555555555555';
const SESSION_TWO = '66666666-7777-8888-9999-000000000000';
const SESSION_THREE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const IGNORED_SESSION = 'ffffffff-0000-1111-2222-333333333333';
const EMPTY_SESSION = '99999999-8888-7777-6666-555555555555';
const IDLE_SESSION = '12345678-1234-1234-1234-123456789012';
const ABANDONED_SESSION = '23456789-2345-2345-2345-234567890123';
const RESTORED_SESSION = '34567890-3456-3456-3456-345678901234';

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
    }, 100);
  });
}

function transcript(summary: string, prompt: string): string {
  return [
    JSON.stringify({
      type: 'user',
      cwd: WORKTREE,
      message: { role: 'user', content: prompt },
      timestamp: new Date().toISOString(),
    }),
    JSON.stringify({ type: 'summary', summary }),
  ].join('\n') + '\n';
}

async function main(): Promise<void> {
  fs.mkdirSync(WORKTREE_PROJECT, { recursive: true });
  fs.mkdirSync(WORKTREE, { recursive: true });

  const chats = new Map<string, any>();
  const addChat = (
    id: string,
    pending: string | null,
    options: {
      status?: 'active' | 'idle';
      harnessSessionId?: string;
    } = {}
  ): void => {
    chats.set(id, {
      id,
      worktreeId: 'wt-1',
      name: 'New Session',
      harness: 'claude',
      harnessSessionId: options.harnessSessionId ?? null,
      pendingHarnessSessionId: pending,
      status: options.status ?? 'active',
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      baseCommit: null,
    });
  };

  addChat('chat-1', SESSION_ONE);
  addChat('chat-2', SESSION_TWO);
  addChat('chat-3', SESSION_THREE);
  addChat('chat-4', null);
  addChat('chat-restored', null, {
    status: 'idle',
    harnessSessionId: RESTORED_SESSION,
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

  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;

  // An existing transcript must link immediately when the watcher starts.
  fs.writeFileSync(
    path.join(WORKTREE_PROJECT, `${SESSION_ONE}.jsonl`),
    transcript('Immediate summary', 'An existing first prompt')
  );
  // A linked chat restored with the default name is named on startup.
  fs.writeFileSync(
    path.join(WORKTREE_PROJECT, `${RESTORED_SESSION}.jsonl`),
    transcript('Restored summary', 'A restored prompt')
  );

  const watcher = new ClaudeSessionWatcher(
    storage as any,
    new ClaudeSessionService()
  );
  let nameEvent: { chatId: string; name: string } | null = null;
  watcher.onChatNameUpdated((event) => {
    nameEvent = event;
  });

  console.log('\n== immediate check on start ==');
  watcher.startWatching();
  const immediate = await waitFor(
    () => Boolean(chats.get('chat-1').harnessSessionId),
    2000
  );
  check(immediate, 'an existing pending transcript links immediately');
  check(
    chats.get('chat-1').harnessSessionId === SESSION_ONE,
    'the exact pending ID is linked'
  );
  check(
    !chats.get('chat-1').pendingHarnessSessionId,
    'the pending ID is cleared on link'
  );

  const renamed = await waitFor(
    () => chats.get('chat-1').name === 'Immediate summary',
    12000
  );
  check(renamed, `the chat was auto-renamed (${chats.get('chat-1').name})`);
  check(
    nameEvent !== null &&
      (nameEvent as any).chatId === 'chat-1' &&
      (nameEvent as any).name === 'Immediate summary',
    'onChatNameUpdated fired with the new name'
  );

  console.log('\n== exact ID across project directories ==');
  watcher.registerPendingChat('chat-2', WORKTREE);
  const otherProject = path.join(PROJECTS, 'a-different-project-dir');
  fs.mkdirSync(otherProject, { recursive: true });
  fs.writeFileSync(
    path.join(otherProject, `${SESSION_TWO}.jsonl`),
    transcript('Second summary', 'A second prompt')
  );
  const secondLinked = await waitFor(
    () => Boolean(chats.get('chat-2').harnessSessionId),
    12000
  );
  check(secondLinked, 'a later transcript is linked by polling or fs.watch');
  check(
    chats.get('chat-2').harnessSessionId === SESSION_TWO,
    'the transcript is found outside the worktree project dir'
  );

  console.log('\n== no directory matching ==');
  watcher.registerPendingChat('chat-3', WORKTREE);
  fs.writeFileSync(
    path.join(WORKTREE_PROJECT, `${IGNORED_SESSION}.jsonl`),
    transcript('Wrong session', 'Do not claim me')
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(
    chats.get('chat-3').harnessSessionId === null,
    'a session in the worktree directory is not claimed without its ID'
  );

  fs.writeFileSync(
    path.join(WORKTREE_PROJECT, `${SESSION_THREE}.jsonl`),
    transcript('Third summary', 'The right prompt')
  );
  const thirdLinked = await waitFor(
    () => Boolean(chats.get('chat-3').harnessSessionId),
    12000
  );
  check(thirdLinked, 'the correct pending ID links');
  check(
    chats.get('chat-3').harnessSessionId === SESSION_THREE,
    'the exact ID wins over directory proximity'
  );

  console.log('\n== chats without a pending ID ==');
  watcher.registerPendingChat('chat-4', WORKTREE);
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(
    chats.get('chat-4').harnessSessionId === null,
    'a chat without a pending ID is ignored'
  );

  console.log('\n== transcript without messages ==');
  addChat('chat-empty', EMPTY_SESSION);
  watcher.registerPendingChat('chat-empty', WORKTREE);
  fs.writeFileSync(path.join(WORKTREE_PROJECT, `${EMPTY_SESSION}.jsonl`), '');
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(
    chats.get('chat-empty').harnessSessionId === null,
    'an empty transcript is not linked'
  );
  check(
    chats.get('chat-empty').pendingHarnessSessionId === EMPTY_SESSION,
    'the pending ID is kept until the first message'
  );
  fs.appendFileSync(
    path.join(WORKTREE_PROJECT, `${EMPTY_SESSION}.jsonl`),
    JSON.stringify({
      type: 'user',
      cwd: WORKTREE,
      message: { role: 'user', content: 'First real prompt' },
      timestamp: new Date().toISOString(),
    }) + '\n'
  );
  const emptyLinked = await waitFor(
    () => Boolean(chats.get('chat-empty').harnessSessionId),
    12000
  );
  check(emptyLinked, 'the first message links the chat');

  console.log('\n== idle chat naming ==');
  addChat('chat-idle', IDLE_SESSION, { status: 'idle' });
  watcher.registerPendingChat('chat-idle', WORKTREE);
  fs.writeFileSync(
    path.join(WORKTREE_PROJECT, `${IDLE_SESSION}.jsonl`),
    transcript('Idle summary', 'An idle prompt')
  );
  const idleLinked = await waitFor(
    () => Boolean(chats.get('chat-idle').harnessSessionId),
    12000
  );
  check(idleLinked, 'a chat whose terminal is not active still links');
  const idleRenamed = await waitFor(
    () => chats.get('chat-idle').name === 'Idle summary',
    12000
  );
  check(idleRenamed, 'a chat whose terminal is not active is still named');

  console.log('\n== abandoned pending chat ==');
  addChat('chat-abandoned', ABANDONED_SESSION, { status: 'idle' });
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    watcher.registerPendingChat('chat-abandoned', WORKTREE);
    await new Promise((resolve) => setTimeout(resolve, 200));
    fakeNow += 5 * 60_000 + 1;
    fs.writeFileSync(
      path.join(WORKTREE_PROJECT, `${ABANDONED_SESSION}.jsonl`),
      transcript('Too late', 'A late prompt')
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    check(
      chats.get('chat-abandoned').harnessSessionId === null,
      'a closed chat past the TTL is not linked'
    );
  } finally {
    Date.now = realNow;
  }

  watcher.registerPendingChat('chat-abandoned', WORKTREE);
  const reopened = await waitFor(
    () => Boolean(chats.get('chat-abandoned').harnessSessionId),
    12000
  );
  check(reopened, 'reopening the chat starts a new window and links');

  console.log('\n== restored linked chat ==');
  const restoredRenamed = await waitFor(
    () => chats.get('chat-restored').name === 'Restored summary',
    12000
  );
  check(restoredRenamed, 'a restored chat with the default name is renamed');

  watcher.dispose();
  check(true, 'watcher disposed cleanly');

  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });

  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE WATCHER CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
