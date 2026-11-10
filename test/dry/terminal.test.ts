/**
 * TerminalManager: what a launch sends, what a closed terminal leaves behind,
 * and how terminals are reconciled after a reload (the pty survives) or a quit
 * (VS Code revives the tab as a new shell). See ADR 0009.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { TerminalManager } from '../../src/services/TerminalManager';
import { terminalTitle } from '../../src/services/terminalEvents';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { HarnessAdapter } from '../../src/harnesses/types';
import { ChatSession, STORAGE_KEYS } from '../../src/types';
import { chatRecord, fakeAdapter, FakeTerminal, flush, makeStorage, memento, shown, stub, waitFor, worktreeRecord } from './support';

beforeEach(() => stub.__reset());

/** Spaces force the restore path to quote the directory it changes into. */
const WORKTREE = worktreeRecord({ path: '/work/repo with space' });

function setup(
  t: { after(fn: () => void): void },
  options: { chats?: Partial<ChatSession>[]; adapter?: Partial<HarnessAdapter> } = {}
) {
  const globalState = memento();
  void globalState.update(
    STORAGE_KEYS.CHATS,
    (options.chats ?? []).map((chat) => chatRecord({ worktreeId: WORKTREE.id, ...chat }))
  );
  const storage = makeStorage(globalState);
  const registrations: string[] = [];
  const adapter = fakeAdapter('claude', { icon: 'sparkle', ...options.adapter });
  const manager = new TerminalManager(storage, new HarnessRegistry([adapter]), {
    registerPendingChat: (_harness: string, chatId: string, worktreePath: string) =>
      registrations.push(`${chatId}@${worktreePath}`),
  } as never);
  t.after(() => manager.dispose());

  vscode.commands.registerCommand('agntree.refreshWorkspaces', () => undefined);
  // The rename command targets whichever terminal is active, like the workbench.
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', (arg: { name: string }) => {
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });

  return {
    storage,
    manager,
    registrations,
    chat: (id: string) => storage.getChat(id)!,
    open: async (id: string) => (await manager.openChat(storage.getChat(id)!, WORKTREE)) as FakeTerminal | undefined,
    /** A tab already in the window at activation, with its own pty. */
    restoredTab: (name: string, pid: number, exited = false) =>
      stub.window.createTerminal({ name, __pid: pid, __exitStatus: exited ? { code: 0 } : undefined }),
    close: (terminal: FakeTerminal) => {
      terminal.dispose();
      stub.window.__fireDidCloseTerminal(terminal);
    },
  };
}

test('a launch resumes, starts, or repeats a fork depending on what the harness already has', async (t) => {
  const cases: [Partial<ChatSession>, string][] = [
    [{}, 'claude'],
    [{ pendingHarnessSessionId: 'chosen' }, 'claude --session-id chosen'],
    [{ pendingHarnessSessionId: 'written' }, 'claude --resume written'],
    [{ pendingHarnessSessionId: 'chosen', forkedFromSessionId: 'source' }, 'claude --fork source --session-id chosen'],
    [{ pendingHarnessSessionId: 'written', forkedFromSessionId: 'source' }, 'claude --resume written'],
    [{ harnessSessionId: 'linked' }, 'claude --resume linked'],
  ];
  const f = setup(t, {
    chats: cases.map(([chat], i) => ({ id: `chat-${i}`, name: `Chat ${i}`, ...chat })),
    adapter: { isSessionResumable: async (id) => id === 'written' || id === 'linked' },
  });

  for (const [i, [chat, expected]] of cases.entries()) {
    assert.equal((await f.open(`chat-${i}`))?.sent[0], expected, JSON.stringify(chat));
  }

  const terminal = f.manager.getTerminal('chat-5') as unknown as FakeTerminal;
  assert.deepEqual([terminal.options.cwd, terminal.options.iconPath?.id], [WORKTREE.path, 'sparkle']);
  assert.equal(terminal.name, 'Agntree: Chat 5 [chat-5]', 'the title is applied once the command runs');
  assert.equal(f.chat('chat-5').status, 'active');
  assert.equal(f.storage.getTerminalPids()['chat-5'], terminal.__pid, 'the pty is recorded for a reload');
  assert.equal(f.manager.getChatIdForTerminalName(terminal.name), 'chat-5');
});

