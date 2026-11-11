/**
 * The shared exact-ID linkage loop, isolated from any harness's storage. A
 * chat registered while a pass is awaiting its resumability check must be
 * checked when that pass ends, not dropped with the snapshot it started from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExactIdSessionSource,
  ExactIdSessionWatcher,
} from '../../src/services/ExactIdSessionWatcher';
import { StorageService } from '../../src/services/StorageService';
import { makeStorage, waitFor } from './support';

class TestWatcher extends ExactIdSessionWatcher {
  constructor(storage: StorageService, source: ExactIdSessionSource) {
    super('pi', storage, source);
  }
}

function setup(t: { after(fn: () => void): void }) {
  const storage = makeStorage();
  let releaseGate: (() => void) | undefined;
  let signalBlocked: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    signalBlocked = resolve;
  });

  const source: ExactIdSessionSource = {
    label: 'TestWatcher',
    watchRoots: () => [],
    watchDirs: () => [],
    sessionIdForFile: (filename) =>
      filename.endsWith('.jsonl')
        ? filename.slice(0, -'.jsonl'.length)
        : null,
    isResumable: async (sessionId) => {
      if (sessionId === 'first') {
        signalBlocked?.();
        await gate;
      }
      return true;
    },
    getSummary: async () => null,
  };

  const watcher = new TestWatcher(storage, source);
  t.after(() => watcher.dispose());
  return { storage, watcher, blocked, release: () => releaseGate?.() };
}

test('a chat registered during an in-flight check is linked when the check ends', async (t) => {
  const { storage, watcher, blocked, release } = setup(t);

  const pendingChat = (pendingSessionId: string) => {
    const chat = storage.createChat('wt-1', 'pi', 'New Session');
    return storage.updateChat(chat.id, {
      status: 'active',
      pendingHarnessSessionId: pendingSessionId,
    })!;
  };

  const first = pendingChat('first');
  const second = pendingChat('second');

  watcher.startWatching();
  watcher.registerPendingChat(first.id, '/worktree');

  // The first pass is now awaiting `first`; register the second chat inside
  // that window and then let the pass finish.
  await blocked;
  watcher.registerPendingChat(second.id, '/worktree');
  release();

  assert.equal(
    await waitFor(
      () => storage.getChat(first.id)!.harnessSessionId,
      'the first chat to link',
      5_000
    ),
    'first'
  );
  assert.equal(
    await waitFor(
      () => storage.getChat(second.id)!.harnessSessionId,
      'the second chat to link',
      5_000
    ),
    'second'
  );
});
