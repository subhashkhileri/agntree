import * as vscode from 'vscode';
import { TerminalManager } from '../../src/services/TerminalManager';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { HarnessWatcherRegistry } from '../../src/services/HarnessWatcherRegistry';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { OpencodeHarness } from '../../src/harnesses/OpencodeHarness';
import { CodexHarness } from '../../src/harnesses/CodexHarness';

const REPO = process.cwd();
const OPENCODE_CWD = process.cwd();

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

/** The vscode stub's terminal exposes capture fields the public type omits. */
type StubTerminal = vscode.Terminal & {
  sent: string[];
  options: { cwd?: string; iconPath?: { id: string } };
  disposed: boolean;
  __pid: number;
};

function stubTerminal(terminal: vscode.Terminal | undefined): StubTerminal {
  if (!terminal) {
    throw new Error('Expected a terminal to be opened');
  }
  return terminal as StubTerminal;
}

/** Yield to the close handler's async resumability check without sleeping. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** The storage surface TerminalManager and the commands use, over plain maps. */
function makeStorage(
  chats: Map<string, any>,
  pids: Map<string, number>
): Record<string, any> {
  return {
    getChat: (id: string) => chats.get(id),
    getChats: () => Array.from(chats.values()),
    updateChat: (id: string, updates: Record<string, unknown>) => {
      const chat = chats.get(id);
      if (chat) Object.assign(chat, updates);
      return chat;
    },
    deleteChat: (id: string) => chats.delete(id),
    touchChat: (id: string) => {
      const chat = chats.get(id);
      if (chat) chat.lastAccessedAt = Date.now();
    },
    getTerminalPids: () => Object.fromEntries(pids),
    rememberTerminalPid: async (id: string, pid: number) => {
      pids.set(id, pid);
    },
  };
}