test('a missing session or a failing launch opens nothing and says why', async (t) => {
  const f = setup(t, {
    chats: [{ id: 'gone', harnessSessionId: 'gone' }, { id: 'broken' }],
    adapter: {
      isSessionResumable: async () => false,
      buildLaunchCommand: () => {
        throw new Error('bad settings');
      },
    },
  });
  assert.equal(await f.open('gone'), undefined);
  assert.ok(shown('Session not found in Claude Code'));
  assert.equal(await f.open('broken'), undefined);
  assert.ok(shown('Could not open the Claude Code session: bad settings'));
  assert.equal(stub.window.terminals.length, 0);
});

test('an open chat is focused, not relaunched; an exited process is replaced', async (t) => {
  const f = setup(t, { chats: [{ id: 'chat', harnessSessionId: 'linked' }] });
  const first = (await f.open('chat'))!;
  assert.equal(await f.open('chat'), first);
  assert.equal(stub.window.terminals.length, 1);

  first.exitStatus = { code: 0 };
  assert.equal(f.manager.isActive('chat'), false, 'a tab whose process exited is not open');
  const second = (await f.open('chat'))!;
  assert.notEqual(second, first);
  assert.ok(first.disposed);
});

test('a shell without integration still gets the launch command, without waiting for it to start', async (t) => {
  stub.__setConfiguration('shellIntegration.enabled', false);
  stub.__setSilentExecutionEvents(true);
  const f = setup(t, { chats: [{ id: 'chat' }] });
  const opened = await Promise.race([f.open('chat'), flush().then(() => 'still waiting' as const)]);
  assert.notEqual(opened, 'still waiting');
  assert.equal((opened as FakeTerminal).sent[0], 'claude');
});

test('closing a terminal keeps what can be resumed and drops what cannot', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'linked', harnessSessionId: 'linked' },
      { id: 'unlinked' }, // the harness assigns IDs and never linked one
      { id: 'pending', pendingHarnessSessionId: 'chosen' }, // relaunching reuses the ID
      { id: 'unused-fork', pendingHarnessSessionId: 'chosen-fork', forkedFromSessionId: 'source' },
      { id: 'prompted-fork', pendingHarnessSessionId: 'written', forkedFromSessionId: 'source' },
    ],
    adapter: { isSessionResumable: async (id) => id === 'linked' || id === 'written' },
  });
  for (const id of ['linked', 'unlinked', 'pending', 'unused-fork', 'prompted-fork']) {
    f.close((await f.open(id))!);
  }

  // A fork that never wrote a transcript exists only in the closed process;
  // reopening it would fork from wherever the source has moved since.
  await waitFor(() => !f.storage.getChat('unused-fork'), 'the unused fork to be dropped');
  assert.deepEqual(
    f.storage.getChats().map((chat) => `${chat.id}:${chat.status}`),
    ['linked:closed', 'pending:closed', 'prompted-fork:closed']
  );
});

test('after a reload, a tab whose pty has the recorded PID is adopted and never typed into', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'abcdef00-live', harnessSessionId: 'linked', status: 'active' },
      { id: 'ab12cd00-unlinked', status: 'active' },
      { id: 'ccddee00-exited', status: 'active' },
      { id: 'eeff0000-late', harnessSessionId: 'linked', status: 'active' },
    ],
  });
  const pids: Record<string, number> = { 'abcdef00-live': 7001, 'ab12cd00-unlinked': 7002, 'ccddee00-exited': 7003, 'eeff0000-late': 7004 };
  for (const [id, pid] of Object.entries(pids)) await f.storage.rememberTerminalPid(id, pid);
  const live = f.restoredTab('a title the user typed', 7001);
  const unlinked = f.restoredTab('Agntree: Unlinked [ab12cd]', 7002);
  f.restoredTab('Agntree: Exited [ccddee]', 7003, true);
  stub.window.__setActiveTerminal(live);

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  await restore.complete;
  assert.ok(f.manager.isActive('abcdef00-live'));
  assert.equal(live.name, terminalTitle(f.chat('abcdef00-live')), 'the focused tab gets its title back');
  assert.ok(f.manager.isActive('ab12cd00-unlinked'));
  assert.deepEqual(f.registrations, [`ab12cd00-unlinked@${WORKTREE.path}`], 'only the unlinked chat needs its watcher again');
  assert.ok(!f.manager.isActive('ccddee00-exited'));
  assert.equal(f.chat('ccddee00-exited').status, 'idle');

  const late = f.restoredTab('Agntree: Late [eeff00]', 7004);
  stub.window.__fireDidOpenTerminal(late);
  await waitFor(() => f.manager.isActive('eeff0000-late'), 'a tab restored after activation');
  assert.deepEqual([live, unlinked, late].map((tab) => tab.sent.length), [0, 0, 0], 'a live agent is never typed into');
});

