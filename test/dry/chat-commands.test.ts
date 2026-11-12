/**
 * Session commands end to end over fake adapters: creation, opening in a
 * terminal or an agent's VS Code UI, forks, import, and removal. Commands are
 * harness-agnostic, so each path is proven once with the adapter shape that
 * exercises it (a chosen ID, a linked fork, a native UI).
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { StorageService } from '../../src/services/StorageService';
import { TerminalManager } from '../../src/services/TerminalManager';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { WorktreeCatalog } from '../../src/services/WorktreeCatalog';
import { SessionImportService } from '../../src/services/SessionImportService';
import { WorkspaceTreeItem } from '../../src/providers/WorkspacesTreeProvider';
import { registerChatCommands } from '../../src/commands/chat';
import { registerSessionImportCommands } from '../../src/commands/sessionImport';
import { ForkResult, HarnessSession, NativeUiOpenResult } from '../../src/harnesses/types';
import { ChatSession, HarnessId, Worktree } from '../../src/types';
import {
  fakeAdapter,
  fakeNativeUi,
  FakeTerminal,
  makeStorage,
  runCommand,
  sessionRecord,
  shown,
  stub,
  waitFor,
  worktreeRecord,
} from './support';

beforeEach(() => stub.__reset());

const UUID = /^[0-9a-f-]{36}$/;

function setup(t: { after(fn: () => void): void }, options: { notInstalled?: HarnessId[] } = {}) {
  const storage: StorageService = makeStorage();
  const repo = storage.addRepository('demo', '/work/demo');
  const folderRepo = storage.addRepository('scratch', '/work/scratch');
  const main = worktreeRecord({ id: 'wt-main', repoId: repo.id, path: '/work/demo' });
  const feature = worktreeRecord({ id: 'wt-feature', repoId: repo.id, name: 'feature-x', path: '/work/demo-feature-x', isMain: false });
  const folder = worktreeRecord({ id: 'wt-folder', repoId: folderRepo.id, name: 'scratch', path: '/work/scratch' });
  const worktrees: Worktree[] = [main, feature];

  /** Sessions that no longer exist natively; chosen IDs have no transcript yet. */
  const missing = new Set<string>();
  const resumable = async (id: string) => !missing.has(id) && !UUID.test(id) && !id.startsWith('pending-');
  const sessions: Record<HarnessId, HarnessSession[]> = { claude: [], opencode: [], codex: [], pi: [] };
  let pendingForks = 0;
  const claudeUi = fakeNativeUi('Claude Code UI', { contextValueSuffix: 'ClaudeUi' });
  const codexUi = fakeNativeUi('Codex UI', { contextValueSuffix: 'CodexUi' });
  const forks: Record<HarnessId, () => Promise<ForkResult>> = {
    claude: async () => ({ kind: 'terminal', pendingSessionId: `pending-fork-${++pendingForks}` }),
    opencode: async () => ({ kind: 'linked', sessionId: 'ses_fork' }),
    codex: async () => ({ kind: 'linked', sessionId: 'codex-fork' }),
    pi: async () => ({ kind: 'terminal', pendingSessionId: `pending-fork-${++pendingForks}` }),
  };
  const adapter = (id: HarnessId, nativeUi?: typeof claudeUi) =>
    fakeAdapter(id, {
      nativeUi: nativeUi?.nativeUi,
      isInstalled: async () => !options.notInstalled?.includes(id),
      isSessionResumable: resumable,
      listSessionsForWorktree: async () => sessions[id],
      listSessionsForRepository: async () => sessions[id],
      forkSession: () => forks[id](),
      prepareForkToNewWorktree: () => forks[id](),
    });
  const adapters = { claude: adapter('claude', claudeUi), opencode: adapter('opencode'), codex: adapter('codex', codexUi) };
  const registry = new HarnessRegistry(Object.values(adapters));

  const git = {
    getCurrentCommit: () => 'deadbeef',
    listRepositoryWorktrees: (_root: string, repoId: string) =>
      repoId === folderRepo.id ? { isGit: false, worktrees: [folder] } : { isGit: true, worktrees },
    listWorktrees: () => worktrees,
    getBranches: () => [] as string[],
    createWorktreeWithNewBranch: (_root: string, branch: string, path: string) => {
      worktrees.push(worktreeRecord({ id: `wt-${branch}`, repoId: repo.id, name: branch, path, isMain: false }));
      return true;
    },
    hasUncommittedChanges: () => false,
    copyUncommittedChanges: () => true,
  };
  const workspaces = {
    getWorktreeById: (id: string) => [...worktrees, folder].find((worktree) => worktree.id === id),
    getWorktreeForItem: (item?: WorkspaceTreeItem) =>
      item?.itemType === 'worktree'
        ? (item.data as Worktree)
        : item?.itemType === 'repository' && item.data.id === folderRepo.id
          ? folder
          : undefined,
    isGitWorktree: (worktree: Worktree) => worktree.id !== folder.id,
  };
  const shown: string[] = [];
  /** What the attention service would report; tests fill it. */
  const needingYou: string[] = [];
  /** The tree's selection and the panels' worktree, for commands run from the keyboard. */
  const selectedRows: WorkspaceTreeItem[] = [];
  const active: { worktree?: Worktree } = {};
  const activated: string[] = [];
  const registrations: string[] = [];
  const watchers = { registerPendingChat: (_h: HarnessId, chatId: string) => registrations.push(chatId) };
  const terminals = new TerminalManager(storage, registry, watchers as never);
  const catalog = new WorktreeCatalog(storage, git as never);
  const importer = new SessionImportService(storage, catalog, registry, {
    scanIntervalMs: 10,
    hotScanIntervalMs: 10,
    readSettings: () => ({ enabled: false, retentionDays: 7 }),
  });
  importer.start();
  t.after(() => {
    importer.dispose();
    terminals.dispose();
  });

  const context = { subscriptions: [], extensionUri: vscode.Uri.file('/extension') } as never;
  registerChatCommands(context, {
    storageService: storage,
    gitService: git as never,
    terminalManager: terminals,
    workspacesProvider: workspaces as never,
    harnessRegistry: registry,
    harnessWatcherRegistry: watchers as never,
    sessionImporter: importer,
    sessionsNeedingYou: () => needingYou,
    selectedRows: () => selectedRows,
    activeWorktree: () => active.worktree,
    activateChat: (chat) => activated.push(chat.id),
    showWorktree: (worktree) => shown.push(worktree.id),
    removeChats: (ids, options) => {
      ids.forEach((id) => terminals.closeChat(id));
      return storage.deleteChats(ids, options);
    },
    refreshTree: () => undefined,
  });
  registerSessionImportCommands(context, storage, git as never, catalog, workspaces as never, registry, () => undefined);
  vscode.commands.registerCommand('agntree.refreshWorkspaces', () => undefined);

  return {
    storage, main, feature, folder, folderRepo, worktrees, missing, sessions, adapters, terminals,
    claudeUi, codexUi, shown, activated, registrations, needingYou, selectedRows, active,
    /** A chat in a worktree (main by default), linked when `sessionId` is given. */
    chat(harness: HarnessId, name: string, sessionId: string | null = null, worktree = main): ChatSession {
      return storage.createChat(worktree.id, harness, name, { harnessSessionId: sessionId });
    },
    row: (chat: ChatSession) => new WorkspaceTreeItem(chat.name, 0, 'chat', storage.getChat(chat.id)!, 'chat'),
    worktreeRow: (worktree: Worktree) => new WorkspaceTreeItem(worktree.name, 1, 'worktree', worktree, 'worktree'),
    lastTerminal: () => stub.window.terminals.at(-1) as FakeTerminal,
    chatsIn: (worktree: Worktree) => storage.getChatsByWorktree(worktree.id),
  };
}

