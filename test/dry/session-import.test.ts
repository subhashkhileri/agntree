/**
 * The importer that reconciles chats with native sessions: auto-import,
 * retention, tombstones, and linking sessions started in an agent's UI.
 * Negative checks wait for a scan that started after the change to finish,
 * instead of sleeping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { HarnessSession } from '../../src/harnesses/types';
import { SessionImportService, SessionImportSettings } from '../../src/services/SessionImportService';
import { WorktreeCatalog } from '../../src/services/WorktreeCatalog';
import { ChatSession, Worktree } from '../../src/types';
import { fakeAdapter, flush, makeStorage, sessionRecord, waitFor, worktreeRecord } from './support';

const DAY = 24 * 60 * 60 * 1000;

function setup(t: { after(fn: () => void): void }) {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const worktreesByRoot = new Map<string, Worktree[]>([[repo.rootPath, [worktree]]]);
  const git = {
    listRepositoryWorktrees: (rootPath: string) => ({ isGit: true, worktrees: worktreesByRoot.get(rootPath) ?? [] }),
  };
  const sessions: HarnessSession[] = [];
  const settings: SessionImportSettings = { enabled: true, retentionDays: 7 };
  const openChats = new Set<string>();
  let listCalls = 0;
  const list = async () => {
    listCalls++;
    return sessions;
  };
  const registry = new HarnessRegistry([
    fakeAdapter('claude', { listSessionsForWorktree: list, listSessionsForRepository: list }),
  ]);
  const create = () =>
    new SessionImportService(storage, new WorktreeCatalog(storage, git as never), registry, {
      scanIntervalMs: 20,
      hotScanIntervalMs: 10,
      isChatOpen: (chat) => openChats.has(chat.id),
      readSettings: () => settings,
    });
  let service = create();
  t.after(() => service.dispose());

  /** A native session last active `ageMs` ago. */
  const appear = (sessionId: string, summary: string | null, ageMs = 0) => {
    const session = sessionRecord('claude', sessionId, { cwd: worktree.path, summary, lastUpdated: new Date(Date.now() - ageMs) });
    sessions.push(session);
    return session;
  };
  /** A chat in the worktree, linked to `sessionId` unless null. */
  const chat = (name: string, sessionId: string | null, updates: Partial<ChatSession> = {}) => {
    const created = storage.createChat(worktree.id, 'claude', name);
    return storage.updateChat(created.id, { harnessSessionId: sessionId, ...updates })!;
  };
  const linkedTo = (sessionId: string) => storage.getChats().find((entry) => entry.harnessSessionId === sessionId);
  /**
   * Resolves once a scan that started after this call has finished. A scan
   * does no async work after listing, so draining the queue completes it.
   */
  const scanned = async () => {
    const from = listCalls;
    await waitFor(() => {
      service.wake();
      return listCalls > from;
    }, 'a scan');
    await flush();
  };
  /** Another workspace root, such as a parent folder holding the repository. */
  const addRoot = (name: string, rootPath: string) => {
    const root = storage.addRepository(name, rootPath);
    const rootWorktree = worktreeRecord({ id: `wt-${name}`, repoId: root.id, name, path: rootPath });
    worktreesByRoot.set(rootPath, [rootWorktree]);
    return rootWorktree;
  };
  return {
    storage, worktree, settings, addRoot, openChats, appear, chat, linkedTo, scanned,
    get service() {
      return service;
    },
    /** A new service over the same stored state, like an extension-host reload. */
    reload() {
      service.dispose();
      service = create();
      return service;
    },
  };
}

test('recent native sessions are imported under the harness name, which follows the harness until the user renames', async (t) => {
  const f = setup(t);
  const recent = f.appear('s-recent', 'Named by the harness', 60_000);
  f.appear('s-old', 'Old session', 8 * DAY);
  f.service.start();

  const imported = await waitFor(() => f.linkedTo('s-recent'), 'the import');
  assert.equal(imported.name, 'Named by the harness');
  assert.equal(imported.autoImported, true);
  await f.scanned();
  assert.equal(f.linkedTo('s-old'), undefined, 'outside the retention window');

  recent.summary = 'Updated harness name';
  await waitFor(() => f.storage.getChat(imported.id)?.name === 'Updated harness name', 'the rename');
  f.storage.updateChat(imported.id, { name: 'My name', customName: true });
  recent.summary = 'Ignored harness name';
  await f.scanned();
  assert.equal(f.storage.getChat(imported.id)?.name, 'My name');
});

test('a session the user removed stays removed, and nothing is imported while the setting is off', async (t) => {
  const removed = setup(t);
  removed.appear('s-removed', 'Removed', 60_000);
  removed.storage.rememberRemovedSession('claude', 's-removed');
  removed.service.start();
  await removed.scanned();
  assert.equal(removed.linkedTo('s-removed'), undefined);

  const disabled = setup(t);
  disabled.settings.enabled = false;
  disabled.appear('s-disabled', 'Disabled', 60_000);
  disabled.service.start();
  await disabled.scanned();
  assert.equal(disabled.linkedTo('s-disabled'), undefined);
});

