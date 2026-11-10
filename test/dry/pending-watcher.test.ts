/**
 * Linkage for harnesses that assign session IDs in their own process (Codex,
 * opencode): the watcher snapshots the worktree's sessions at launch and
 * claims the first one that appears afterwards. Fake adapters stand in for
 * the CLIs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexSessionWatcher } from '../../src/services/CodexSessionWatcher';
import { OpencodeSessionWatcher } from '../../src/services/OpencodeSessionWatcher';
import { HarnessSession } from '../../src/harnesses/types';
import { HarnessId } from '../../src/types';
import { fakeAdapter, makeStorage, sessionRecord, waitFor } from './support';

function setup(harness: HarnessId, t: { after(fn: () => void): void }, prompt = '') {
  const storage = makeStorage();
  const sessions: HarnessSession[] = [];
  let polls = 0;
  const adapter = fakeAdapter(harness, {
    listSessionsForWorktree: async () => {
      polls++;
      return [...sessions];
    },
    getPreview: async () => (prompt ? [{ text: prompt, timestamp: 1 }] : []),
  });
  const Watcher = harness === 'codex' ? CodexSessionWatcher : OpencodeSessionWatcher;
  const watcher = new Watcher(storage, adapter, { pollIntervalMs: 10 });
  t.after(() => watcher.dispose());
  const names: string[] = [];
  watcher.onChatNameUpdated((event) => names.push(event.name));
  const launch = async () => {
    const chat = storage.createChat('wt-1', harness, 'New Session');
    await watcher.registerPendingChat(chat.id, '/repo');
    return chat.id;
  };
  const appear = (sessionId: string, summary: string | null, offsetMs = 0) =>
    sessions.push(sessionRecord(harness, sessionId, { summary, lastUpdated: new Date(Date.now() + offsetMs) }));
  const chat = (chatId: string) => storage.getChat(chatId)!;
  return { sessions, names, launch, appear, chat, polls: () => polls };
}

test('a launch claims the session that appears after it, never one that existed, and takes its title', async (t) => {
  const { names, launch, appear, chat } = setup('codex', t);
  appear('thread-existing', 'Already here');
  const chatId = await launch();
  appear('thread-new', 'Add Codex support', 10);

  await waitFor(() => chat(chatId).name === 'Add Codex support', 'the link and rename');
  assert.equal(chat(chatId).harnessSessionId, 'thread-new');
  assert.deepEqual(names, ['Add Codex support']);
});

test('two launches in one worktree are linked in launch order', async (t) => {
  const { launch, appear, chat } = setup('codex', t);
  const first = await launch();
  const second = await launch();
  appear('thread-b', 'Second', 20);
  appear('thread-a', 'First', 10);

  await waitFor(() => chat(first).harnessSessionId && chat(second).harnessSessionId, 'both links');
  assert.deepEqual([chat(first).harnessSessionId, chat(second).harnessSessionId], ['thread-a', 'thread-b']);
});

test('an opencode session without a title is named from its first prompt after a grace period', async (t) => {
  const { launch, appear, chat, polls } = setup('opencode', t, 'Refactor the importer');
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  const chatId = await launch();
  appear('ses_new', null, 10);
  await waitFor(() => chat(chatId).harnessSessionId, 'the link');
  const linkedAt = polls();
  await waitFor(() => polls() >= linkedAt + 2, 'two more polls');
  assert.equal(chat(chatId).name, 'New Session', 'no early rename while opencode may still title it');

  now += 30_001;
  await waitFor(() => chat(chatId).name === 'Refactor the importer', 'the prompt fallback');
});
