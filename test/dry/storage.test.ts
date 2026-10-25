import * as vscode from 'vscode';
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

  console.log('\n== terminal pid records ==');
  {
    const globalValues = new Map<string, unknown>();
    const workspaceValues = new Map<string, unknown>();
    const pidContext = {
      globalState: {
        get: (key: string, fallback: unknown) =>
          globalValues.has(key) ? globalValues.get(key) : fallback,
        update: async (key: string, value: unknown) => {
          if (value === undefined) {
            globalValues.delete(key);
          } else {
            globalValues.set(key, value);
          }
        },
      },
      workspaceState: {
        get: (key: string, fallback: unknown) =>
          workspaceValues.has(key) ? workspaceValues.get(key) : fallback,
        update: async (key: string, value: unknown) => {
          if (value === undefined) {
            workspaceValues.delete(key);
          } else {
            workspaceValues.set(key, value);
          }
        },
      },
      subscriptions: [],
    };
    const pidService = new StorageService(pidContext as any);
    const setFolder = (folder: string) => {
      (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: folder } }];
    };

    setFolder('/workspace/a');
    await pidService.rememberTerminalPid('chat-a', 111);
    check(
      pidService.getTerminalPids()['chat-a'] === 111,
      'a terminal pid is recorded for the open workspace'
    );

    // The workspace switch clears VS Code's workspace store; the record must
    // survive it in global state.
    setFolder('/workspace/b');
    check(
      Object.keys(pidService.getTerminalPids()).length === 0,
      'another workspace does not see the first workspace record'
    );
    await pidService.rememberTerminalPid('chat-b', 222);

    setFolder('/workspace/a');
    check(
      pidService.getTerminalPids()['chat-a'] === 111 &&
        !('chat-b' in pidService.getTerminalPids()),
      'returning to a workspace sees its own pid again'
    );
    check(
      !workspaceValues.has('agntree.terminalPids'),
      'terminal pids are not written to workspace state'
    );
    const stored = globalValues.get('agntree.terminalPids') as Record<
      string,
      Record<string, number>
    >;
    check(
      stored['/workspace/a']['chat-a'] === 111 &&
        stored['/workspace/b']['chat-b'] === 222,
      'global state keeps records for both workspaces'
    );

    // Development builds stored one workspace's map directly in workspaceState.
    setFolder('/workspace/legacy');
    workspaceValues.set('agntree.terminalPids', { 'chat-legacy': 999 });
    check(
      pidService.getTerminalPids()['chat-legacy'] === 999,
      'a legacy workspace-scoped pid record is read'
    );
    check(
      !workspaceValues.has('agntree.terminalPids'),
      'the legacy record is removed after migration'
    );
    check(
      (
        globalValues.get('agntree.terminalPids') as Record<
          string,
          Record<string, number>
        >
      )['/workspace/legacy']['chat-legacy'] === 999,
      'the legacy record is written to global state'
    );

    pidService.deleteChat('chat-a');
    check(
      !(
        globalValues.get('agntree.terminalPids') as Record<
          string,
          Record<string, number>
        >
      )['/workspace/a']['chat-a'],
      'deleting a chat forgets its pid in every workspace'
    );
  }

  console.log(`\n${failures === 0 ? 'ALL STORAGE CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