test('New Session launches in the worktree, with an ID chosen up front when the harness accepts one', async (t) => {
  const f = setup(t);
  await runCommand('agntree.newClaudeChat', f.worktreeRow(f.main));
  const [claude] = f.chatsIn(f.main);
  assert.equal(claude.name, 'New Session');
  assert.match(claude.pendingHarnessSessionId ?? '', UUID);
  assert.equal(f.lastTerminal().sent[0], `claude --session-id ${claude.pendingHarnessSessionId}`);
  assert.equal(f.lastTerminal().options.cwd, f.main.path);
  assert.deepEqual([f.registrations, f.shown], [[claude.id], [f.main.id]]);

  await runCommand('agntree.newCodexChat', f.worktreeRow(f.main));
  const codex = f.chatsIn(f.main).find((chat) => chat.harness === 'codex')!;
  assert.equal(codex.pendingHarnessSessionId, undefined, 'Codex assigns its own ID');
  assert.equal(f.lastTerminal().sent[0], 'codex');
  assert.ok(f.registrations.includes(codex.id), 'its watcher links the thread later');

  await runCommand('agntree.newChat', new WorkspaceTreeItem('scratch', 1, 'repository', f.folderRepo, 'folderRepository'));
  assert.equal(f.chatsIn(f.folder)[0]?.harness, 'claude', 'the legacy alias works from a plain folder row');
  assert.equal(f.lastTerminal().options.cwd, f.folder.path);
});

