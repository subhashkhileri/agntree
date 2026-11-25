import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../../src/providers/WorkspacesTreeProvider';
import { StarredSessionDecorations, sessionRowUri } from '../../src/providers/StarredSessionDecorations';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { HarnessAdapter, SessionMetadata } from '../../src/harnesses/types';
import { ChatSession, Repository, RepositoryWorktrees, Worktree } from '../../src/types';
import { fakeAdapter, fakeNativeUi, makeStorage, stub, waitFor, worktreeRecord } from './support';

beforeEach(() => stub.__reset());

const MINUTE = 60_000;
const noPRs = { getCachedPRInfo: () => null, fetchPRInfo: async () => null, clearCache: () => undefined };
const terminals = { onTerminalStateChange: () => ({ dispose: () => undefined }), isActive: () => false };

function provider(
  t: { after(fn: () => void): void },
  storage: ReturnType<typeof makeStorage>,
  listWorktrees: (repo: Repository) => RepositoryWorktrees,
  adapters: HarnessAdapter[]
) {
  const tree = new WorkspacesTreeProvider(
    storage,
    {
      listRepositoryWorktrees: (_rootPath: string, repoId: string) =>
        listWorktrees(storage.getRepository(repoId)!),
      getAheadBehind: () => null,
    } as never,
    terminals as never,
    new HarnessRegistry(adapters),
    noPRs as never,
    vscode.Uri.file('/extension')
  );
  t.after(() => tree.dispose());
  return tree;
}

/** One git worktree holding a Claude chat, an opencode chat, and a new chat. */
function sessionRows(t: { after(fn: () => void): void }) {
  const now = Date.now();
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ repoId: repo.id, path: '/work/demo' });
  const chat = (id: string, harness: ChatSession['harness'], sessionId: string | null, createdAt: number) => {
    const created = storage.createChat(worktree.id, harness, id);
    return storage.updateChat(created.id, { harnessSessionId: sessionId, createdAt })!;
  };
  const claude = chat('claude', 'claude', 'claude-1', 1);
  const opencode = chat('opencode', 'opencode', 'ses_2', 2);
  const fresh = chat('new', 'opencode', null, 3);
  storage.toggleStar(claude.id);

  let exported = false;
  const claudeUi = fakeNativeUi('Claude Code UI', { contextValueSuffix: 'ClaudeUi' });
  const adapters = [
    fakeAdapter('claude', {
      nativeUi: claudeUi.nativeUi,
      getSessionMetadata: async (): Promise<SessionMetadata> => ({
        lastActivity: now - 16 * MINUTE,
        preview: [{ text: 'claude prompt', timestamp: now - 16 * MINUTE }],
        lastReply: { text: 'claude reply', timestamp: now - 15 * MINUTE },
      }),
    }),
    // Like the opencode service: previews need an export, which metadata
    // includes once it is cached.
    fakeAdapter('opencode', {
      getSessionMetadata: async (): Promise<SessionMetadata> => ({
        lastActivity: now - 33 * MINUTE,
        preview: exported ? [{ text: 'opencode prompt', timestamp: null }] : [],
        model: 'provider/model',
        agent: 'build',
      }),
      getPreview: async () => {
        exported = true;
        return [{ text: 'opencode prompt', timestamp: null }];
      },
    }),
  ];
  const tree = provider(t, storage, () => ({ isGit: true, worktrees: [worktree] }), adapters);
  const row = new WorkspaceTreeItem(worktree.name, 1, 'worktree', worktree, 'worktree');
  const rows = async () => {
    const items = await tree.getChildren(row);
    return Object.assign(new Map(items.map((item) => [item.label, item])), { order: items.map((item) => item.label) });
  };
  return { tree, storage, rows, claude, opencode, fresh, exported: () => exported };
}

const mark = (item: vscode.TreeItem) => ((item.iconPath as { light: vscode.Uri }).light.path.split('/').pop());