async function main(): Promise<void> {
  const chats = new Map<string, any>();
  const terminalPids = new Map<string, number>();
  let nextId = 0;

  function addChat(partial: Record<string, unknown>): any {
    const id = `chat-${String(++nextId).padStart(3, '0')}`;
    const chat = {
      id,
      worktreeId: 'wt-1',
      name: `Session ${nextId}`,
      harness: 'claude',
      harnessSessionId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      status: 'idle',
      baseCommit: null,
      ...partial,
    };
    chats.set(id, chat);
    return chat;
  }

  const storage = makeStorage(chats, terminalPids);

  const codexHarness = new CodexHarness({
    appServer: {
      readThread: async (threadId: string) => {
        if (threadId === 'codex-session') {
          return {
            thread: {
              id: threadId,
              cwd: REPO,
              createdAt: 0,
              updatedAt: 0,
            },
          };
        }
        throw new Error('thread not found');
      },
      dispose: () => undefined,
    } as any,
  });

  const registry = new HarnessRegistry([
    new ClaudeHarness(),
    new OpencodeHarness(),
    codexHarness,
  ]);
  const manager = new TerminalManager(
    storage as any,
    registry,
    new HarnessWatcherRegistry([])
  );

  await (vscode as any).commands.registerCommand(
    'agntree.refreshWorkspaces',
    () => undefined
  );

  // The rename command targets the active terminal, exactly like the workbench.
  const renamedTitles = new Set<vscode.Terminal>();
  await (vscode as any).commands.registerCommand(
    'workbench.action.terminal.renameWithArg',
    (arg: { name: string }) => {
      const terminal = (vscode as any).window.activeTerminal;
      if (terminal) {
        terminal.name = arg.name;
        renamedTitles.add(terminal);
      }
    }
  );

  console.log('\n== Claude launch commands ==');
  const claudeNew = addChat({ harness: 'claude', name: 'Claude New' });
  const claudeNewTerminal = stubTerminal(
    await manager.openChat(claudeNew, { path: REPO } as any)
  );
  check(claudeNewTerminal.sent[0] === 'claude', 'new Claude chat sends "claude"');
  check(claudeNewTerminal.options.cwd === REPO, 'terminal cwd is the worktree');
  check(
    claudeNewTerminal.options.iconPath?.id === 'sparkle',
    'Claude terminal uses the sparkle icon'
  );
  check(claudeNew.status === 'active', 'opened chat is marked active');
  await waitFor(
    () => renamedTitles.has(claudeNewTerminal),
    'the title to be applied in the background'
  );
  check(
    renamedTitles.has(claudeNewTerminal),
    'a new terminal is given the chat title once its pty exists'
  );
  check(
    terminalPids.get(claudeNew.id) === claudeNewTerminal.__pid,
    'the terminal pty id is recorded for the chat'
  );

  console.log('\n== shell without command-start events ==');
  (vscode as any).__setConfiguration('shellIntegration.enabled', false);
  (vscode as any).__setSilentExecutionEvents(true);
  const silentChat = addChat({ harness: 'claude', name: 'Silent Shell' });
  const silentResult = await Promise.race([
    manager
      .openChat(silentChat, { path: REPO } as any)
      .then((terminal) => ({ terminal })),
    new Promise<undefined>((resolve) => setImmediate(() => resolve(undefined))),
  ]);
  (vscode as any).__setSilentExecutionEvents(false);
  (vscode as any).__setConfiguration('shellIntegration.enabled', undefined);
  check(
    silentResult !== undefined,
    'opening a chat does not wait for a command-start event'
  );
  check(
    Boolean(silentResult) &&
      stubTerminal(silentResult?.terminal).sent[0] === 'claude',
    'a shell that reports no command start still receives the launch command'
  );

  console.log('\n== missing session ==');
  const missing = addChat({
    harness: 'claude',
    name: 'Missing',
    harnessSessionId: '00000000-0000-0000-0000-000000000000',
  });
  const messagesBefore = (vscode as any).__messages.length;
  const missingTerminal = await manager.openChat(missing, { path: REPO } as any);
  check(missingTerminal === undefined, 'missing session does not open a terminal');
  check(!manager.isActive(missing.id), 'missing session does not stay active');
  const missingMessages = (vscode as any).__messages.slice(messagesBefore);
  check(
    missingMessages.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' &&
        args[0].includes('Session not found in Claude Code')
    ),
    'missing-session warning names the harness'
  );

  console.log('\n== opencode launch commands ==');
  const opencodeNew = addChat({ harness: 'opencode', name: 'Opencode New' });
  const opencodeNewTerminal = stubTerminal(
    await manager.openChat(opencodeNew, {
      path: OPENCODE_CWD,
    } as any)
  );
  check(opencodeNewTerminal.sent[0] === 'opencode', 'new opencode chat sends "opencode"');
  check(
    opencodeNewTerminal.options.iconPath?.id === 'code',
    'opencode terminal uses the code icon'
  );

  const opencodeMissing = addChat({
    harness: 'opencode',
    name: 'Opencode Missing',
    harnessSessionId: 'ses_doesnotexist',
  });
  const opencodeMissingMessages = (vscode as any).__messages.length;
  const opencodeMissingTerminal = await manager.openChat(opencodeMissing, {
    path: OPENCODE_CWD,
  } as any);
  check(
    opencodeMissingTerminal === undefined,
    'missing opencode session does not open a terminal'
  );
  check(
    (vscode as any).__messages
      .slice(opencodeMissingMessages)
      .some(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          args[0].includes('Session not found in opencode')
      ),
    'missing opencode warning names the harness'
  );

  console.log('\n== codex launch commands ==');
  const codexNew = addChat({ harness: 'codex', name: 'Codex New' });
  const codexNewTerminal = stubTerminal(
    await manager.openChat(codexNew, {
      path: REPO,
    } as any)
  );
  check(codexNewTerminal.sent[0] === 'codex', 'new Codex chat sends "codex"');
  check(
    codexNewTerminal.options.iconPath?.id === 'terminal',
    'Codex terminal uses the terminal icon'
  );

  const codexResume = addChat({
    harness: 'codex',
    name: 'Codex Resume',
    harnessSessionId: 'codex-session',
  });
  const codexResumeTerminal = stubTerminal(
    await manager.openChat(codexResume, {
      path: REPO,
    } as any)
  );
  check(
    codexResumeTerminal.sent[0] === `codex resume codex-session --cd ${REPO}`,
    'Codex resume sends resume and --cd'
  );

  const codexFork = addChat({
    harness: 'codex',
    name: 'Codex Fork',
    forkedFromSessionId: 'codex-session',
  });
  const codexForkTerminal = stubTerminal(
    await manager.openChat(codexFork, { path: REPO } as any)
  );
  check(
    codexForkTerminal.sent[0] === `codex fork codex-session --cd ${REPO}`,
    'Codex terminal fork sends fork and --cd'
  );

  const codexMissing = addChat({
    harness: 'codex',
    name: 'Codex Missing',
    harnessSessionId: 'codex-missing',
  });
  const codexMissingMessages = (vscode as any).__messages.length;
  const codexMissingTerminal = await manager.openChat(codexMissing, {
    path: REPO,
  } as any);
  check(
    codexMissingTerminal === undefined,
    'missing Codex thread does not open a terminal'
  );
  check(
    (vscode as any).__messages
      .slice(codexMissingMessages)
      .some(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          args[0].includes('Session not found in Codex')
      ),
    'missing Codex warning names the harness'
  );

  console.log('\n== pending Claude IDs ==');
  {
    const pendingChats = new Map<string, any>();
    let pendingSerial = 0;
    const addPendingChat = (partial: Record<string, unknown>): any => {
      const id = `pending-${++pendingSerial}`;
      const chat = {
        id,
        worktreeId: 'wt-1',
        name: `Pending ${pendingSerial}`,
        harness: 'claude',
        harnessSessionId: null,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        status: 'idle',
        baseCommit: null,
        ...partial,
      };
      pendingChats.set(id, chat);
      return chat;
    };

    const pendingStorage = makeStorage(pendingChats, new Map());

    const pendingAdapter = {
      id: 'claude' as const,
      displayName: 'Claude Code',
      icon: 'sparkle',
      capabilities: {
        fork: true,
        move: false,
        newSessionId: true,
        preview: 'inline' as const,
      },
      isInstalled: async () => true,
      buildLaunchCommand: ({
        sessionId,
        newSessionId,
        forkFromSessionId,
      }: {
        sessionId?: string | null;
        newSessionId?: string | null;
        forkFromSessionId?: string | null;
      }) => {
        if (forkFromSessionId) {
          return `claude --resume ${forkFromSessionId} --fork-session --session-id ${newSessionId}`;
        }
        if (sessionId) {
          return `claude --resume ${sessionId}`;
        }
        if (newSessionId) {
          return `claude --session-id ${newSessionId}`;
        }
        return 'claude';
      },
      isSessionResumable: async (id: string) => id === 'resumable-pending',
      listSessionsForWorktree: async () => [],
      listSessionsForRepository: async () => [],
      getSessionMetadata: async () => null,
      getPreview: async () => [],
      forkSession: async () => ({
        kind: 'terminal' as const,
        pendingSessionId: 'new-fork-id',
      }),
      moveSession: async () => undefined,
      prepareForkToNewWorktree: async () => ({
        kind: 'terminal' as const,
        pendingSessionId: 'new-fork-id',
      }),
    };

    const pendingManager = new TerminalManager(
      pendingStorage as any,
      new HarnessRegistry([pendingAdapter]),
      new HarnessWatcherRegistry([])
    );

    const fresh = addPendingChat({
      pendingHarnessSessionId: 'fresh-pending-id',
    });
    const freshTerminal = stubTerminal(
      await pendingManager.openChat(fresh, { path: REPO } as any)
    );
    check(
      freshTerminal.sent[0] === 'claude --session-id fresh-pending-id',
      'a new Claude chat passes its chosen ID'
    );

    const resumable = addPendingChat({
      pendingHarnessSessionId: 'resumable-pending',
    });
    const resumableTerminal = stubTerminal(
      await pendingManager.openChat(resumable, { path: REPO } as any)
    );
    check(
      resumableTerminal.sent[0] === 'claude --resume resumable-pending',
      'a pending ID with a transcript is resumed instead of relaunched'
    );

    const storedFork = addPendingChat({
      pendingHarnessSessionId: 'stored-fork-pending-id',
      forkedFromSessionId: 'stored-fork-source-id',
    });
    const storedForkTerminal = stubTerminal(
      await pendingManager.openChat(storedFork, { path: REPO } as any)
    );
    check(
      storedForkTerminal.sent[0] ===
        'claude --resume stored-fork-source-id --fork-session --session-id stored-fork-pending-id',
      'reopening a pending fork repeats it from the stored source'
    );

    const resumableFork = addPendingChat({
      pendingHarnessSessionId: 'resumable-pending',
      forkedFromSessionId: 'stored-fork-source-id',
    });
    const resumableForkTerminal = stubTerminal(
      await pendingManager.openChat(resumableFork, { path: REPO } as any)
    );
    check(
      resumableForkTerminal.sent[0] === 'claude --resume resumable-pending',
      'a fork with a transcript resumes instead of forking again'
    );

    const closePending = addPendingChat({
      pendingHarnessSessionId: 'close-pending-id',
    });
    await pendingManager.openChat(closePending, { path: REPO } as any);
    const closePendingTerminal = pendingManager.getTerminal(closePending.id);
    const allTerminals = (vscode as any).window.terminals;
    allTerminals.splice(allTerminals.indexOf(closePendingTerminal), 1);
    (vscode as any).window.__fireDidCloseTerminal(closePendingTerminal);
    check(
      pendingStorage.getChat(closePending.id)?.status === 'closed',
      'closing a pending Claude chat keeps it for the same-ID relaunch'
    );

    const unusedFork = addPendingChat({
      pendingHarnessSessionId: 'unused-fork-pending-id',
      forkedFromSessionId: 'source-session-id',
    });
    await pendingManager.openChat(unusedFork, { path: REPO } as any);
    const unusedForkTerminal = pendingManager.getTerminal(unusedFork.id);
    const unusedForkTerminals = (vscode as any).window.terminals;
    unusedForkTerminals.splice(
      unusedForkTerminals.indexOf(unusedForkTerminal),
      1
    );
    (vscode as any).window.__fireDidCloseTerminal(unusedForkTerminal);
    await waitFor(
      () => !pendingStorage.getChat(unusedFork.id),
      'an unused fork to be dropped'
    );
    check(
      !pendingStorage.getChat(unusedFork.id),
      'closing an unused fork removes the chat instead of keeping a stale fork point'
    );

    const promptedFork = addPendingChat({
      pendingHarnessSessionId: 'resumable-pending',
      forkedFromSessionId: 'source-session-id',
    });
    await pendingManager.openChat(promptedFork, { path: REPO } as any);
    const promptedForkTerminal = pendingManager.getTerminal(promptedFork.id);
    const promptedForkTerminals = (vscode as any).window.terminals;
    promptedForkTerminals.splice(
      promptedForkTerminals.indexOf(promptedForkTerminal),
      1
    );
    (vscode as any).window.__fireDidCloseTerminal(promptedForkTerminal);
    await waitFor(
      () => pendingStorage.getChat(promptedFork.id)?.status === 'closed',
      'a prompted fork to be marked closed'
    );
    check(
      Boolean(pendingStorage.getChat(promptedFork.id)),
      'a fork whose transcript exists is kept for the watcher to link'
    );

    pendingManager.dispose();
  }

  console.log('\n== terminal reuse + close semantics ==');
  const terminalCount = (vscode as any).window.terminals.length;
  const sameTerminal = await manager.openChat(claudeNew, { path: REPO } as any);
  check(sameTerminal === claudeNewTerminal, 'reopening a chat reuses its terminal');
  check(
    (vscode as any).window.terminals.length === terminalCount,
    'no extra terminal was created'
  );

  const closeNoSession = addChat({ harness: 'opencode', name: 'Close New' });
  await manager.openChat(closeNoSession, { path: OPENCODE_CWD } as any);
  const closeNoSessionTerminal = manager.getTerminal(closeNoSession.id);
  const terminals = (vscode as any).window.terminals;
  terminals.splice(terminals.indexOf(closeNoSessionTerminal), 1);
  (vscode as any).window.__fireDidCloseTerminal(closeNoSessionTerminal);
  check(!storage.getChat(closeNoSession.id), 'closing an unlinked session deletes the chat');

  const closeWithSession = addChat({
    harness: 'codex',
    name: 'Close Existing',
    harnessSessionId: 'codex-session',
  });
  await manager.openChat(closeWithSession, { path: REPO } as any);
  const closeWithSessionTerminal = manager.getTerminal(closeWithSession.id);
  check(
    manager.getChatIdForTerminalName(closeWithSessionTerminal?.name ?? '') ===
      closeWithSession.id,
    'a chat is resolved from its terminal title'
  );
  terminals.splice(terminals.indexOf(closeWithSessionTerminal), 1);
  (vscode as any).window.__fireDidCloseTerminal(closeWithSessionTerminal);
  check(
    storage.getChat(closeWithSession.id)?.status === 'closed',
    'closing a linked session marks the chat closed'
  );

  console.log('\n== sync after extension restart ==');
  {
    // Isolated chat store: this section reconciles its own restored tabs.
    const syncChats = new Map<string, any>();
    const syncPids = new Map<string, number>();
    const syncStorage = makeStorage(syncChats, syncPids);
    // Spaces force the restore path to quote the directory it changes into.
    const SYNC_WORKTREE = `${REPO}/worktree with space`;
    const pendingRegistrations: Array<{
      harness: string;
      chatId: string;
      worktreePath: string;
    }> = [];
    const syncWatchers = {
      registerPendingChat: (
        harness: string,
        chatId: string,
        worktreePath: string
      ) => {
        pendingRegistrations.push({ harness, chatId, worktreePath });
      },
    } as any;

    const addSyncChat = (id: string, partial: Record<string, unknown>): any => {
      const chat = {
        id,
        worktreeId: 'wt-sync',
        name: `Sync ${id.substring(0, 6)}`,
        harness: 'claude',
        harnessSessionId: null,
        createdAt: 1,
        lastAccessedAt: 1,
        status: 'idle',
        baseCommit: null,
        ...partial,
      };
      syncChats.set(id, chat);
      return chat;
    };

    const syncAdapter = {
      id: 'claude' as const,
      displayName: 'Claude Code',
      icon: 'sparkle',
      capabilities: {
        fork: true,
        move: false,
        newSessionId: true,
        preview: 'inline' as const,
      },
      isInstalled: async () => true,
      buildLaunchCommand: ({
        sessionId,
        newSessionId,
      }: {
        sessionId?: string | null;
        newSessionId?: string | null;
      }) =>
        sessionId
          ? `claude --resume ${sessionId}`
          : newSessionId
            ? `claude --session-id ${newSessionId}`
            : 'claude',
      isSessionResumable: async (id: string) => id !== 'gone-session',
      listSessionsForWorktree: async () => [],
      listSessionsForRepository: async () => [],
      getSessionMetadata: async () => null,
      getPreview: async () => [],
      forkSession: async () => ({
        kind: 'terminal' as const,
        pendingSessionId: 'sync-fork',
      }),
      moveSession: async () => undefined,
      prepareForkToNewWorktree: async () => ({
        kind: 'terminal' as const,
        pendingSessionId: 'sync-fork',
      }),
    };

    const syncManager = new TerminalManager(
      syncStorage as any,
      new HarnessRegistry([syncAdapter]),
      syncWatchers
    );

    const makeRestored = (name: string, pid: number, exited = false): any =>
      (vscode as any).window.createTerminal({
        name,
        __pid: pid,
        __exitStatus: exited ? { code: 0 } : undefined,
      });

    // Reload: the pty survived, so a terminal with the stored pid is the live
    // agent and must never be typed into.
    const live = addSyncChat('abcdef00-1111-2222-3333-444455556666', {
      name: 'Live',
      harnessSessionId: 'linked-session',
      status: 'active',
    });
    syncPids.set(live.id, 7001);
    const liveTerminal = makeRestored('my own title [abcdef]', 7001);
    // Focus the adopted tab so its title is re-applied immediately.
    (vscode as any).window.__setActiveTerminal(liveTerminal);

    // Quit: the tab was revived as a new shell with a new pid under the stored
    // title; every such tab resumes in the background.
    const revived = addSyncChat('aabbcc00-1111-2222-3333-444455556666', {
      name: 'Revived',
      harnessSessionId: 'linked-session',
      status: 'closed',
    });
    syncPids.set(revived.id, 7002);
    const revivedTerminal = makeRestored('Agntree: Revived [aabbcc]', 7003);

    // A tab whose pty equals the recorded one is still the live agent.
    const guarded = addSyncChat('ddeeff00-1111-2222-3333-444455556666', {
      name: 'Guarded',
      harnessSessionId: 'linked-session',
      status: 'active',
    });
    syncPids.set(guarded.id, 7004);
    const guardedTerminal = makeRestored('Agntree: Guarded [ddeeff]', 7004);

    // A fork that never linked exists only inside the closed process.
    const fork = addSyncChat('11223300-1111-2222-3333-444455556666', {
      name: 'Fork',
      forkedFromSessionId: 'source-session',
      status: 'closed',
    });
    syncPids.set(fork.id, 7005);
    const forkTerminal = makeRestored('Agntree: Fork [112233]', 7006);

    // A missing native session is not announced during background resume.
    const gone = addSyncChat('44556600-1111-2222-3333-444455556666', {
      name: 'Gone',
      harnessSessionId: 'gone-session',
      status: 'closed',
    });
    syncPids.set(gone.id, 7007);
    const goneTerminal = makeRestored('Agntree: Gone [445566]', 7008);

    // Another window's chat: this window must not reconcile it.
    const foreign = addSyncChat('77889900-1111-2222-3333-444455556666', {
      name: 'Foreign',
      status: 'active',
    });
    // This window owns a chat whose terminal is gone.
    const stale = addSyncChat('99aabb00-1111-2222-3333-444455556666', {
      name: 'Stale',
      status: 'active',
    });
    syncPids.set(stale.id, 7010);

    // An exited restored tab is not adopted.
    const exitedRestored = addSyncChat('ccddee00-1111-2222-3333-444455556666', {
      name: 'Exited Restored',
      status: 'active',
    });
    syncPids.set(exitedRestored.id, 7011);
    makeRestored('Agntree: Exited Restored [ccddee]', 7011, true);

    // A chat with no native session must be re-registered with its watcher
    // after the extension host restarted, on both the reload and quit paths.
    const unlinkedLive = addSyncChat(
      'ab12cd00-1111-2222-3333-444455556666',
      { name: 'Unlinked Live', status: 'active' }
    );
    syncPids.set(unlinkedLive.id, 7013);
    const unlinkedLiveTerminal = makeRestored(
      'Agntree: Unlinked Live [ab12cd]',
      7013
    );

    const unlinkedRevived = addSyncChat(
      'cd34ef00-1111-2222-3333-444455556666',
      { name: 'Unlinked Revived', status: 'closed' }
    );
    syncPids.set(unlinkedRevived.id, 7014);
    const unlinkedRevivedTerminal = makeRestored(
      'Agntree: Unlinked Revived [cd34ef]',
      7015
    );

    // Two tabs with one title must not both start the same session.
    const duplicate = addSyncChat(
      'ffeedd00-1111-2222-3333-444455556666',
      {
        name: 'Duplicate',
        harnessSessionId: 'linked-session',
        status: 'closed',
      }
    );
    syncPids.set(duplicate.id, 7016);
    const duplicateFirst = makeRestored('Agntree: Duplicate [ffeedd]', 7017);
    const duplicateSecond = makeRestored('Agntree: Duplicate [ffeedd]', 7018);

    // Model the extension's focus listener: retitle activations are not user
    // selection changes.
    const userSelections: vscode.Terminal[] = [];
    let backgroundActivations = 0;
    const selectionListener = (vscode as any).window.onDidChangeActiveTerminal(
      (terminal: vscode.Terminal | undefined) => {
        if (!terminal) {
          return;
        }
        if (syncManager.consumeBackgroundActivation(terminal)) {
          backgroundActivations += 1;
          return;
        }
        userSelections.push(terminal);
      }
    );

    const messagesBeforeSync = (vscode as any).__messages.length;
    const sync = syncManager.beginRestoreSync(() => ({
      id: 'wt-sync',
      repoId: 'repo',
      name: 'sync',
      path: SYNC_WORKTREE,
      isMain: false,
    }));
    await sync.adopted;
    await sync.complete;

    check(syncManager.isActive(live.id), 'a live pty is re-associated by pid');
    check(
      liveTerminal.sent.length === 0,
      'an adopted live agent is never typed into'
    );
    check(
      liveTerminal.name === TerminalManager.getTerminalName(live),
      'an adopted tab gets the canonical title on focus'
    );

    check(syncManager.isActive(revived.id), 'a revived tab is re-associated');
    check(
      revivedTerminal.sent[0] ===
        `cd '${SYNC_WORKTREE}' && claude --resume linked-session`,
      'a revived tab changes into the chat worktree and resumes its session'
    );
    check(revived.status === 'active', 'a resumed chat is marked active');
    check(
      syncPids.get(revived.id) === 7003,
      'the revived pty id replaces the old one'
    );

    check(
      guardedTerminal.sent.length === 0,
      'a pty equal to the recorded one is not resumed'
    );
    check(forkTerminal.sent.length === 0, 'an unlinked fork is not resumed');
    check(
      goneTerminal.sent.length === 0,
      'a missing session is skipped quietly'
    );
    check(
      (vscode as any).__messages.length === messagesBeforeSync,
      'background resume shows no warnings'
    );

    check(
      foreign.status === 'active',
      "another window's live chat is not reconciled"
    );
    check(
      stale.status === 'idle',
      'a chat this window no longer has a terminal for is cleared'
    );
    check(
      !syncManager.isActive(exitedRestored.id),
      'sync does not re-associate an exited terminal'
    );
    check(
      exitedRestored.status === 'idle',
      'a chat whose restored terminal exited is marked idle'
    );

    check(
      syncManager.isActive(unlinkedLive.id),
      'an unlinked live chat is adopted without a session'
    );
    check(
      unlinkedLiveTerminal.sent.length === 0,
      'an adopted chat without a native session is never typed into'
    );
    check(
      pendingRegistrations.some(
        (registration) =>
          registration.harness === 'claude' &&
          registration.chatId === unlinkedLive.id &&
          registration.worktreePath === SYNC_WORKTREE
      ),
      'an adopted chat without a native session is registered with its watcher'
    );
    check(
      unlinkedRevivedTerminal.sent[0] === `cd '${SYNC_WORKTREE}' && claude`,
      'an unlinked revived chat starts a fresh session in its worktree'
    );
    check(
      pendingRegistrations.some(
        (registration) => registration.chatId === unlinkedRevived.id
      ),
      'a resumed chat without a native session is registered with its watcher'
    );
    check(
      duplicateFirst.sent[0] ===
        `cd '${SYNC_WORKTREE}' && claude --resume linked-session`,
      'the first of two same-titled tabs resumes the chat'
    );
    check(
      duplicateSecond.sent.length === 0,
      'a duplicate same-titled tab is not typed into'
    );
    check(
      syncManager.getTerminal(duplicate.id) === duplicateFirst,
      'the first same-titled tab owns the chat'
    );
    check(
      !pendingRegistrations.some(
        (registration) =>
          registration.chatId === live.id || registration.chatId === revived.id
      ),
      'chats with a native session are not registered as pending'
    );

    // A terminal that appears after activation is adopted by its recorded pty.
    const late = addSyncChat('eeff0011-1111-2222-3333-444455556666', {
      name: 'Late',
      harnessSessionId: 'linked-session',
      status: 'active',
    });
    syncPids.set(late.id, 7012);
    const lateTerminal = makeRestored('Agntree: Late [eeff00]', 7012);
    (vscode as any).window.__fireDidOpenTerminal(lateTerminal);
    await waitFor(
      () => syncManager.isActive(late.id),
      'a terminal opened after activation to be adopted'
    );
    check(
      lateTerminal.sent.length === 0,
      'a late restored terminal is adopted without being typed into'
    );

    // The retitle pass activates each revived tab to rename it, then restores
    // the previously active tab. None of those activations may look like a
    // user focus change.
    await waitFor(
      () => backgroundActivations >= 4,
      'the background retitle pass'
    );
    check(
      userSelections.length === 0,
      'background retitling does not look like a user focus change'
    );
    (vscode as any).window.__setActiveTerminal(liveTerminal);
    check(
      userSelections.includes(liveTerminal),
      'a real focus change is still reported'
    );
    selectionListener.dispose();

    syncManager.dispose();
  }

  console.log('\n== exited terminal processes ==');
  const exitedChat = addChat({ harness: 'claude', name: 'Exited Process' });
  const exitedTerminal = stubTerminal(
    await manager.openChat(exitedChat, { path: REPO } as any)
  );
  (exitedTerminal as any).exitStatus = { code: 0 };
  check(
    !manager.isActive(exitedChat.id),
    'a terminal whose process exited is not active'
  );
  check(
    !manager.getTerminal(exitedChat.id),
    'an exited terminal is not returned for the chat'
  );
  const relaunched = stubTerminal(
    await manager.openChat(exitedChat, { path: REPO } as any)
  );
  check(
    relaunched !== exitedTerminal,
    'reopening an exited chat launches a new terminal'
  );
  check(exitedTerminal.disposed, 'the exited terminal is cleaned up');
  check(relaunched.sent[0] === 'claude', 'the new terminal launches again');

  console.log('\n== overlapping title renames ==');
  {
    const raceChats = new Map<string, any>();
    const racePids = new Map<string, number>();
    const raceStorage = makeStorage(raceChats, racePids);
    const addRaceChat = (id: string, name: string, sessionId: string): any => {
      const chat = {
        id,
        worktreeId: 'wt-race',
        name,
        harness: 'claude',
        harnessSessionId: sessionId,
        createdAt: 1,
        lastAccessedAt: 1,
        status: 'active',
        baseCommit: null,
      };
      raceChats.set(id, chat);
      return chat;
    };

    const raceA = addRaceChat(
      '0a0a0a00-1111-2222-3333-444455556666',
      'Race A',
      'race-session-a'
    );
    const raceB = addRaceChat(
      '0b0b0b00-1111-2222-3333-444455556666',
      'Race B',
      'race-session-b'
    );
    racePids.set(raceA.id, 7101);
    racePids.set(raceB.id, 7102);
    const raceTerminalA = (vscode as any).window.createTerminal({
      name: 'stale-a',
      __pid: 7101,
    });
    const raceTerminalB = (vscode as any).window.createTerminal({
      name: 'stale-b',
      __pid: 7102,
    });

    const raceManager = new TerminalManager(
      raceStorage as any,
      registry,
      new HarnessWatcherRegistry([])
    );
    const raceSync = raceManager.beginRestoreSync(() => ({
      id: 'wt-race',
      repoId: 'repo',
      name: 'race',
      path: REPO,
      isMain: false,
    }));
    await raceSync.adopted;
    await raceSync.complete;
    check(
      raceManager.isActive(raceA.id) && raceManager.isActive(raceB.id),
      'rename race setup: both tabs are adopted'
    );

    // The workbench resolves the target when the rename runs, not when it is
    // queued; yield once to model the hop to the main process.
    const renameAttempts: Array<{
      intended: string;
      active: vscode.Terminal | undefined;
    }> = [];
    await (vscode as any).commands.registerCommand(
      'workbench.action.terminal.renameWithArg',
      async (arg: { name: string }) => {
        await Promise.resolve();
        const active = (vscode as any).window.activeTerminal;
        renameAttempts.push({ intended: arg.name, active });
        if (active) {
          active.name = arg.name;
        }
      }
    );

    const expectedA = TerminalManager.getTerminalName(raceA);
    const expectedB = TerminalManager.getTerminalName(raceB);
    raceTerminalA.name = 'stale-a';
    raceTerminalB.name = 'stale-b';

    // Two focus changes in one turn: the first rename must not target the
    // second tab, and the last focused tab must end with its own title.
    (vscode as any).window.__setActiveTerminal(raceTerminalA);
    (vscode as any).window.__setActiveTerminal(raceTerminalB);
    await waitFor(
      () => renameAttempts.length > 0 && raceTerminalB.name === expectedB,
      'the last focused tab to get its own title'
    );
    check(
      !renameAttempts.some(
        (attempt) =>
          (attempt.intended === expectedA && attempt.active === raceTerminalB) ||
          (attempt.intended === expectedB && attempt.active === raceTerminalA)
      ),
      'a queued title write never targets a different tab'
    );
    check(
      raceTerminalA.name !== expectedB && raceTerminalB.name !== expectedA,
      'overlapping focus changes do not swap two tabs titles'
    );

    (vscode as any).window.__setActiveTerminal(raceTerminalA);
    await waitFor(
      () => raceTerminalA.name === expectedA,
      'a refocused tab to get its own title'
    );
    check(
      raceTerminalA.name === expectedA,
      'refocusing a tab re-applies its own title'
    );

    raceManager.dispose();
  }

  console.log('\n== slow harness checks ==');
  {
    // Activation must finish adoption without waiting for a harness
    // resumability check; a click during that check owns the restored tab.
    const slowChats = new Map<string, any>();
    const slowPids = new Map<string, number>();
    const slowStorage = makeStorage(slowChats, slowPids);
    let releaseCheck: (value: boolean) => void = () => undefined;
    const slowAdapter = {
      id: 'claude' as const,
      displayName: 'Claude Code',
      icon: 'sparkle',
      capabilities: {
        fork: true,
        move: false,
        newSessionId: true,
        preview: 'inline' as const,
      },
      isInstalled: async () => true,
      buildLaunchCommand: ({ sessionId }: { sessionId?: string | null }) =>
        sessionId ? `claude --resume ${sessionId}` : 'claude',
      isSessionResumable: () =>
        new Promise<boolean>((resolve) => {
          releaseCheck = resolve;
        }),
      listSessionsForWorktree: async () => [],
      listSessionsForRepository: async () => [],
      getSessionMetadata: async () => null,
      getPreview: async () => [],
      forkSession: async () => ({
        kind: 'terminal' as const,
        pendingSessionId: 'slow-fork',
      }),
      moveSession: async () => undefined,
      prepareForkToNewWorktree: async () => ({
        kind: 'terminal' as const,
        pendingSessionId: 'slow-fork',
      }),
    };
    const slowManager = new TerminalManager(
      slowStorage as any,
      new HarnessRegistry([slowAdapter]),
      new HarnessWatcherRegistry([])
    );

    const slowChat = {
      id: '5a5a5a00-1111-2222-3333-444455556666',
      worktreeId: 'wt-slow',
      name: 'Slow',
      harness: 'claude',
      harnessSessionId: 'slow-session',
      createdAt: 1,
      lastAccessedAt: 1,
      status: 'closed',
      baseCommit: null,
    };
    slowChats.set(slowChat.id, slowChat);
    slowPids.set(slowChat.id, 7201);
    const slowTerminal = (vscode as any).window.createTerminal({
      name: 'Agntree: Slow [5a5a5a]',
      __pid: 7202,
    });

    const slow = slowManager.beginRestoreSync(() => ({
      id: 'wt-slow',
      repoId: 'repo',
      name: 'slow',
      path: REPO,
      isMain: false,
    }));
    await slow.adopted;

    let completed = false;
    void slow.complete.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    check(
      !completed,
      'adoption finishes without waiting for a harness resumability check'
    );
    check(
      slowManager.isResuming(slowChat.id),
      'a chat whose restored terminal is being resumed is reported as busy'
    );

    const before = (vscode as any).window.terminals.length;
    const openedDuringCheck = await slowManager.openChat(slowChat as any, {
      path: REPO,
    } as any);
    check(
      openedDuringCheck === slowTerminal && slowTerminal.sent.length === 0,
      'a click during the check focuses the restored tab instead of starting an agent'
    );
    check(
      (vscode as any).window.terminals.length === before,
      'a click during the check does not create a second terminal'
    );

    releaseCheck(true);
    await slow.complete;
    check(
      slowTerminal.sent[0] === `cd ${REPO} && claude --resume slow-session`,
      'the background resume finishes after the harness check'
    );
    check(
      !slowManager.isResuming(slowChat.id),
      'the busy state clears once the resume has started'
    );

    slowManager.dispose();
  }

  console.log('\n== failed late adoption ==');
  {
    const lateChats = new Map<string, any>();
    const latePids = new Map<string, number>();
    const lateStorage = makeStorage(lateChats, latePids);
    lateStorage.rememberTerminalPid = async () => {
      throw new Error('storage unavailable');
    };
    const lateManager = new TerminalManager(
      lateStorage as any,
      registry,
      new HarnessWatcherRegistry([])
    );
    const lateChat = {
      id: '6b6b6b00-1111-2222-3333-444455556666',
      worktreeId: 'wt-late',
      name: 'Late',
      harness: 'claude',
      harnessSessionId: 'late-session',
      createdAt: 1,
      lastAccessedAt: 1,
      status: 'active',
      baseCommit: null,
    };
    lateChats.set(lateChat.id, lateChat);
    latePids.set(lateChat.id, 7301);
    const lateTerminal = (vscode as any).window.createTerminal({
      name: 'Agntree: Late [6b6b6b]',
      __pid: 7301,
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const originalError = console.error;
    console.error = () => undefined;
    try {
      (vscode as any).window.__fireDidOpenTerminal(lateTerminal);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      console.error = originalError;
      process.off('unhandledRejection', onUnhandled);
    }
    check(
      unhandled.length === 0,
      'a storage failure while adopting a late terminal stays contained'
    );

    lateManager.dispose();
  }

  manager.dispose();
  codexHarness.dispose();
  console.log(
    `\n${failures === 0 ? 'ALL TERMINAL MANAGER CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