test('New Session starts the default agent in one click, and asks which agent when none is set', async (t) => {
  const f = setup(t);
  stub.__setConfiguration('defaultHarness', 'codex');
  t.after(() => stub.__setConfiguration('defaultHarness', undefined));
  await runCommand('agntree.newDefaultSession', f.worktreeRow(f.main));
  assert.deepEqual(f.chatsIn(f.main).map((chat) => chat.harness), ['codex'], 'no question asked');
  assert.equal(f.lastTerminal().sent[0], 'codex');

  // No default: the installed agents are offered and the choice starts.
  stub.__setConfiguration('defaultHarness', '');
  stub.__setQuickPickHandler((items: { label: string }[]) => items.find((item) => item.label === f.adapters.opencode.displayName));
  t.after(() => stub.__setQuickPickHandler(null));
  await runCommand('agntree.newDefaultSession', f.worktreeRow(f.main));
  assert.deepEqual(f.chatsIn(f.main).map((chat) => chat.harness), ['codex', 'opencode']);
});

test('a default agent that is not installed is not launched: New Session offers the installed ones instead', async (t) => {
  const f = setup(t, { notInstalled: ['claude'] });
  stub.__setConfiguration('defaultHarness', 'claude');
  let offered: string[] = [];
  stub.__setQuickPickHandler((items: { label: string }[], options: { placeHolder: string }) => {
    offered = items.map((item) => item.label);
    assert.match(options.placeHolder, /is the default agent but is not installed/);
    return undefined;
  });
  t.after(() => {
    stub.__setQuickPickHandler(null);
    stub.__setConfiguration('defaultHarness', undefined);
  });
  await runCommand('agntree.newDefaultSession', f.worktreeRow(f.main));
  assert.deepEqual(offered, [f.adapters.opencode.displayName, f.adapters.codex.displayName]);
  assert.equal(f.chatsIn(f.main).length, 0, 'dismissing the question starts nothing');
});

test('Set Default Agent stores the chosen agent, and Ask Every Time clears it', async (t) => {
  const f = setup(t);
  t.after(() => {
    stub.__setQuickPickHandler(null);
    stub.__setConfiguration('defaultHarness', undefined);
  });
  const config = () => vscode.workspace.getConfiguration('agntree').get('defaultHarness');
  stub.__setQuickPickHandler((items: { label: string }[]) => items.find((item) => item.label === f.adapters.codex.displayName));
  await runCommand('agntree.setDefaultHarness');
  assert.equal(config(), 'codex');

  stub.__setQuickPickHandler((items: { label: string; description?: string }[]) => {
    assert.equal(items.find((item) => item.description?.includes('current'))?.label, f.adapters.codex.displayName);
    return items[0];
  });
  await runCommand('agntree.setDefaultHarness');
  assert.equal(config(), '');
});

test('opening a chat from before chosen IDs gives it one; opening an open chat only focuses it', async (t) => {
  const f = setup(t);
  const legacy = f.chat('claude', 'Legacy');
  await runCommand('agntree.openChat', f.row(legacy));
  const pending = f.storage.getChat(legacy.id)!.pendingHarnessSessionId;
  assert.match(pending ?? '', UUID);
  assert.equal(f.lastTerminal().sent[0], `claude --session-id ${pending}`);

  const registered = f.registrations.length;
  await runCommand('agntree.openChat', f.row(legacy));
  assert.deepEqual([stub.window.terminals.length, f.lastTerminal().shown, f.registrations.length], [1, 2, registered]);
});

