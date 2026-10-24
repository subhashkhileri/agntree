import * as vscode from 'vscode';
import { TerminalManager } from '../../src/services/TerminalManager';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
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

async function main(): Promise<void> {
  const chats = new Map<string, any>();
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

  const storage = {
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
  };

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
  const manager = new TerminalManager(storage as any, registry);

  await (vscode as any).commands.registerCommand(
    'agntree.refreshWorkspaces',
    () => undefined
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

    const pendingStorage = {
      getChat: (id: string) => pendingChats.get(id),
      getChats: () => Array.from(pendingChats.values()),
      updateChat: (id: string, updates: Record<string, unknown>) => {
        const chat = pendingChats.get(id);
        if (chat) Object.assign(chat, updates);
        return chat;
      },
      deleteChat: (id: string) => pendingChats.delete(id),
      touchChat: () => undefined,
    };

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
      new HarnessRegistry([pendingAdapter])
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
  terminals.splice(terminals.indexOf(closeWithSessionTerminal), 1);
  (vscode as any).window.__fireDidCloseTerminal(closeWithSessionTerminal);
  check(
    storage.getChat(closeWithSession.id)?.status === 'closed',
    'closing a linked session marks the chat closed'
  );

  console.log('\n== sync after extension restart ==');
  const synced = addChat({
    harness: 'claude',
    name: 'Synced',
    harnessSessionId: 'linked-session',
    status: 'active',
  });
  chats.delete(synced.id);
  synced.id = 'abcdef00-1111-2222-3333-444455556666';
  chats.set(synced.id, synced);

  const restoredTerminal = {
    name: 'Agntree: Synced [abcdef]',
    sent: [],
    show: () => undefined,
    dispose: () => undefined,
  };
  (vscode as any).window.terminals.push(restoredTerminal);

  const secondManager = new TerminalManager(storage as any, registry);
  secondManager.syncWithExistingTerminals();
  check(
    secondManager.isActive(synced.id),
    'existing terminal is re-associated by chat short id'
  );
  check(
    storage.getChat(synced.id)?.status === 'active',
    're-associated chat is marked active'
  );

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
    !manager.hasTerminal(exitedChat),
    'hasTerminal rejects an exited terminal'
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

  const exitedRestored = addChat({
    harness: 'claude',
    name: 'Exited Restored',
    harnessSessionId: 'linked-session',
    status: 'active',
  });
  chats.delete(exitedRestored.id);
  exitedRestored.id = 'deadbe11-1111-2222-3333-444455556666';
  chats.set(exitedRestored.id, exitedRestored);
  const exitedRestoredTerminal = {
    name: 'Agntree: Exited Restored [deadbe]',
    sent: [] as string[],
    exitStatus: { code: 0 },
    show: () => undefined,
    dispose: () => undefined,
  };
  (vscode as any).window.terminals.push(exitedRestoredTerminal);
  secondManager.syncWithExistingTerminals();
  check(
    !secondManager.isActive(exitedRestored.id),
    'sync does not re-associate an exited terminal'
  );
  check(
    storage.getChat(exitedRestored.id)?.status === 'idle',
    'a chat whose restored terminal exited is marked idle'
  );

  manager.dispose();
  secondManager.dispose();
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