test('starred rows lead their worktree, each group newest first, and rows show only what changes: time or "new", a star, and the harness mark', async (t) => {
  const { storage, rows, claude, opencode, fresh } = sessionRows(t);
  const items = await rows();
  assert.deepEqual(items.order, ['claude', 'new', 'opencode'], 'the starred row first, then newest first by creation');
  assert.deepEqual(
    items.order.map((label) => `${items.get(label)!.description} ${mark(items.get(label)!)} ${items.get(label)!.contextValue}`),
    ['16m claude-light-closed.svg starredChatClaudeUi', 'new opencode-light-new.svg chat', '33m opencode-light-closed.svg chat'],
    'the star is a decoration at the right edge, not part of the description'
  );
  assert.equal(items.get('claude')!.accessibilityInformation?.label, 'claude, starred, 16m');
  assert.equal(items.get('opencode')!.accessibilityInformation, undefined);

  await storage.toggleStar(fresh.id);
  assert.deepEqual((await rows()).order, ['new', 'claude', 'opencode'], 'starred rows keep creation order among themselves');
  await storage.toggleStar(claude.id);
  assert.deepEqual((await rows()).order, ['new', 'opencode', 'claude'], 'unstarring returns a row to its creation slot');

  stub.__setConfiguration('starredSessionsFirst', false);
  assert.deepEqual((await rows()).order, ['new', 'opencode', 'claude'], 'with starred-first off, creation order only');
  await storage.toggleStar(opencode.id);
  assert.deepEqual((await rows()).order, ['new', 'opencode', 'claude'], 'starring then moves nothing');
});

test('a starred row gets a star badge and keeps its usual color, re-sent only for rows whose star changed', async (t) => {
  const { storage, rows, claude, opencode } = sessionRows(t);
  const treeChanged = new vscode.EventEmitter<void>();
  const decorations = new StarredSessionDecorations(storage, treeChanged.event);
  t.after(() => decorations.dispose());
  const resent: string[][] = [];
  decorations.onDidChangeFileDecorations((uris) => resent.push(uris.map(String)));

  const items = await rows();
  assert.deepEqual(items.get('claude')!.resourceUri, sessionRowUri(claude.id), 'each row carries its decoration URI');
  const starred = decorations.provideFileDecoration(items.get('claude')!.resourceUri!);
  assert.equal(starred?.badge, '★');
  assert.equal(starred?.color, undefined, 'the name is not recolored');
  assert.equal(decorations.provideFileDecoration(items.get('opencode')!.resourceUri!), undefined);
  assert.equal(decorations.provideFileDecoration(vscode.Uri.file(`/${claude.id}`)), undefined, 'only session rows');

  await storage.toggleStar(opencode.id);
  treeChanged.fire();
  await storage.toggleStar(claude.id);
  treeChanged.fire();
  treeChanged.fire();
  assert.deepEqual(resent, [[String(sessionRowUri(opencode.id))], [String(sessionRowUri(claude.id))]]);
  assert.equal(decorations.provideFileDecoration(sessionRowUri(opencode.id))?.badge, '★');
  assert.equal(decorations.provideFileDecoration(sessionRowUri(claude.id)), undefined);
});

test('with decoration badges turned off, a starred row keeps its star in the description', async (t) => {
  stub.__setConfiguration('badges', false);
  const { rows } = sessionRows(t);
  assert.equal((await rows()).get('claude')!.description, '★ 16m');
});