test('Open in UI stops a running terminal only after confirmation, then hands over the session', async (t) => {
  const f = setup(t);
  const chat = f.chat('claude', 'Running', 'claude-1');
  await runCommand('agntree.openChat', f.row(chat));
  const terminal = f.lastTerminal();

  stub.__warningResponses.push(undefined);
  await runCommand('agntree.openClaudeUi', f.row(chat));
  assert.ok(shown('Close the terminal for "Running"?'));
  assert.deepEqual([terminal.disposed, f.claudeUi.opened.length], [false, 0], 'declining keeps the terminal');

  stub.__warningResponses.push('Close and Open');
  const handoff = runCommand('agntree.openClaudeUi', f.row(chat));
  await waitFor(() => terminal.disposed, 'the terminal to close');
  stub.window.__fireDidCloseTerminal(terminal);
  await handoff;
  assert.deepEqual(f.claudeUi.opened, [{ sessionId: 'claude-1', cwd: f.main.path }]);
  assert.deepEqual(f.claudeUi.surfaces.calls, ['expect:claude-1:Running', 'settle:claude-1']);
  assert.deepEqual([stub.window.terminals.length, f.activated], [0, [chat.id]]);
});

test('Open in UI explains a refusal before touching anything', async (t) => {
  const f = setup(t);
  const unstarted = f.chat('claude', 'Unstarted');
  const gone = f.chat('claude', 'Gone', 'gone');
  const mismatch = f.chat('claude', 'Mismatch', 'claude-2');
  const codex = f.chat('codex', 'Codex', 'codex-1');
  f.missing.add('gone');
  await runCommand('agntree.openChat', f.row(mismatch));
  f.claudeUi.nativeUi.checkAvailability = () => ({ kind: 'workspace-mismatch', uiCwd: '/elsewhere' });

  const cases: [ChatSession, string][] = [
    [unstarted, 'Start this session in the terminal first'],
    [gone, 'session no longer exists'],
    [mismatch, 'runs in the first folder open in VS Code'],
    [codex, 'This is not a Claude Code session'],
  ];
  for (const [chat, message] of cases) {
    await runCommand('agntree.openClaudeUi', f.row(chat));
    assert.ok(shown(message), message);
  }
  assert.equal(f.claudeUi.opened.length, 0);
  assert.ok(f.terminals.isActive(mismatch.id), 'a folder mismatch never costs the running terminal');

  f.claudeUi.nativeUi.isInstalled = () => false;
  await runCommand('agntree.openClaudeUi', f.row(gone));
  assert.ok(shown('The Claude Code UI extension is not installed'));
});

test('a click reveals a session already open in its UI, from the tree or the starred list; a live terminal still wins', async (t) => {
  const f = setup(t);
  const chat = f.chat('codex', 'Codex UI', 'codex-1');
  f.storage.toggleStar(chat.id);
  f.codexUi.surfaces.open.add('codex-1');

  await runCommand('agntree.openChat', f.row(chat));
  stub.__setQuickPickHandler((items) => items.find((item: { chatId?: string }) => item.chatId === chat.id));
  await runCommand('agntree.showStarredSessions');
  assert.equal(f.codexUi.opened.length, 2);
  assert.equal(stub.window.terminals.length, 0, 'no second agent beside the open panel');

  f.codexUi.surfaces.open.delete('codex-1');
  await runCommand('agntree.openChat', f.row(chat));
  const terminal = f.lastTerminal();
  f.codexUi.surfaces.open.add('codex-1');
  await runCommand('agntree.openChat', f.row(chat));
  assert.deepEqual([f.codexUi.opened.length, terminal.shown], [2, 2], 'the live terminal is focused instead');
});

