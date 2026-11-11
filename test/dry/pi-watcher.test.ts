/**
 * Pi new-session linkage: a chat launched with `--session-id` links to the
 * record named with exactly that ID once it exists. Negative claims are
 * checked after a sibling chat links in the same pass, so the check provably
 * ran instead of waiting on a sleep.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { PiSessionService } from '../../src/services/PiSessionService';
import { PiSessionWatcher } from '../../src/services/PiSessionWatcher';
import { ChatSession } from '../../src/types';
import { makeStorage, waitFor } from './support';
import { piEntry, piProfile } from './piFixture';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);

function setup(t: { after(fn: () => void): void }) {
  const profile = piProfile(t);
  const worktree = profile.dir('worktree');
  // Pi creates the directory with the first record; create it here so the
  // watcher's fs.watch fast path is armed and polling is only the fallback.
  fs.mkdirSync(profile.sessionDir(worktree), { recursive: true });
  const storage = makeStorage();
  const catalog = {
    worktrees: () => [
      {
        id: 'wt-1',
        repoId: 'repo-1',
        name: 'main',
        path: worktree,
        isMain: true,
      },
    ],
  };
  const watcher = new PiSessionWatcher(
    storage,
    new PiSessionService(),
    catalog
  );
  t.after(() => watcher.dispose());
  const names: string[] = [];
  watcher.onChatNameUpdated((event) =>
    names.push(`${event.chatId}:${event.name}`)
  );

  const chat = (overrides: Partial<ChatSession>): ChatSession => {
    const created = storage.createChat('wt-1', 'pi', 'New Session');
    return storage.updateChat(created.id, {
      status: 'active',
      ...overrides,
    })!;
  };
  const transcript = (
    sessionId: string,
    text: string,
    at = T0,
    name?: string
  ) =>
    profile.write(
      sessionId,
      worktree,
      [
        ...(name ? [piEntry.sessionInfo(name, at)] : []),
        piEntry.user(text, at),
      ],
      { at }
    );
  const current = (chatId: string) => storage.getChat(chatId)!;
  const linked = (chatId: string) =>
    waitFor(
      () => current(chatId).harnessSessionId,
      `${chatId} to link`,
      15_000
    );
  return { profile, worktree, watcher, names, chat, transcript, current, linked };
}

test('a pending chat links to the record with its exact ID and takes its name', async (t) => {
  const { watcher, names, chat, transcript, current, linked } = setup(t);
  const existing = chat({ pendingHarnessSessionId: 'session-1' });
  transcript('session-1', 'A prompt', T0, 'Immediate summary');

  watcher.startWatching();
  assert.equal(await linked(existing.id), 'session-1');
  assert.equal(current(existing.id).pendingHarnessSessionId, null);
  await waitFor(
    () => current(existing.id).name === 'Immediate summary',
    'the summary name',
    15_000
  );
  assert.deepEqual(names, [`${existing.id}:Immediate summary`]);
});

test('only the chosen ID links, not another session in the same directory', async (t) => {
  const { worktree, watcher, chat, transcript, current, linked } = setup(t);
  const target = chat({ pendingHarnessSessionId: 'session-3' });
  const noPendingId = chat({});
  watcher.startWatching();
  for (const pending of [target, noPendingId]) {
    watcher.registerPendingChat(pending.id, worktree);
  }

  transcript('session-99', 'Do not claim me', T0);
  transcript('session-3', 'The right session', T0 + 1);

  assert.equal(await linked(target.id), 'session-3');
  assert.equal(
    current(noPendingId.id).harnessSessionId,
    null,
    'a chat without a chosen ID is never claimed by proximity'
  );
});

test('a closed chat stops waiting after the TTL, and reopening it starts a new window', async (t) => {
  const { worktree, watcher, chat, transcript, current, linked } = setup(t);
  const abandoned = chat({
    pendingHarnessSessionId: 'session-5',
    status: 'idle',
  });
  const barrier = chat({ pendingHarnessSessionId: 'session-6' });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });

  watcher.registerPendingChat(abandoned.id, worktree);
  now += 5 * 60_000 + 1;
  transcript('session-5', 'Too late', T0);
  watcher.registerPendingChat(barrier.id, worktree);
  transcript('session-6', 'Barrier', T0 + 1);
  await linked(barrier.id);
  assert.equal(current(abandoned.id).harnessSessionId, null);

  watcher.registerPendingChat(abandoned.id, worktree);
  assert.equal(await linked(abandoned.id), 'session-5');
});

test('a restored chat still named "New Session" is renamed when watching starts, even with its terminal closed', async (t) => {
  const { watcher, chat, transcript, current } = setup(t);
  const restored = chat({
    harnessSessionId: 'session-7',
    status: 'idle',
  });
  transcript('session-7', 'A prompt', T0, 'Restored summary');

  watcher.startWatching();
  await waitFor(
    () => current(restored.id).name === 'Restored summary',
    'the restored chat name',
    15_000
  );
});

test('a restored chat is renamed from a project sessionDir setting', async (t) => {
  const { profile, worktree, watcher, chat, current } = setup(t);
  fs.mkdirSync(path.join(worktree, '.pi'), { recursive: true });
  fs.writeFileSync(
    path.join(worktree, '.pi', 'settings.json'),
    JSON.stringify({ sessionDir: 'pi-sessions' })
  );
  const restored = chat({
    harnessSessionId: 'session-8',
    status: 'idle',
  });
  profile.write(
    'session-8',
    worktree,
    [piEntry.sessionInfo('Override summary', T0), piEntry.user('Prompt', T0 + 1)],
    { at: T0, dir: path.join(worktree, 'pi-sessions') }
  );

  watcher.startWatching();
  await waitFor(
    () => current(restored.id).name === 'Override summary',
    'the override session name',
    15_000
  );
});