/** One worktree of Claude chats of different ages, for folding. */
function agedRows(t: { after(fn: () => void): void }) {
  const now = Date.now();
  const DAY = 24 * 60 * MINUTE;
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktree = worktreeRecord({ repoId: repo.id, path: '/work/demo' });
  const activity = new Map<string, number>();
  let created = 0;
  const chat = (name: string, activeAgo: number, visitedAgo = activeAgo) => {
    const record = storage.createChat(worktree.id, 'claude', name);
    activity.set(`s-${name}`, now - activeAgo);
    return storage.updateChat(record.id, {
      harnessSessionId: `s-${name}`,
      createdAt: ++created,
      lastAccessedAt: now - visitedAgo,
    })!;
  };
  const chats = {
    oldB: chat('old B', 10 * DAY),
    oldStarred: chat('old starred', 8 * DAY),
    visited: chat('visited', 9 * DAY, DAY),
    oldOpen: chat('old open', 6 * DAY),
    oldA: chat('old A', 5 * DAY),
    today: chat('today', 60 * MINUTE),
  };
  storage.toggleStar(chats.oldStarred.id);
  const adapter = fakeAdapter('claude', {
    getSessionMetadata: async (sessionId: string): Promise<SessionMetadata> => ({
      lastActivity: activity.get(sessionId) ?? null,
      preview: [],
    }),
  });
  const tree = provider(t, storage, () => ({ isGit: true, worktrees: [worktree] }), [adapter]);
  const open = new Set([chats.oldOpen.id]);
  tree.setChatOpenProvider((chat) => open.has(chat.id));
  const worktreeRow = new WorkspaceTreeItem(worktree.name, 1, 'worktree', worktree, 'worktree');
  const labels = (items: WorkspaceTreeItem[]) => items.map((item) => item.label);
  return { tree, storage, worktree, worktreeRow, chats, open, labels };
}