test('with the UI as default, a click uses the UI when it can and the terminal otherwise', async (t) => {
  const f = setup(t);
  stub.__setConfiguration('defaultSessionSurface', 'ui');
  const inUi = f.chat('claude', 'UI', 'claude-ui');
  const fallback = f.chat('claude', 'Fallback', 'claude-fallback');
  const explicit = f.chat('claude', 'Explicit', 'claude-explicit');

  await runCommand('agntree.openChat', f.row(inUi));
  assert.deepEqual(f.claudeUi.opened.map((open) => open.sessionId), ['claude-ui']);
  f.claudeUi.nativeUi.checkAvailability = () => ({ kind: 'workspace-mismatch', uiCwd: '/elsewhere' });
  await runCommand('agntree.openChat', f.row(fallback));
  f.claudeUi.nativeUi.checkAvailability = () => ({ kind: 'available' });
  await runCommand('agntree.openChatInTerminal', f.row(explicit));
  assert.deepEqual(stub.window.terminals.map((terminal) => terminal.sent[0]), [
    'claude --resume claude-fallback',
    'claude --resume claude-explicit',
  ]);

  // Open in Terminal on a session open in the UI closes that tab first.
  f.claudeUi.surfaces.open.add('claude-ui');
  stub.__warningResponses.push('Close and Open');
  await runCommand('agntree.openChatInTerminal', f.row(inUi));
  assert.ok(f.claudeUi.surfaces.calls.includes('close:claude-ui'));
  assert.equal(f.lastTerminal().sent[0], 'claude --resume claude-ui');
});

test('a new UI session is a placeholder the importer links; a failed open leaves no row behind', async (t) => {
  const f = setup(t);
  await runCommand('agntree.newClaudeChatInUi', f.worktreeRow(f.main));
  const [placeholder] = f.chatsIn(f.main);
  assert.deepEqual([placeholder.pendingUiLaunch, placeholder.harnessSessionId, stub.window.terminals.length], [true, null, 0]);
  assert.deepEqual(f.claudeUi.opened, [{ cwd: f.main.path }]);

  f.sessions.claude.push(sessionRecord('claude', 'ui-created', { cwd: f.main.path, summary: 'UI Created' }));
  await waitFor(() => f.storage.getChat(placeholder.id)?.harnessSessionId, 'the importer to link it');
  const linked = f.storage.getChat(placeholder.id)!;
  assert.deepEqual([linked.name, linked.pendingUiLaunch], ['UI Created', false]);

  f.claudeUi.nativeUi.openNewSession = async (): Promise<NativeUiOpenResult> => ({ kind: 'failed', message: 'extension host gone' });
  await runCommand('agntree.newClaudeChatInUi', f.worktreeRow(f.main));
  assert.equal(f.chatsIn(f.main).length, 1);
  assert.ok(shown('extension host gone'));
});

test('Fork Session numbers the fork; a linked fork resumes its new ID, a terminal fork chooses one and keeps its source', async (t) => {
  const f = setup(t);
  const claude = f.chat('claude', 'Fix icons', 'claude-1');
  const codex = f.chat('codex', 'Fix icons (1)', 'codex-1');

  await runCommand('agntree.forkChat', f.row(claude));
  const claudeFork = f.chatsIn(f.main).find((chat) => chat.name === 'Fix icons (2)')!;
  assert.deepEqual(
    [claudeFork.harnessSessionId, claudeFork.pendingHarnessSessionId, claudeFork.forkedFromSessionId],
    [null, 'pending-fork-1', 'claude-1']
  );
  assert.equal(f.lastTerminal().sent[0], 'claude --fork claude-1 --session-id pending-fork-1');
  assert.ok(f.registrations.includes(claudeFork.id));

  await runCommand('agntree.forkChat', f.row(codex));
  const codexFork = f.chatsIn(f.main).find((chat) => chat.name === 'Fix icons (1) (1)')!;
  assert.equal(codexFork.harnessSessionId, 'codex-fork');
  assert.equal(f.lastTerminal().sent[0], 'codex --resume codex-fork');
  assert.ok(!f.registrations.includes(codexFork.id), 'nothing left for a watcher to link');

  await runCommand('agntree.forkChat', f.row(f.chat('claude', 'Unstarted')));
  assert.ok(shown('Cannot fork a session that has not been started yet'));
});

