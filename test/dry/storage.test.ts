import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStorage, memento, stub } from './support';
import { STORAGE_KEYS } from '../../src/types';

test('chats written before multi-harness support migrate on read, once', async () => {
  const globalState = memento();
  await globalState.update(STORAGE_KEYS.CHATS, [
    {
      id: 'legacy',
      worktreeId: 'wt-1',
      name: 'Legacy',
      claudeSessionId: 'legacy-claude-session',
      createdAt: 1,
      lastAccessedAt: 1,
      status: 'idle',
    },
  ]);
  let writes = 0;
  const update = globalState.update;
  globalState.update = async (key, value) => {
    writes++;
    return update(key, value);
  };
  const storage = makeStorage(globalState);

  const [chat] = storage.getChats();
  assert.equal(chat.harness, 'claude');
  assert.equal(chat.harnessSessionId, 'legacy-claude-session');
  assert.ok(!('claudeSessionId' in chat), 'the legacy field is dropped');
  assert.equal(writes, 1, 'the new shape is written back');

  storage.getChats();
  assert.equal(writes, 1, 'an already-migrated list is not rewritten');
});

test('repositories reorder past legacy hidden entries, and re-adding a hidden root shows it', async () => {
  const globalState = memento();
  // Older versions soft-removed a root with `hidden`; the flag is still read.
  await globalState.update(STORAGE_KEYS.REPOSITORIES, [
    { id: 'a', name: 'a', rootPath: '/a' },
    { id: 'h', name: 'hidden', rootPath: '/hidden', hidden: true },
    { id: 'c', name: 'c', rootPath: '/c' },
  ]);
  const storage = makeStorage(globalState);
  const visible = () => storage.getRepositories().map((repo) => repo.name).join(',');

  assert.equal(visible(), 'a,c');
  assert.equal(storage.moveRepository('c', 'down'), false, 'the last root cannot move down');
  assert.equal(storage.moveRepository('c', 'up'), true);
  assert.equal(visible(), 'c,a');
  assert.equal(storage.moveRepository('c', 'up'), false, 'the first root cannot move up');
  assert.equal(storage.moveRepository('missing', 'up'), false);
  assert.deepEqual(
    globalState.get<{ name: string }[]>(STORAGE_KEYS.REPOSITORIES).map((repo) => repo.name),
    ['c', 'hidden', 'a'],
    'the stored array is the tree order, hidden entries in place'
  );

  assert.equal(storage.addRepository('hidden', '/hidden').id, 'h', 'the stored root is reused');
  assert.equal(visible(), 'c,hidden,a');
});

test('terminal PIDs are kept per workspace folder in global state', async () => {
  const globalState = memento();
  const workspaceState = memento();
  const storage = makeStorage(globalState, workspaceState);
  const openFolder = (folder: string) => {
    stub.workspace.workspaceFolders = [{ uri: { fsPath: folder } }];
  };

  openFolder('/workspace/a');
  await storage.rememberTerminalPid('chat-a', 111);
  // Switching folders gives VS Code a fresh workspace store; the record must
  // survive that, but stay scoped to the folder that launched the terminal.
  openFolder('/workspace/b');
  assert.deepEqual(storage.getTerminalPids(), {});
  await storage.rememberTerminalPid('chat-b', 222);
  openFolder('/workspace/a');
  assert.deepEqual(storage.getTerminalPids(), { 'chat-a': 111 });
  assert.equal(workspaceState.get(STORAGE_KEYS.TERMINAL_PIDS), undefined);

  // Development builds stored one workspace's map in workspaceState.
  openFolder('/workspace/legacy');
  await workspaceState.update(STORAGE_KEYS.TERMINAL_PIDS, { 'chat-legacy': 999 });
  assert.deepEqual(storage.getTerminalPids(), { 'chat-legacy': 999 });
  assert.equal(workspaceState.get(STORAGE_KEYS.TERMINAL_PIDS), undefined, 'the legacy record moves');

  storage.deleteChat('chat-a');
  const records = globalState.get<Record<string, Record<string, number>>>(STORAGE_KEYS.TERMINAL_PIDS);
  assert.deepEqual(records['/workspace/a'], {}, 'deleting a chat forgets its PID everywhere');
  assert.deepEqual(records['/workspace/b'], { 'chat-b': 222 });
});

test('a user removal leaves a tombstone; a retention delete and a manual import do not', () => {
  const storage = makeStorage();
  const removed = storage.createChat('wt-1', 'codex', 'Removed', { harnessSessionId: 'thread-1' });
  const expired = storage.createChat('wt-1', 'codex', 'Expired', { harnessSessionId: 'thread-2' });

  storage.deleteChat(removed.id);
  storage.deleteChats([expired.id], { rememberSession: false });
  assert.deepEqual([...storage.getRemovedSessionKeys()], ['codex:thread-1']);

  storage.forgetRemovedSession('codex', 'thread-1');
  assert.equal(storage.getRemovedSessionKeys().size, 0);
});