test('quiet sessions fold under an Older row; starred, open, and recently visited ones stay, and reveal finds a folded one', async (t) => {
  const { tree, worktree, worktreeRow, chats, open, labels } = agedRows(t);
  const rows = await tree.getChildren(worktreeRow);
  assert.deepEqual(labels(rows), ['old starred', 'today', 'old open', 'visited', 'Older (2)']);
  const older = rows[rows.length - 1];
  assert.equal(older.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.equal(older.id, `olderSessions-${worktree.id}`, 'a stable id, so VS Code remembers whether it is open');
  assert.equal(older.contextValue, 'olderSessions');
  assert.equal(tree.getWorktreeForItem(older)?.id, worktree.id, 'the Older row stands for its worktree');

  const folded = await tree.getChildren(older);
  assert.deepEqual(labels(folded), ['old A', 'old B'], 'newest first, as in the worktree');
  assert.equal(folded[0].contextValue, 'chat', 'folded rows are ordinary session rows');
  assert.equal((await tree.getParent(tree.getChatTreeItem(chats.oldA)))?.id, older.id, 'reveal opens the Older row');
  assert.equal((await tree.getParent(older))?.id, worktreeRow.id);
  assert.equal((await tree.getParent(tree.getChatTreeItem(chats.today)))?.id, worktreeRow.id);

  open.add(chats.oldA.id);
  assert.deepEqual(
    labels(await tree.getChildren(worktreeRow)),
    ['old starred', 'today', 'old A', 'old open', 'visited', 'old B'],
    'opening a folded session moves it back up, and one quiet session alone does not fold'
  );
});

test('the Older row collapses again once a session moves out of it, but stays open while sessions are removed from it', async (t) => {
  const { tree, storage, worktree, worktreeRow, chats, open } = agedRows(t);
  for (const name of ['old C', 'old D']) {
    const record = storage.createChat(worktree.id, 'claude', name);
    storage.updateChat(record.id, { harnessSessionId: `s-${name}`, createdAt: 0, lastAccessedAt: Date.now() - 7 * 24 * 60 * MINUTE });
  }
  // VS Code keeps a row expanded for as long as its id is unchanged.
  const olderRow = async () => (await tree.getChildren(worktreeRow)).find((item) => item.itemType === 'olderSessions')!;
  const first = await olderRow();
  assert.equal(first.label, 'Older (4)');
  assert.equal((await olderRow()).id, first.id, 'an unchanged render keeps it open');

  const oldD = storage.getChats().find((chat) => chat.name === 'old D')!;
  storage.deleteChat(oldD.id);
  const afterRemoval = await olderRow();
  assert.equal(afterRemoval.label, 'Older (3)');
  assert.equal(afterRemoval.id, first.id, 'removing a session from the list keeps it open');

  open.add(chats.oldA.id);
  const afterOpen = await olderRow();
  assert.equal(afterOpen.label, 'Older (2)');
  assert.notEqual(afterOpen.id, first.id, 'a new id, so the row comes back collapsed');
  assert.equal(afterOpen.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.equal((await tree.getParent(tree.getChatTreeItem(chats.oldB)))?.id, afterOpen.id, 'reveal uses the new id');
  assert.equal((await olderRow()).id, afterOpen.id, 'and keeps it from then on');
});

test('agntree.foldOlderSessionsAfterDays sets the age, 0 turns folding off, and a change re-renders the tree', async (t) => {
  const { tree, worktreeRow, labels } = agedRows(t);
  let renders = 0;
  tree.onDidChangeTreeData(() => renders++);

  stub.__setConfiguration('foldOlderSessionsAfterDays', 4);
  await waitFor(() => renders === 1, 'a re-render after the setting changed');
  assert.deepEqual(labels(await tree.getChildren(worktreeRow)), ['old starred', 'today', 'old open', 'visited', 'Older (2)']);

  stub.__setConfiguration('foldOlderSessionsAfterDays', 7);
  assert.deepEqual(
    labels(await tree.getChildren(worktreeRow)),
    ['old starred', 'today', 'old A', 'old open', 'visited', 'old B'],
    'only old B is quiet for 7 days, and a single session does not fold'
  );

  stub.__setConfiguration('foldOlderSessionsAfterDays', 0);
  assert.deepEqual(
    labels(await tree.getChildren(worktreeRow)),
    ['old starred', 'today', 'old A', 'old open', 'visited', 'old B'],
    'off: every session is listed'
  );
});

test('an open chat, by terminal or native UI, shows the done mark and running context in place', async (t) => {
  const { tree, rows, claude } = sessionRows(t);
  tree.setChatOpenProvider((chat) => chat.id === claude.id);
  const items = await rows();
  assert.deepEqual(items.order, ['claude', 'new', 'opencode'], 'opening a chat never moves its row');
  const row = items.get('claude')!;
  assert.equal(row.contextValue, 'runningStarredChatClaudeUi');
  assert.equal(mark(row), 'claude-light-done.svg');

  tree.setTurnStateProvider(() => 'working');
  assert.equal(mark((await rows()).get('claude')!), 'claude-light-working.svg');
});

test('tooltips brief the last exchange; a lazy harness fetches its preview only on hover', async (t) => {
  const { tree, rows, exported } = sessionRows(t);
  const items = await rows();
  const tooltip = (item: vscode.TreeItem) => (item.tooltip as vscode.MarkdownString | undefined)?.value;

  assert.match(tooltip(items.get('claude')!) ?? '', /Last exchange[\s\S]*claude prompt[\s\S]*claude reply/);
  assert.match(tooltip(items.get('new')!) ?? '', /No messages yet/);

  const opencode = items.get('opencode')!;
  assert.equal(opencode.tooltip, undefined, 'rendering does not export');
  assert.equal(exported(), false);
  await tree.resolveTreeItem(opencode, opencode as WorkspaceTreeItem);
  assert.ok(exported());
  assert.match(tooltip(opencode) ?? '', /opencode prompt[\s\S]*provider\/model · build/);
});

test('worktree icons: shape says what it is, and blue marks only the worktree this window has open', async (t) => {
  const storage = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const worktrees = [
    worktreeRecord({ id: 'wt-main', repoId: repo.id, name: 'main', path: '/work/demo', isMain: true }),
    worktreeRecord({ id: 'wt-pr', repoId: repo.id, name: 'pr-42', path: '/work/pr-42', isMain: false }),
    worktreeRecord({ id: 'wt-here', repoId: repo.id, name: 'feature', path: '/work/feature', isMain: false }),
    worktreeRecord({ id: 'wt-pr-here', repoId: repo.id, name: 'pr-7', path: '/work/pr-7', isMain: false }),
    worktreeRecord({ id: 'wt-other', repoId: repo.id, name: 'spike', path: '/work/spike', isMain: false }),
  ];
  storage.setPRWorktree('wt-pr', 42);
  storage.setPRWorktree('wt-pr-here', 7);
  const tree = provider(t, storage, () => ({ isGit: true, worktrees }), [fakeAdapter('claude')]);
  const icon = (item: vscode.TreeItem) => {
    const theme = item.iconPath as vscode.ThemeIcon;
    return `${theme.id} ${theme.color?.id}`;
  };
  const iconsWhenOpen = async (folder: string) => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(folder) }];
    const [repoRow] = await tree.getChildren();
    return [icon(repoRow), ...(await tree.getChildren(repoRow)).map((row) => `${row.label}: ${icon(row)}`)];
  };

  assert.deepEqual(await iconsWhenOpen('/work/feature'), [
    'repo charts.purple',
    'main: home charts.purple',
    'pr-42: git-pull-request terminal.ansiCyan',
    'feature: git-branch charts.blue',
    'pr-7: git-pull-request terminal.ansiCyan',
    'spike: git-branch descriptionForeground',
  ]);
  const elsewhere = await iconsWhenOpen('/work/pr-7');
  assert.equal(elsewhere[4], 'pr-7: git-pull-request charts.blue');
  assert.equal(elsewhere[3], 'feature: git-branch descriptionForeground');
  assert.equal((await iconsWhenOpen('/work/demo'))[1], 'main: home charts.blue');
});