test('Fork to New Worktree forks into a new branch worktree; a failed fork or a plain folder creates no chat', async (t) => {
  const f = setup(t);
  const opencode = f.chat('opencode', 'Plan', 'ses_1');
  stub.__inputResponses.push('feature-fork', '/work/demo-feature-fork');
  await runCommand('agntree.forkChatWithChanges', f.row(opencode));
  const created = f.worktrees.find((worktree) => worktree.name === 'feature-fork')!;
  assert.deepEqual(f.chatsIn(created).map((chat) => [chat.name, chat.harnessSessionId]), [['Plan (1)', 'ses_fork']]);
  assert.equal(f.lastTerminal().sent[0], 'opencode --resume ses_fork');

  f.adapters.opencode.prepareForkToNewWorktree = async () => {
    throw new Error('move failed');
  };
  stub.__inputResponses.push('feature-broken', '/work/demo-broken');
  await runCommand('agntree.forkChatWithChanges', f.row(opencode));
  assert.ok(shown('Failed to fork the opencode session into the new worktree: move failed'));
  assert.deepEqual(f.chatsIn(f.worktrees.find((worktree) => worktree.name === 'feature-broken')!), []);

  const inFolder = f.chat('claude', 'Folder', 'claude-folder', f.folder);
  await runCommand('agntree.forkChatWithChanges', f.row(inFolder));
  assert.ok(shown('plain folder'));
});

test('Import offers only sessions not yet imported, keyed by harness and session ID', async (t) => {
  const f = setup(t);
  const now = Date.now();
  f.sessions.claude.push(sessionRecord('claude', 'shared-id', { cwd: f.main.path, summary: 'Claude one', lastUpdated: new Date(now) }));
  f.sessions.opencode.push(
    sessionRecord('opencode', 'ses_new', { cwd: f.main.path, summary: 'New', lastUpdated: new Date(now - 1000) }),
    sessionRecord('opencode', 'ses_old', { cwd: f.main.path, summary: 'Imported', lastUpdated: new Date(now - 2000) })
  );
  f.chat('opencode', 'Imported', 'ses_old');
  f.chat('opencode', 'Same ID, other harness', 'shared-id');
  f.storage.rememberRemovedSession('opencode', 'ses_new');

  let offered: string[] = [];
  stub.__setQuickPickHandler((items) => {
    offered = items.map((item: { harness: string; session: HarnessSession }) => `${item.harness}:${item.session.sessionId}`);
    return items.filter((item: { harness: string }) => item.harness === 'opencode');
  });
  await runCommand('agntree.importSessions', f.worktreeRow(f.main));
  assert.deepEqual(offered, ['claude:shared-id', 'opencode:ses_new']);
  assert.equal(f.chatsIn(f.main).find((chat) => chat.harnessSessionId === 'ses_new')?.name, 'New');
  assert.equal(f.storage.getRemovedSessionKeys().size, 0, 'a manual import undoes an earlier removal');
});

test('Go to Next Session That Needs You opens the longest-waiting one, skips a removed chat, and says so when none waits', async (t) => {
  const f = setup(t);
  const waiting = f.chat('claude', 'Waiting', 'claude-1');
  f.needingYou.push('removed-chat', waiting.id);
  await runCommand('agntree.openNextSessionNeedingYou');
  assert.equal(f.lastTerminal().sent[0], 'claude --resume claude-1');
  assert.deepEqual(f.activated, [waiting.id], 'its row is selected, which clears the flag');

  f.needingYou.length = 0;
  await runCommand('agntree.openNextSessionNeedingYou');
  assert.ok(shown('No session is waiting for you.'));
});

test('with several session rows selected, Remove, Close, Star and Unstar apply to all of them', async (t) => {
  const f = setup(t);
  const [a, b, other] = [f.chat('claude', 'One', 'claude-1'), f.chat('codex', 'Two', 'codex-1'), f.chat('codex', 'Other', 'codex-2')];
  const rows = [f.row(a), f.row(b)];

  f.storage.toggleStar(a.id);
  await runCommand('agntree.starChat', rows[1], rows);
  assert.deepEqual([...f.storage.getStarredChatIds()].sort(), [a.id, b.id].sort(), 'an already-starred row stays starred');
  await runCommand('agntree.unstarChat', rows[0], rows);
  assert.equal(f.storage.getStarredChatIds().size, 0);

  await runCommand('agntree.openChatInTerminal', rows[0]);
  await runCommand('agntree.openChatInTerminal', rows[1]);
  await runCommand('agntree.closeChat', rows[0], rows);
  assert.deepEqual([a, b].map((chat) => f.terminals.isActive(chat.id)), [false, false]);

  stub.__warningResponses.push('Remove');
  await runCommand('agntree.deleteChat', rows[0], rows);
  assert.ok(shown('Remove 2 sessions from the list?'), 'the confirmation counts and names them');
  assert.ok(shown('• One') && shown('• Two'));
  assert.deepEqual(f.chatsIn(f.main).map((chat) => chat.id), [other.id]);

  // A click on a row outside the selection acts on that row alone.
  const [c, d] = [f.chat('claude', 'Three', 'claude-3'), f.chat('claude', 'Four', 'claude-4')];
  await runCommand('agntree.starChat', f.row(other), [f.row(c), f.row(d)]);
  assert.deepEqual([...f.storage.getStarredChatIds()], [other.id]);
});

