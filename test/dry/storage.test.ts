import { StorageService } from '../../src/services/StorageService';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

async function main(): Promise<void> {
  const legacyChat = {
    id: 'chat-legacy',
    worktreeId: 'wt-1',
    name: 'Legacy session',
    createdAt: 1,
    lastAccessedAt: 2,
    status: 'idle',
    baseCommit: null,
    claudeSessionId: 'legacy-claude-session',
  };

  let stored: any[] = [legacyChat];
  const updates: any[] = [];
  const context = {
    globalState: {
      get: (key: string, fallback: unknown) =>
        key === 'agntree.chats' ? stored : fallback,
      update: async (key: string, value: any[]) => {
        if (key === 'agntree.chats') {
          stored = value;
          updates.push(value);
        }
      },
      keys: () => [],
    },
    subscriptions: [],
  };

  console.log('\n== storage migration ==');
  const service = new StorageService(context as any);
  const chats = service.getChats();

  check(chats.length === 1, 'legacy chat is read');
  check(chats[0].harness === 'claude', 'legacy chat migrates to the claude harness');
  check(
    chats[0].harnessSessionId === 'legacy-claude-session',
    'claudeSessionId migrates to harnessSessionId'
  );
  check(!('claudeSessionId' in chats[0]), 'legacy field is removed from the returned chat');
  check(updates.length === 1, 'migrated chats are persisted once');

  console.log('\n== new chats ==');
  const claudeChat = service.createChat('wt-1', 'New Claude');
  check(claudeChat.harness === 'claude', 'createChat defaults to claude');
  check(claudeChat.harnessSessionId === null, 'new claude chat has no session yet');

  const opencodeChat = service.createChat('wt-1', 'New opencode', null, 'opencode');
  check(opencodeChat.harness === 'opencode', 'createChat accepts opencode');
  check(opencodeChat.harnessSessionId === null, 'new opencode chat has no session yet');

  service.updateChat(opencodeChat.id, { harnessSessionId: 'ses_test' });
  check(
    service.getChat(opencodeChat.id)?.harnessSessionId === 'ses_test',
    'updateChat persists a harness session id'
  );

  console.log('\n== idempotent migration ==');
  const before = updates.length;
  const reread = service.getChats();
  check(reread.length === 3, 'all chats are returned');
  check(updates.length === before, 'already-migrated chats are not rewritten');
  check(
    reread.every((chat) => chat.harness && chat.harnessSessionId !== undefined),
    'every chat has the new shape'
  );

  console.log(`\n${failures === 0 ? 'ALL STORAGE CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