test('worktree lookups list each repository at most once', (t) => {
  const storage = makeStorage();
  storage.addRepository('a', '/work/a');
  storage.addRepository('b', '/work/b');
  const listed: string[] = [];
  const tree = provider(t, storage, (repo) => {
    listed.push(repo.name);
    return { isGit: true, worktrees: [worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, path: repo.rootPath })] };
  }, [fakeAdapter('claude')]);

  assert.equal(tree.getWorktreeById('wt-b')?.path, '/work/b');
  assert.equal(tree.getWorktreeById('wt-b')?.path, '/work/b');
  assert.equal(tree.findWorktreeByPath('/work/a')?.id, 'wt-a');
  assert.deepEqual(listed, ['a', 'b']);
});

test('a plain folder shows its sessions directly and follows git init and removal through its watcher', async (t) => {
  const storage = makeStorage();
  const folder = storage.addRepository('notes', '/work/notes');
  storage.addRepository('empty', '/work/empty');
  let isGit = false;
  const worktreeOf = (repo: Repository): Worktree =>
    worktreeRecord({ id: `wt-${repo.name}`, repoId: repo.id, name: isGit ? 'main' : repo.name, path: repo.rootPath });
  const tree = provider(t, storage, (repo) => ({ isGit, worktrees: [worktreeOf(repo)] }), [fakeAdapter('claude')]);
  const session = storage.createChat('wt-notes', 'claude', 'Folder session', { harnessSessionId: 'claude-folder' });
  const rootRow = async () => (await tree.getChildren())[0];
  const fireGitDir = (event: '__fireCreate' | '__fireDelete') => {
    for (const watcher of [...stub.__fileWatchers]) {
      if (!watcher.disposed && watcher.pattern.base === folder.rootPath) watcher[event]();
    }
  };

  const [notes, empty] = await tree.getChildren();
  assert.equal(notes.contextValue, 'folderRepository');
  assert.match(String(notes.tooltip), /Not a git repository/);
  assert.equal(notes.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
  assert.equal(empty.collapsibleState, vscode.TreeItemCollapsibleState.None, 'nothing to expand');
  const [chatRow] = await tree.getChildren(notes);
  assert.equal(chatRow.data.id, session.id);
  assert.equal((await tree.getParent(chatRow))?.id, notes.id, 'reveal goes through the folder row');
  assert.equal(tree.getWorktreeForItem(notes)?.id, 'wt-notes');

  isGit = true;
  fireGitDir('__fireCreate');
  await waitFor(async () => (await rootRow()).contextValue === 'repository', 'the git upgrade');
  const parent = await tree.getParent(chatRow);
  assert.equal(parent?.itemType, 'worktree', 'reveal now goes through the main worktree');
  assert.equal(tree.getWorktreeForItem(await rootRow()), undefined);
  assert.deepEqual((await tree.getChildren(parent)).map((item) => item.data.id), [session.id], 'the chat stays bound');

  isGit = false;
  fireGitDir('__fireDelete');
  await waitFor(async () => (await rootRow()).contextValue === 'folderRepository', 'the downgrade');
  assert.equal((await tree.getParent(chatRow))?.itemType, 'repository');
});