test('after a quit, each revived tab resumes its own chat in its worktree, quietly and in the background', async (t) => {
  const f = setup(t, {
    chats: [
      { id: 'aabbcc00-revived', harnessSessionId: 'linked', status: 'closed' },
      { id: 'cd34ef00-unlinked', status: 'closed' },
      { id: 'ffeedd00-duplicate', harnessSessionId: 'linked', status: 'closed' },
      { id: 'ddeeff00-same-pty', harnessSessionId: 'linked', status: 'active' },
      { id: '11223300-fork', forkedFromSessionId: 'source', status: 'closed' },
      { id: '44556600-gone', harnessSessionId: 'gone', status: 'closed' },
      { id: '99aabb00-stale', status: 'active' },
      { id: '77889900-foreign', status: 'active' }, // another window's chat: no PID here
    ],
    adapter: { isSessionResumable: async (id) => id !== 'gone' },
  });
  const recorded: [string, number][] = [
    ['aabbcc00-revived', 7001], ['cd34ef00-unlinked', 7002], ['ffeedd00-duplicate', 7003],
    ['ddeeff00-same-pty', 7004], ['11223300-fork', 7005], ['44556600-gone', 7006], ['99aabb00-stale', 7007],
  ];
  for (const [id, pid] of recorded) await f.storage.rememberTerminalPid(id, pid);
  const revived = f.restoredTab('Agntree: Revived [aabbcc]', 8001);
  const unlinked = f.restoredTab('Agntree: Unlinked [cd34ef]', 8002);
  const duplicateFirst = f.restoredTab('Agntree: Duplicate [ffeedd]', 8003);
  const duplicateSecond = f.restoredTab('Agntree: Duplicate [ffeedd]', 8004);
  const samePty = f.restoredTab('Agntree: Same [ddeeff]', 7004);
  const fork = f.restoredTab('Agntree: Fork [112233]', 8005);
  const gone = f.restoredTab('Agntree: Gone [445566]', 8006);
  const previous = f.restoredTab('an unrelated shell', 9000);
  stub.window.__setActiveTerminal(previous);

  // The extension's focus listener: retitle activations are not selections.
  const selections: unknown[] = [];
  let background = 0;
  vscode.window.onDidChangeActiveTerminal((terminal) => {
    if (!terminal) return;
    if (f.manager.consumeBackgroundActivation(terminal)) background++;
    else selections.push(terminal);
  });

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  await restore.complete;
  const cd = `cd '${WORKTREE.path}' && `;
  assert.deepEqual(
    [revived, unlinked, duplicateFirst, duplicateSecond, samePty, fork, gone].map((tab) => tab.sent[0]),
    [`${cd}claude --resume linked`, `${cd}claude`, `${cd}claude --resume linked`, undefined, undefined, undefined, undefined]
  );
  assert.equal(f.manager.getTerminal('ffeedd00-duplicate'), duplicateFirst as unknown, 'the first same-titled tab owns the chat');
  assert.equal(f.storage.getTerminalPids()['aabbcc00-revived'], 8001, 'the new pty replaces the old record');
  assert.deepEqual(f.registrations, [`cd34ef00-unlinked@${WORKTREE.path}`]);
  assert.equal(stub.__messages.length, 0, 'a missing session is skipped without a warning');
  assert.deepEqual([f.chat('99aabb00-stale').status, f.chat('77889900-foreign').status], ['idle', 'active']);

  await waitFor(() => background >= 4, 'three retitles and the return to the previous tab');
  assert.equal(stub.window.activeTerminal, previous);
  assert.deepEqual(selections, [], 'retitling is not a user focus change');
  stub.window.__setActiveTerminal(revived);
  assert.deepEqual(selections, [revived], 'a real focus change still is');
});