test('Copy Resume Command and Copy Session ID copy a linked session; an unstarted one is explained', async (t) => {
  const f = setup(t);
  const linked = f.chat('claude', 'Linked', 'claude-1');
  await runCommand('agntree.copyResumeCommand', f.row(linked));
  assert.equal(await vscode.env.clipboard.readText(), `cd ${f.main.path} && claude --resume claude-1`);
  await runCommand('agntree.copySessionId', f.row(linked));
  assert.equal(await vscode.env.clipboard.readText(), 'claude-1');

  await runCommand('agntree.copySessionId', f.row(f.chat('claude', 'Unstarted')));
  assert.equal(await vscode.env.clipboard.readText(), 'claude-1', 'nothing is copied');
  assert.ok(shown('This session has no ID yet.'));
});

test('run from the keyboard, a row command acts on the selected rows and New Session starts in the worktree on show', async (t) => {
  const f = setup(t);
  stub.__setConfiguration('defaultHarness', 'codex');
  t.after(() => stub.__setConfiguration('defaultHarness', undefined));
  const [a, b] = [f.chat('claude', 'One', 'claude-1'), f.chat('claude', 'Two', 'claude-2')];

  // One selected row: Rename and Copy Resume Command act on it.
  f.selectedRows.push(f.row(a));
  stub.__inputResponses.push('Renamed');
  await runCommand('agntree.renameChat');
  assert.equal(f.storage.getChat(a.id)?.name, 'Renamed');
  await runCommand('agntree.copyResumeCommand');
  assert.equal(await vscode.env.clipboard.readText(), `cd ${f.main.path} && claude --resume claude-1`);

  // Several selected rows: Rename does nothing, Remove takes them all; a worktree row in the selection is ignored.
  f.selectedRows.push(f.row(b), f.worktreeRow(f.main));
  await runCommand('agntree.renameChat');
  assert.equal(f.storage.getChat(a.id)?.name, 'Renamed');
  stub.__warningResponses.push('Remove');
  await runCommand('agntree.deleteChat');
  assert.deepEqual(f.chatsIn(f.main), []);

  // No row: the default agent starts in the worktree the panels show, without asking.
  f.active.worktree = f.feature;
  await runCommand('agntree.newDefaultSession');
  assert.deepEqual(f.chatsIn(f.feature).map((chat) => chat.harness), ['codex']);
  assert.equal(f.lastTerminal().options.cwd, f.feature.path);
});

test('Remove and Clear All drop chats only after confirmation, and removed sessions stay out of auto-import', async (t) => {
  const f = setup(t);
  const removed = f.chat('claude', 'Remove me', 'claude-1');
  f.chat('codex', 'Feature one', 'codex-1', f.feature);
  f.chat('codex', 'Feature two', 'codex-2', f.feature);

  stub.__warningResponses.push(undefined);
  await runCommand('agntree.deleteChat', f.row(removed));
  assert.ok(f.storage.getChat(removed.id), 'cancel keeps the chat');
  stub.__warningResponses.push('Remove');
  await runCommand('agntree.deleteChat', f.row(removed));
  assert.equal(f.storage.getChat(removed.id), undefined);

  stub.__warningResponses.push('Clear All');
  await runCommand('agntree.clearWorktreeSessions', f.worktreeRow(f.feature));
  assert.ok(shown('Clear all 2 session(s) from "feature-x"?'));
  assert.deepEqual(f.chatsIn(f.feature), []);
  assert.deepEqual([...f.storage.getRemovedSessionKeys()].sort(), ['claude:claude-1', 'codex:codex-1', 'codex:codex-2']);
});
