/**
 * Claude new-session linkage: a chat launched with `--session-id` links to the
 * transcript with exactly that ID once it holds a message. There is no
 * directory matching. Negative claims are checked after a sibling chat links
 * in the same pass, so the check provably ran instead of waiting on a sleep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { ClaudeSessionWatcher } from '../../src/services/ClaudeSessionWatcher';
import { ChatSession } from '../../src/types';
import { makeStorage, waitFor } from './support';
import { claudeProfile, entry } from './claudeFixture';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-2222-3333-444444444444`;

function setup(t: { after(fn: () => void): void }) {
  const profile = claudeProfile(t);
  const worktree = profile.dir('worktree');
  // A real profile already has the worktree's project directory, so the
  // watcher's fs.watch fast path is armed; polling is only the fallback.
  fs.mkdirSync(profile.projectDir(worktree), { recursive: true });
  const storage = makeStorage();
  const watcher = new ClaudeSessionWatcher(storage, new ClaudeSessionService());
  t.after(() => watcher.dispose());
  const names: string[] = [];
  watcher.onChatNameUpdated((event) => names.push(`${event.chatId}:${event.name}`));

  const chat = (overrides: Partial<ChatSession>): ChatSession => {
    const created = storage.createChat('wt-1', 'claude', 'New Session');
    return storage.updateChat(created.id, { status: 'active', ...overrides })!;
  };
  const transcript = (sessionId: string, summary: string, options: { projectDir?: string } = {}) =>
    profile.write(sessionId, worktree, [entry.user('A prompt'), entry.summary(summary)], options);
  const current = (chatId: string) => storage.getChat(chatId)!;
  const linked = (chatId: string) => waitFor(() => current(chatId).harnessSessionId, `${chatId} to link`, 15_000);
  return { profile, worktree, watcher, names, chat, transcript, current, linked };
}

test('a pending chat links to the transcript with its exact ID, wherever it is written, and takes its name', async (t) => {
  const { profile, worktree, watcher, names, chat, transcript, current, linked } = setup(t);
  const existing = chat({ pendingHarnessSessionId: id(1) });
  transcript(id(1), 'Immediate summary');

  watcher.startWatching();
  assert.equal(await linked(existing.id), id(1), 'an existing transcript links on start');
  assert.equal(current(existing.id).pendingHarnessSessionId, null);
  await waitFor(() => current(existing.id).name === 'Immediate summary', 'the summary name', 15_000);
  assert.deepEqual(names, [`${existing.id}:Immediate summary`]);

  const later = chat({ pendingHarnessSessionId: id(2) });
  watcher.registerPendingChat(later.id, worktree);
  transcript(id(2), 'Second', { projectDir: path.join(profile.projects, 'a-different-project-dir') });
  assert.equal(await linked(later.id), id(2), 'the ID decides, not the directory');
});

test('only the chosen ID links, and only once its transcript holds a message', async (t) => {
  const { profile, worktree, watcher, chat, transcript, current, linked } = setup(t);
  const target = chat({ pendingHarnessSessionId: id(3) });
  const noPendingId = chat({});
  const empty = chat({ pendingHarnessSessionId: id(4) });
  watcher.startWatching();
  for (const pending of [target, noPendingId, empty]) {
    watcher.registerPendingChat(pending.id, worktree);
  }

  // Another session in the same directory, and an empty transcript for a
  // pending ID, are both present when the target links.
  transcript(id(99), 'Do not claim me');
  const emptyFile = profile.write(id(4), worktree, []);
  transcript(id(3), 'The right session');

  assert.equal(await linked(target.id), id(3));
  assert.equal(current(noPendingId.id).harnessSessionId, null, 'a chat without a chosen ID is never claimed by proximity');
  assert.equal(current(empty.id).harnessSessionId, null, 'an empty transcript is not linked');
  assert.equal(current(empty.id).pendingHarnessSessionId, id(4), 'its pending ID is kept');

  fs.appendFileSync(emptyFile, `${JSON.stringify({ ...entry.user('First real prompt'), cwd: worktree })}\n`);
  assert.equal(await linked(empty.id), id(4));
});

test('a closed chat stops waiting after the TTL, and reopening it starts a new window', async (t) => {
  const { worktree, watcher, chat, transcript, current, linked } = setup(t);
  const abandoned = chat({ pendingHarnessSessionId: id(5), status: 'idle' });
  const barrier = chat({ pendingHarnessSessionId: id(6) });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  watcher.registerPendingChat(abandoned.id, worktree);
  now += 5 * 60_000 + 1;
  transcript(id(5), 'Too late');
  watcher.registerPendingChat(barrier.id, worktree);
  transcript(id(6), 'Barrier');
  await linked(barrier.id);
  assert.equal(current(abandoned.id).harnessSessionId, null);

  watcher.registerPendingChat(abandoned.id, worktree);
  assert.equal(await linked(abandoned.id), id(5));
});

test('a restored chat still named "New Session" is renamed when watching starts, even with its terminal closed', async (t) => {
  const { watcher, chat, transcript, current } = setup(t);
  const restored = chat({ harnessSessionId: id(7), status: 'idle' });
  transcript(id(7), 'Restored summary');

  watcher.startWatching();
  await waitFor(() => current(restored.id).name === 'Restored summary', 'the restored chat name', 15_000);
});
