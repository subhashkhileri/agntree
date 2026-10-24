import { CodexSessionWatcher } from '../../src/services/CodexSessionWatcher';
import { HarnessAdapter, HarnessSession } from '../../src/harnesses/types';

const WORKTREE = '/repo/wt-codex';
let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 4_000
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
    }, 20);
  });
}

function session(
  sessionId: string,
  summary: string,
  updatedAt = Date.now()
): HarnessSession {
  return {
    harness: 'codex',
    sessionId,
    cwd: WORKTREE,
    summary,
    gitBranch: 'main',
    lastUpdated: new Date(updatedAt),
    lastActivity: updatedAt,
    messageCount: 0,
  };
}

async function main(): Promise<void> {
  const chats = new Map<string, any>();
  chats.set('chat-codex-1', {
    id: 'chat-codex-1',
    worktreeId: 'wt-1',
    name: 'New Session',
    harness: 'codex',
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

  const sessions: HarnessSession[] = [];
  const fakeHarness = {
    listSessionsForWorktree: async () => [...sessions],
  } as unknown as HarnessAdapter;

  const watcher = new CodexSessionWatcher(storage as any, fakeHarness, {
    pollIntervalMs: 50,
  });
  let nameEvent: { chatId: string; name: string } | null = null;
  watcher.onChatNameUpdated((event) => {
    nameEvent = event;
  });

  console.log('\n== new chat links a new thread ==');
  watcher.startWatching();
  await watcher.registerPendingChat('chat-codex-1', WORKTREE);

  sessions.push(session('thread-new', 'Add Codex support'));
  check(
    await waitFor(() => Boolean(chats.get('chat-codex-1').harnessSessionId)),
    'pending chat was linked'
  );
  check(
    chats.get('chat-codex-1').harnessSessionId === 'thread-new',
    `linked to the new thread (${chats.get('chat-codex-1').harnessSessionId})`
  );
  check(
    chats.get('chat-codex-1').harness === 'codex',
    'chat harness remains codex'
  );
  check(
    await waitFor(() => chats.get('chat-codex-1').name !== 'New Session'),
    'chat was auto-renamed'
  );
  check(
    chats.get('chat-codex-1').name === 'Add Codex support',
    `renamed from the thread name (${chats.get('chat-codex-1').name})`
  );
  check(nameEvent !== null, 'onChatNameUpdated fired');
  watcher.dispose();

  console.log('\n== stale threads are never claimed ==');
  const secondWatcher = new CodexSessionWatcher(storage as any, fakeHarness, {
    pollIntervalMs: 50,
  });
  chats.set('chat-codex-2', {
    id: 'chat-codex-2',
    worktreeId: 'wt-1',
    name: 'New Session',
    harness: 'codex',
    harnessSessionId: null,
    status: 'active',
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    baseCommit: null,
  });
  secondWatcher.startWatching();
  await secondWatcher.registerPendingChat('chat-codex-2', WORKTREE);

  // Snapshot includes thread-new. A later session is the only valid match.
  sessions.push(session('thread-newer', 'A newer thread', Date.now() + 10));

  check(
    await waitFor(() => Boolean(chats.get('chat-codex-2').harnessSessionId)),
    'second pending chat was linked'
  );
  check(
    chats.get('chat-codex-2').harnessSessionId === 'thread-newer',
    `linked to the newest unseen thread (${chats.get('chat-codex-2').harnessSessionId})`
  );
  check(
    chats.get('chat-codex-1').harnessSessionId === 'thread-new',
    'the existing chat kept its own thread'
  );
  check(
    await waitFor(() => chats.get('chat-codex-2').name === 'A newer thread'),
    'second chat was renamed'
  );

  secondWatcher.dispose();
  console.log(
    `\n${failures === 0 ? 'ALL CODEX WATCHER CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