test('retention removes every quiet row except starred and open ones', async (t) => {
  const f = setup(t);
  const old = { createdAt: Date.now() - 8 * DAY, lastAccessedAt: Date.now() - 8 * DAY };
  const quiet = (name: string, extra: Partial<ChatSession> = {}) => {
    const session = f.appear(`s-${name}`, name, 8 * DAY);
    return f.chat(name, session.sessionId, { ...old, ...extra });
  };
  const autoImported = quiet('auto', { autoImported: true });
  const created = quiet('created');
  const unlinked = f.chat('unlinked', null, old);
  const starredAuto = quiet('starred-auto', { autoImported: true });
  const starred = quiet('starred');
  const open = quiet('open');
  f.storage.toggleStar(starredAuto.id);
  f.storage.toggleStar(starred.id);
  f.openChats.add(open.id);

  f.service.start();
  await waitFor(() => !f.storage.getChat(autoImported.id), 'the expired rows to go');
  const remaining = new Set(f.storage.getChats().map((entry) => entry.name));
  assert.deepEqual([...remaining].sort(), ['open', 'starred', 'starred-auto']);
  assert.equal(f.storage.getRemovedSessionKeys().size, 0, 'retention is not a user removal');
  void created;
  void unlinked;
});

test('a UI-started placeholder links to the first new session in its worktree and takes its name', async (t) => {
  const f = setup(t);
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await f.service.expectChat(placeholder.id, f.worktree.path, { bindSurface: false });
  f.appear('s-ui', 'UI session');
  f.service.start();

  await waitFor(() => f.storage.getChat(placeholder.id)?.harnessSessionId, 'the link');
  const linked = f.storage.getChat(placeholder.id)!;
  assert.deepEqual([linked.harnessSessionId, linked.name, linked.pendingUiLaunch], ['s-ui', 'UI session', false]);
});

test('the launch snapshot survives a reload, so the placeholder never claims an older session', async (t) => {
  const f = setup(t);
  const older = f.appear('s-pre', 'Pre-existing', 60_000);
  const placeholder = f.chat('New Session', null, { pendingUiLaunch: true });
  await f.service.expectChat(placeholder.id, f.worktree.path, { bindSurface: false });
  assert.deepEqual(f.storage.getChat(placeholder.id)?.pendingUiKnownSessionIds, ['s-pre']);

  // The host reloads before the first prompt while the older session stays
  // active elsewhere, so its timestamp is now newer than the placeholder.
  older.lastUpdated = new Date();
  older.lastActivity = Date.now();
  f.reload().start();
  await f.scanned();
  assert.equal(f.storage.getChat(placeholder.id)?.harnessSessionId, null);

  f.appear('s-ui', 'UI session');
  await waitFor(() => f.storage.getChat(placeholder.id)?.harnessSessionId === 's-ui', 'the link after the reload');
  assert.equal(f.storage.getChat(placeholder.id)?.pendingUiKnownSessionIds, undefined, 'linking clears the snapshot');
});

test('a CLI launch reserves its session for the watcher until the placeholder goes stale', async (t) => {
  const f = setup(t);
  const launch = f.chat('New Session', null);
  f.appear('s-cli', 'CLI session');
  f.service.start();
  await f.scanned();
  assert.equal(f.linkedTo('s-cli'), undefined, 'the importer does not race the watcher');
  assert.equal(f.storage.getChat(launch.id)?.harnessSessionId, null);

  f.storage.updateChat(launch.id, { createdAt: Date.now() - 2 * DAY });
  await waitFor(() => f.linkedTo('s-cli')?.autoImported, 'a stale placeholder to stop reserving');
});

test('a root nested in another keeps its own sessions, and rows imported under the outer root move to it', async (t) => {
  const f = setup(t);
  const outer = f.addRoot('work', '/work');
  // Imported under the parent folder before nested roots were told apart.
  const misplaced = f.storage.createChat(outer.id, 'claude', 'Old import', { harnessSessionId: 's-old' });
  f.storage.toggleStar(misplaced.id);
  f.appear('s-old', 'Old import', 60_000);
  f.appear('s-inner', 'Inner session', 60_000);
  const own = f.appear('s-outer', 'Outer session', 60_000);
  own.cwd = '/work/notes';
  f.service.start();

  await waitFor(() => f.linkedTo('s-inner') && f.linkedTo('s-outer'), 'the imports');
  await f.scanned();
  assert.equal(f.linkedTo('s-inner')?.worktreeId, f.worktree.id);
  assert.equal(f.linkedTo('s-outer')?.worktreeId, outer.id, 'a plain subdirectory still belongs to the outer root');
  assert.equal(f.linkedTo('s-old')?.id, misplaced.id, 'moved, not re-imported');
  assert.equal(f.linkedTo('s-old')?.worktreeId, f.worktree.id);
  assert.ok(f.storage.getStarredChatIds().has(misplaced.id), 'the star stays');
  assert.equal(f.storage.getChats().filter((chat) => chat.worktreeId === outer.id).length, 1);
});