test('overlapping focus changes never swap two tabs’ titles', async (t) => {
  const f = setup(t, {
    chats: [
      { id: '0a0a0a00-a', name: 'Race A', harnessSessionId: 'a', status: 'active' },
      { id: '0b0b0b00-b', name: 'Race B', harnessSessionId: 'b', status: 'active' },
    ],
  });
  await f.storage.rememberTerminalPid('0a0a0a00-a', 7101);
  await f.storage.rememberTerminalPid('0b0b0b00-b', 7102);
  const tabA = f.restoredTab('stale-a', 7101);
  const tabB = f.restoredTab('stale-b', 7102);
  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.complete;

  // The workbench resolves the active tab when the rename runs, one hop later.
  const writes: { intended: string; target: unknown }[] = [];
  vscode.commands.registerCommand('workbench.action.terminal.renameWithArg', async (arg: { name: string }) => {
    await Promise.resolve();
    writes.push({ intended: arg.name, target: stub.window.activeTerminal });
    if (stub.window.activeTerminal) stub.window.activeTerminal.name = arg.name;
  });
  const titleA = terminalTitle(f.chat('0a0a0a00-a'));
  const titleB = terminalTitle(f.chat('0b0b0b00-b'));
  stub.window.__setActiveTerminal(tabA);
  stub.window.__setActiveTerminal(tabB);
  await waitFor(() => tabB.name === titleB, 'the last focused tab to get its title');
  assert.ok(writes.every(({ intended, target }) => (intended === titleA ? target === tabA : target === tabB)));
  assert.notEqual(tabA.name, titleB);

  stub.window.__setActiveTerminal(tabA);
  await waitFor(() => tabA.name === titleA, 'the refocused tab to get its title');
});

test('adoption does not wait for a slow harness check, and a click meanwhile focuses the restored tab', async (t) => {
  let release: (resumable: boolean) => void = () => undefined;
  const f = setup(t, {
    chats: [{ id: '5a5a5a00-slow', harnessSessionId: 'slow', status: 'closed' }],
    adapter: { isSessionResumable: () => new Promise<boolean>((resolve) => (release = resolve)) },
  });
  await f.storage.rememberTerminalPid('5a5a5a00-slow', 7201);
  const tab = f.restoredTab('Agntree: Slow [5a5a5a]', 7202);

  const restore = f.manager.beginRestoreSync(() => WORKTREE);
  await restore.adopted;
  let complete = false;
  void restore.complete.then(() => (complete = true));
  await flush();
  assert.equal(complete, false);
  assert.ok(f.manager.isResuming('5a5a5a00-slow'), 'the restored tab is still this chat’s');

  assert.equal(await f.open('5a5a5a00-slow'), tab, 'a click focuses the tab instead of starting a second agent');
  assert.deepEqual([tab.sent.length, stub.window.terminals.length], [0, 1]);

  release(true);
  await restore.complete;
  assert.equal(tab.sent[0], `cd '${WORKTREE.path}' && claude --resume slow`);
  assert.ok(!f.manager.isResuming('5a5a5a00-slow'));
});

test('a storage failure while adopting a late tab stays contained', async (t) => {
  const f = setup(t, { chats: [{ id: '6b6b6b00-late', harnessSessionId: 'late', status: 'active' }] });
  await f.storage.rememberTerminalPid('6b6b6b00-late', 7301);
  f.storage.rememberTerminalPid = async () => {
    throw new Error('storage unavailable');
  };
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  const error = console.error;
  console.error = () => undefined;
  t.after(() => {
    process.off('unhandledRejection', record);
    console.error = error;
  });

  stub.window.__fireDidOpenTerminal(f.restoredTab('Agntree: Late [6b6b6b]', 7301));
  await flush();
  await flush();
  assert.deepEqual(unhandled, []);
});
