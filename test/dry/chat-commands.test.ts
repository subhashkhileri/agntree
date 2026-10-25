import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StorageService } from '../../src/services/StorageService';
import { TerminalManager } from '../../src/services/TerminalManager';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { WorkspaceTreeItem } from '../../src/providers/WorkspacesTreeProvider';
import { registerChatCommands } from '../../src/commands/chat';
import { ForkResult, HarnessAdapter, HarnessSession } from '../../src/harnesses/types';
import { harnessTreeIcons } from '../../src/harnesses/treeIcons';
import { HarnessId, Worktree } from '../../src/types';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-chat-commands-'));
let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function makeMemento() {
  const state = new Map<string, unknown>();
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    get: <T>(key: string, fallback: T): T =>
      state.has(key) ? clone(state.get(key) as T) : fallback,
    update: async (key: string, value: unknown): Promise<void> => {
      state.set(key, clone(value));
    },
    keys: () => Array.from(state.keys()),
    setKeysForSync: () => undefined,
  };
}

function createAdapter(
  id: HarnessId,
  behavior: {
    fork: () => Promise<ForkResult>;
    prepare: () => Promise<ForkResult>;
    sessions: () => HarnessSession[];
  }
): HarnessAdapter {
  return {
    id,
    displayName:
      id === 'claude' ? 'Claude Code' : id === 'opencode' ? 'opencode' : 'Codex',
    icon: id === 'claude' ? 'sparkle' : id === 'opencode' ? 'code' : 'terminal',
    treeIcons: harnessTreeIcons(id),
    capabilities: {
      fork: true,
      move: id === 'opencode',
      newSessionId: id === 'claude',
      preview: id === 'opencode' ? 'lazy' : 'inline',
    },
    isInstalled: async () => true,
    buildLaunchCommand: ({
      worktreePath,
      sessionId,
      newSessionId,
      forkFromSessionId,
    }) => {
      if (id === 'claude') {
        if (forkFromSessionId) {
          return `claude --resume ${forkFromSessionId} --fork-session --session-id ${newSessionId}`;
        }
        if (sessionId) return `claude --resume ${sessionId}`;
        return newSessionId ? `claude --session-id ${newSessionId}` : 'claude';
      }
      if (id === 'codex') {
        if (forkFromSessionId) {
          return `codex fork ${forkFromSessionId} --cd ${worktreePath}`;
        }
        return sessionId
          ? `codex resume ${sessionId} --cd ${worktreePath}`
          : 'codex';
      }
      return sessionId ? `opencode --session ${sessionId}` : 'opencode';
    },
    // Only linked sessions are resumable; a fresh chosen ID has no transcript.
    isSessionResumable: async (sessionId: string) =>
      !sessionId.startsWith('pending-') && !sessionId.match(/^[0-9a-f-]{36}$/),
    listSessionsForWorktree: async () => behavior.sessions(),
    listSessionsForRepository: async () => behavior.sessions(),
    getSessionMetadata: async () => null,
    getPreview: async () => [],
    forkSession: behavior.fork,
    moveSession: async () => undefined,
    prepareForkToNewWorktree: behavior.prepare,
  };
}

async function main(): Promise<void> {
  const memento = makeMemento();
  const storageService = new StorageService({
    globalState: memento,
    workspaceState: makeMemento(),
  } as any);
  const repo = storageService.addRepository('demo', path.join(ROOT, 'demo'));

  const mainWorktree: Worktree = {
    id: 'wt-main',
    repoId: repo.id,
    name: 'main',
    path: path.join(ROOT, 'demo'),
    isMain: true,
  };
  const featureWorktree: Worktree = {
    id: 'wt-feature',
    repoId: repo.id,
    name: 'feature-x',
    path: path.join(ROOT, 'demo-feature-x'),
    isMain: false,
  };
  let worktrees = [mainWorktree, featureWorktree];

  const pendingRegistrations: { harness: HarnessId; chatId: string; worktreePath: string }[] = [];
  const activeChatCalls: (string | undefined)[] = [];
  let refreshCount = 0;
  let createdWorktree: Worktree | null = null;
  let worktreeSerial = 0;

  let claudeForkSerial = 0;
  const behavior = {
    claudeFork: async (): Promise<ForkResult> => ({
      kind: 'terminal',
      pendingSessionId: `pending-claude-fork-${++claudeForkSerial}`,
    }),
    opencodeFork: async (): Promise<ForkResult> => ({ kind: 'linked', sessionId: 'ses_fork_same' }),
    opencodePrepare: async (): Promise<ForkResult> => ({ kind: 'linked', sessionId: 'ses_fork_moved' }),
    codexFork: async (): Promise<ForkResult> => ({ kind: 'linked', sessionId: 'codex-fork-same' }),
    codexPrepare: async (): Promise<ForkResult> => ({ kind: 'linked', sessionId: 'codex-fork-moved' }),
    imports: {
      claude: [] as HarnessSession[],
      opencode: [] as HarnessSession[],
      codex: [] as HarnessSession[],
    },
  };

  const claudeAdapter = createAdapter('claude', {
    fork: () => behavior.claudeFork(),
    prepare: () => behavior.claudeFork(),
    sessions: () => behavior.imports.claude,
  });
  const opencodeAdapter = createAdapter('opencode', {
    fork: () => behavior.opencodeFork(),
    prepare: () => behavior.opencodePrepare(),
    sessions: () => behavior.imports.opencode,
  });
  const codexAdapter = createAdapter('codex', {
    fork: () => behavior.codexFork(),
    prepare: () => behavior.codexPrepare(),
    sessions: () => behavior.imports.codex,
  });
  const harnessRegistry = new HarnessRegistry([
    claudeAdapter,
    opencodeAdapter,
    codexAdapter,
  ]);

  const gitService = {
    getCurrentCommit: () => 'deadbeef',
    listWorktrees: () => worktrees,
    getBranches: () => [] as string[],
    createWorktreeWithNewBranch: (
      _root: string,
      branchName: string,
      worktreePath: string
    ): boolean => {
      createdWorktree = {
        id: `wt-created-${++worktreeSerial}`,
        repoId: repo.id,
        name: branchName,
        path: worktreePath,
        isMain: false,
      };
      worktrees = [...worktrees, createdWorktree];
      return true;
    },
    hasUncommittedChanges: () => false,
    copyUncommittedChanges: () => true,
  };

  const workspacesProvider = {
    getWorktreeById: (id: string) => worktrees.find((worktree) => worktree.id === id),
  };

  const changesProvider = {
    setActiveChat: (chatId: string | undefined) => {
      activeChatCalls.push(chatId);
    },
    refresh: () => undefined,
  };

  const watcherRegistry = {
    registerPendingChat: (harness: HarnessId, chatId: string, worktreePath: string) => {
      pendingRegistrations.push({ harness, chatId, worktreePath });
    },
  };

  const terminalManager = new TerminalManager(
    storageService as any,
    harnessRegistry,
    watcherRegistry as any
  );

  const context = {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: (vscode as any).Uri.file('/extension'),
  };
  registerChatCommands(
    context as any,
    storageService,
    gitService as any,
    terminalManager,
    workspacesProvider as any,
    changesProvider as any,
    harnessRegistry,
    watcherRegistry as any,
    () => {
      refreshCount++;
    }
  );

  const commands = (vscode as any).commands;
  // Dropping an unused fork refreshes the tree through this command.
  await commands.registerCommand('agntree.refreshWorkspaces', () => undefined);

  const waitFor = async (condition: () => unknown, what: string): Promise<void> => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (condition()) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const terminals = (vscode as any).window.terminals as {
    name: string;
    sent: string[];
    shown: number;
    options: { cwd?: string; iconPath?: { id: string } };
  }[];

  const worktreeItem = new WorkspaceTreeItem(
    'main',
    0 as any,
    'worktree',
    mainWorktree,
    'worktree'
  );
  const chatItem = (chatId: string) => {
    const chat = storageService.getChat(chatId);
    if (!chat) {
      throw new Error(`chat ${chatId} does not exist`);
    }
    return new WorkspaceTreeItem(chat.name, 0 as any, 'chat', chat, 'chat');
  };

  console.log('\n== new sessions ==');
  const terminalsBefore = terminals.length;
  await commands.executeCommand('agntree.newClaudeChat', worktreeItem);
  const claudeChats = storageService
    .getChatsByWorktree(mainWorktree.id)
    .filter((chat) => chat.harness === 'claude');
  check(claudeChats.length === 1, 'newClaudeChat creates a claude chat');
  const claudeChat = claudeChats[0];
  check(claudeChat.name === 'New Session', 'new chat starts as "New Session"');
  check(claudeChat.baseCommit === 'deadbeef', 'new chat records the current commit');
  check(
    pendingRegistrations.some(
      (entry) => entry.harness === 'claude' && entry.chatId === claudeChat.id
    ),
    'new claude chat is registered with the claude watcher'
  );
  check(
    Boolean(claudeChat.pendingHarnessSessionId),
    'new claude chat stores a chosen pending ID'
  );
  check(terminals.length === terminalsBefore + 1, 'a terminal was created');
  const claudeTerminal = terminals[terminals.length - 1];
  check(
    claudeTerminal.sent[0] ===
      `claude --session-id ${claudeChat.pendingHarnessSessionId}`,
    'claude terminal launches with its chosen ID'
  );
  check(claudeTerminal.options.cwd === mainWorktree.path, 'terminal cwd is the worktree');
  check(activeChatCalls.at(-1) === claudeChat.id, 'changes view follows the new chat');
  check(refreshCount > 0, 'tree refresh was requested');

  await commands.executeCommand('agntree.newOpencodeChat', worktreeItem);
  const opencodeChats = storageService
    .getChatsByWorktree(mainWorktree.id)
    .filter((chat) => chat.harness === 'opencode');
  check(opencodeChats.length === 1, 'newOpencodeChat creates an opencode chat');
  const opencodeChat = opencodeChats[0];
  check(
    opencodeChat.pendingHarnessSessionId === undefined,
    'opencode chat does not get a chosen ID'
  );
  check(
    pendingRegistrations.some(
      (entry) => entry.harness === 'opencode' && entry.chatId === opencodeChat.id
    ),
    'new opencode chat is registered with the opencode watcher'
  );
  check(
    terminals[terminals.length - 1].sent[0] === 'opencode',
    'opencode terminal starts a new session'
  );

  await commands.executeCommand('agntree.newChat', worktreeItem);
  const aliasChats = storageService
    .getChatsByWorktree(mainWorktree.id)
    .filter((chat) => chat.harness === 'claude');
  check(aliasChats.length === 2, 'the legacy newChat command still creates a claude chat');

  await commands.executeCommand('agntree.newCodexChat', worktreeItem);
  const codexChats = storageService
    .getChatsByWorktree(mainWorktree.id)
    .filter((chat) => chat.harness === 'codex');
  check(codexChats.length === 1, 'newCodexChat creates a codex chat');
  const codexChat = codexChats[0];
  check(
    pendingRegistrations.some(
      (entry) => entry.harness === 'codex' && entry.chatId === codexChat.id
    ),
    'new codex chat is registered with the codex watcher'
  );
  check(
    terminals[terminals.length - 1].sent[0] === 'codex',
    'codex terminal starts a new session'
  );
  check(
    terminals[terminals.length - 1].options.cwd === mainWorktree.path,
    'codex terminal cwd is the worktree'
  );

  console.log('\n== pre-change chats ==');
  const legacyChat = storageService.createChat(
    mainWorktree.id,
    'Legacy Session',
    null,
    'claude'
  );
  await commands.executeCommand('agntree.openChat', chatItem(legacyChat.id));
  const migratedChat = storageService.getChat(legacyChat.id);
  check(
    Boolean(migratedChat?.pendingHarnessSessionId) &&
      migratedChat?.harnessSessionId === null,
    'opening an unlinked pre-change chat persists a pending ID'
  );
  check(
    pendingRegistrations.some((entry) => entry.chatId === legacyChat.id),
    'the pre-change chat is registered with the watcher'
  );
  check(
    terminals[terminals.length - 1].sent[0] ===
      `claude --session-id ${migratedChat?.pendingHarnessSessionId}`,
    'the pre-change chat launches with its new pending ID'
  );

  console.log('\n== chat with an open terminal ==');
  const terminalBackedChat = storageService.createChat(
    mainWorktree.id,
    'Terminal Session',
    null,
    'claude'
  );
  await commands.executeCommand('agntree.openChat', chatItem(terminalBackedChat.id));
  const openedTerminal = terminals[terminals.length - 1];
  const terminalCount = terminals.length;
  const registrationsAfterOpen = pendingRegistrations.length;
  await commands.executeCommand('agntree.openChat', chatItem(terminalBackedChat.id));
  check(
    terminals.length === terminalCount,
    'reopening a chat creates no extra terminal'
  );
  check(openedTerminal.shown === 2, 'the existing terminal is focused');
  check(
    pendingRegistrations.length === registrationsAfterOpen,
    'focusing an open chat does not re-register it'
  );

  console.log('\n== fork in the same worktree ==');
  storageService.updateChat(claudeChat.id, { harnessSessionId: 'claude-original' });
  await commands.executeCommand('agntree.forkChat', chatItem(claudeChat.id));
  const claudeForks = storageService
    .getChatsByWorktree(mainWorktree.id)
    .filter(
      (chat) => chat.harness === 'claude' && chat.name.startsWith('New Session (')
    );
  check(claudeForks.length === 1, 'claude fork created a new chat');
  check(
    claudeForks[0].name === 'New Session (1)',
    `claude fork is numbered: ${claudeForks[0].name}`
  );
  check(claudeForks[0].harnessSessionId === null, 'claude fork session id is captured later');
  check(
    claudeForks[0].pendingHarnessSessionId === 'pending-claude-fork-1',
    'claude fork stores the chosen pending ID'
  );
  check(
    claudeForks[0].forkedFromSessionId === 'claude-original',
    'claude fork keeps its source for an unlinked reopen'
  );
  check(
    pendingRegistrations.some((entry) => entry.chatId === claudeForks[0].id),
    'claude fork is registered with the watcher'
  );
  check(
    terminals[terminals.length - 1].sent[0] ===
      'claude --resume claude-original --fork-session --session-id pending-claude-fork-1',
    'claude fork launches --fork-session with the chosen ID'
  );

  storageService.updateChat(opencodeChat.id, { harnessSessionId: 'ses_original' });
  await commands.executeCommand('agntree.forkChat', chatItem(opencodeChat.id));
  const opencodeForks = storageService
    .getChatsByWorktree(mainWorktree.id)
    .filter(
      (chat) => chat.harness === 'opencode' && chat.name.startsWith('New Session (')
    );
  check(opencodeForks.length === 1, 'opencode fork created a new chat');
  check(
    opencodeForks[0].name === 'New Session (2)',
    `opencode fork increments the suffix: ${opencodeForks[0].name}`
  );
  check(
    opencodeForks[0].harnessSessionId === 'ses_fork_same',
    'opencode fork links the API-created session'
  );
  check(
    terminals[terminals.length - 1].sent[0] === 'opencode --session ses_fork_same',
    'opencode fork resumes the forked session'
  );
  check(
    !pendingRegistrations.some((entry) => entry.chatId === opencodeForks[0].id),
    'opencode fork does not need watcher-based linkage'
  );

  storageService.updateChat(codexChat.id, { harnessSessionId: 'codex-original' });
  await commands.executeCommand('agntree.forkChat', chatItem(codexChat.id));
  const codexForks = storageService
    .getChatsByWorktree(mainWorktree.id)
    .filter(
      (chat) => chat.harness === 'codex' && chat.name.startsWith('New Session (')
    );
  check(codexForks.length === 1, 'codex fork created a new chat');
  check(
    codexForks[0].name === 'New Session (3)',
    `codex fork increments the shared suffix: ${codexForks[0].name}`
  );
  check(
    codexForks[0].harnessSessionId === 'codex-fork-same',
    'codex fork links the app-server-created thread'
  );
  check(
    terminals[terminals.length - 1].sent[0] ===
      `codex resume codex-fork-same --cd ${mainWorktree.path}`,
    'codex fork resumes the linked thread'
  );
  check(
    !pendingRegistrations.some((entry) => entry.chatId === codexForks[0].id),
    'codex fork does not need watcher-based linkage'
  );

  console.log('\n== fork to a new worktree ==');
  const opencodeForkChat = opencodeForks[0];
  const newBranch = 'feature-fork';
  const newWorktreePath = path.join(ROOT, 'demo-feature-fork');
  (vscode as any).__inputResponses.push(newBranch, newWorktreePath);
  await commands.executeCommand('agntree.forkChatWithChanges', chatItem(opencodeForkChat.id));
  const created = createdWorktree as Worktree | null;
  check(Boolean(created), 'a new worktree entry was created');
  if (created) {
    const movedChats = storageService.getChatsByWorktree(created.id);
    check(movedChats.length === 1, 'fork-to-worktree creates one chat in the new worktree');
    check(movedChats[0].harness === 'opencode', 'forked chat keeps the opencode harness');
    check(
      movedChats[0].name === 'New Session (2) (1)',
      `fork of a fork appends another suffix: ${movedChats[0].name}`
    );
    check(
      movedChats[0].harnessSessionId === 'ses_fork_moved',
      'forked chat links the moved opencode session'
    );
    check(
      terminals[terminals.length - 1].sent[0] === 'opencode --session ses_fork_moved',
      'forked chat resumes the moved session'
    );
  }

  behavior.opencodePrepare = async () => {
    throw new Error('move failed');
  };
  (vscode as any).__inputResponses.push('feature-broken', path.join(ROOT, 'demo-broken'));
  const messagesBefore = (vscode as any).__messages.length;
  await commands.executeCommand('agntree.forkChatWithChanges', chatItem(opencodeForkChat.id));
  const errorMessages = (vscode as any).__messages
    .slice(messagesBefore)
    .filter((args: unknown[]) => typeof args[0] === 'string');
  check(
    errorMessages.some((args: unknown[]) =>
      String(args[0]).includes('Failed to fork the opencode session')
    ),
    'a failed move reports a clear harness error'
  );
  const brokenWorktree = worktrees.find((worktree) => worktree.name === 'feature-broken');
  check(
    Boolean(brokenWorktree) &&
      storageService.getChatsByWorktree(brokenWorktree!.id).length === 0,
    'no chat is created when the harness fork fails'
  );

  const codexForkChat = codexForks[0];
  const codexBranch = 'feature-codex-fork';
  const codexWorktreePath = path.join(ROOT, 'demo-feature-codex-fork');
  (vscode as any).__inputResponses.push(codexBranch, codexWorktreePath);
  await commands.executeCommand(
    'agntree.forkChatWithChanges',
    chatItem(codexForkChat.id)
  );
  const codexWorktree = worktrees.find(
    (worktree) => worktree.name === codexBranch
  );
  check(Boolean(codexWorktree), 'codex fork created a worktree');
  if (codexWorktree) {
    const chats = storageService.getChatsByWorktree(codexWorktree.id);
    check(chats.length === 1, 'codex fork-to-worktree creates one chat');
    check(chats[0].harness === 'codex', 'codex fork keeps the codex harness');
    check(
      chats[0].harnessSessionId === 'codex-fork-moved',
      'codex fork links the destination thread'
    );
    check(
      terminals[terminals.length - 1].sent[0] ===
        `codex resume codex-fork-moved --cd ${codexWorktreePath}`,
      'codex fork resumes the destination thread'
    );
  }

  // A terminal-kind prepare must not write the source session ID into the new
  // chat: the watcher discovers the fork's native ID later.
  const claudeBranch = 'feature-claude-fork';
  const claudeWorktreePath = path.join(ROOT, 'demo-feature-claude-fork');
  (vscode as any).__inputResponses.push(claudeBranch, claudeWorktreePath);
  await commands.executeCommand(
    'agntree.forkChatWithChanges',
    chatItem(claudeChat.id)
  );
  const claudeWorktree = worktrees.find(
    (worktree) => worktree.name === claudeBranch
  );
  check(Boolean(claudeWorktree), 'claude terminal fork created a worktree');
  if (claudeWorktree) {
    const chats = storageService.getChatsByWorktree(claudeWorktree.id);
    check(chats.length === 1, 'claude fork-to-worktree creates one chat');
    check(
      chats[0].harnessSessionId === null,
      'terminal-kind fork leaves the new chat unlinked'
    );
    check(
      chats[0].pendingHarnessSessionId === 'pending-claude-fork-2',
      'terminal-kind fork stores the chosen pending ID'
    );
    check(
      pendingRegistrations.some(
        (entry) =>
          entry.harness === 'claude' && entry.chatId === chats[0].id
      ),
      'terminal-kind fork is registered with the claude watcher'
    );
    check(
      terminals[terminals.length - 1].sent[0] ===
        'claude --resume claude-original --fork-session --session-id pending-claude-fork-2',
      'terminal-kind fork launches the native fork command with the chosen ID'
    );
  }

  console.log('\n== unused fork closed before its first prompt ==');
  const chatsBeforeUnusedFork = new Set(
    storageService.getChatsByWorktree(mainWorktree.id).map((chat) => chat.id)
  );
  await commands.executeCommand('agntree.forkChat', chatItem(claudeChat.id));
  const unusedFork = storageService
    .getChatsByWorktree(mainWorktree.id)
    .find((chat) => !chatsBeforeUnusedFork.has(chat.id));
  check(Boolean(unusedFork), 'forking the source again creates a chat');
  if (unusedFork) {
    check(
      Boolean(unusedFork.forkedFromSessionId) && !unusedFork.harnessSessionId,
      'the new fork is unlinked'
    );
    const unusedForkTerminal = terminalManager.getTerminal(unusedFork.id);
    unusedForkTerminal?.dispose();
    (vscode as any).window.__fireDidCloseTerminal(unusedForkTerminal);
    await waitFor(
      () => storageService.getChat(unusedFork.id) === undefined,
      'the unused fork to be dropped'
    );
    check(
      storageService.getChat(unusedFork.id) === undefined,
      'closing an unprompted fork drops the chat instead of keeping a moving fork point'
    );
  }

  console.log('\n== import across harnesses ==');
  const now = Date.now();
  const session = (
    harness: HarnessId,
    sessionId: string,
    summary: string,
    lastUpdated: number,
    cwd = mainWorktree.path
  ): HarnessSession => ({
    harness,
    sessionId,
    cwd,
    summary,
    gitBranch: harness === 'claude' ? null : 'main',
    lastUpdated: new Date(lastUpdated),
    lastActivity: lastUpdated,
    messageCount: harness === 'claude' ? 0 : 3,
  });
  behavior.imports.claude = [
    session('claude', 'claude-imp-1', 'Claude import one', now - 1000),
    session('claude', 'claude-imp-2', 'Claude import two', now - 2000),
  ];
  behavior.imports.opencode = [
    session('opencode', 'ses_imp_1', 'Opencode import one', now),
    session('opencode', 'ses_imp_2', 'Opencode import two', now - 3000),
  ];
  // One opencode session is already imported; one claude session reuses its ID
  // so the harness:session key must keep them apart.
  const alreadyImported = storageService.createChat(mainWorktree.id, 'Imported', null, 'opencode');
  storageService.updateChat(alreadyImported.id, { harnessSessionId: 'ses_imp_2' });
  const sameIdOtherHarness = storageService.createChat(
    mainWorktree.id,
    'Imported elsewhere',
    null,
    'opencode'
  );
  storageService.updateChat(sameIdOtherHarness.id, { harnessSessionId: 'claude-imp-1' });

  let offeredItems: any[] = [];
  (vscode as any).__setQuickPickHandler((items: any[], options: any) => {
    if (options && options.canPickMany) {
      offeredItems = items;
      return items.filter((item) => item.harness === 'opencode');
    }
    return undefined;
  });

  const chatsBeforeImport = storageService.getChats().length;
  await commands.executeCommand('agntree.importSessions', worktreeItem);
  (vscode as any).__setQuickPickHandler(null);

  check(offeredItems.length === 3, `import offered ${offeredItems.length} of 4 sessions`);
  check(
    !offeredItems.some(
      (item) => item.harness === 'opencode' && item.session.sessionId === 'ses_imp_2'
    ),
    'already-imported opencode sessions are excluded by harness:session key'
  );
  check(
    offeredItems.some(
      (item) => item.harness === 'claude' && item.session.sessionId === 'claude-imp-1'
    ),
    'a session with the same ID under another harness is still offered'
  );

  const importedChats = storageService.getChats().slice(chatsBeforeImport);
  check(importedChats.length === 1, 'one opencode session was imported');
  check(importedChats[0]?.harness === 'opencode', 'imported chat uses the opencode harness');
  check(
    importedChats[0]?.harnessSessionId === 'ses_imp_1',
    'imported chat links the opencode session'
  );
  check(
    (vscode as any).__messages.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('Imported 1 session(s)')
    ),
    'import reports the session count'
  );

  console.log('\n== delete + clear ==');
  (vscode as any).__warningResponses.push('Remove');
  await commands.executeCommand('agntree.deleteChat', chatItem(claudeForks[0].id));
  check(
    storageService.getChat(claudeForks[0].id) === undefined,
    'deleteChat removes the chat from storage'
  );

  (vscode as any).__warningResponses.push('Clear All');
  const featureChat = storageService.createChat(featureWorktree.id, 'Feature', null, 'opencode');
  storageService.updateChat(featureChat.id, { harnessSessionId: 'ses_feature' });
  const featureItem = new WorkspaceTreeItem(
    'feature-x',
    0 as any,
    'worktree',
    featureWorktree,
    'worktree'
  );
  await commands.executeCommand('agntree.clearWorktreeSessions', featureItem);
  check(
    storageService.getChatsByWorktree(featureWorktree.id).length === 0,
    'clearWorktreeSessions removes every chat in the worktree'
  );

  console.log('\n== search sessions ==');
  behavior.imports.claude = [
    session(
      'claude',
      'claude-search-1',
      'Investigate flaky test',
      now - 60_000,
      mainWorktree.path
    ),
  ];
  behavior.imports.opencode = [
    session(
      'opencode',
      'ses_search_1',
      'Plan the migration',
      now - 2 * 60 * 60_000,
      featureWorktree.path
    ),
    session('opencode', 'ses_imp_1', 'Already imported', now, mainWorktree.path),
  ];

  claudeAdapter.getSessionMetadata = async (id: string) =>
    id === 'claude-search-1'
      ? {
          lastActivity: now - 60_000,
          preview: [{ text: 'Investigate flaky test', timestamp: now - 60_000 }],
          lastAsk: { text: 'Investigate flaky test', timestamp: now - 60_000 },
          lastReply: {
            text: 'Found a race in the setup hook',
            timestamp: now - 30_000,
          },
        }
      : null;
  opencodeAdapter.getSessionMetadata = async (id: string) =>
    id === 'ses_search_1'
      ? {
          lastActivity: now - 2 * 60 * 60_000,
          preview: [{ text: 'Plan the migration', timestamp: now - 2 * 60 * 60_000 }],
          lastAsk: { text: 'Plan the migration', timestamp: now - 2 * 60 * 60_000 },
          lastReply: null,
          messageCount: 6,
          model: 'enmaas/rits/model#high',
          agent: 'build',
          cost: 0.12,
          tokens: {
            input: 10,
            output: 5,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        }
      : null;

  const repoItem = new WorkspaceTreeItem(
    'demo',
    0 as any,
    'repository',
    repo,
    'repository'
  );
  const picksBefore = (vscode as any).__quickPicks.length;
  const searchRun = commands.executeCommand('agntree.searchSessions', repoItem);
  await waitFor(
    () => (vscode as any).__quickPicks[picksBefore],
    'search quick pick'
  );
  const pick = (vscode as any).__quickPicks[picksBefore];

  const separators = pick.items.filter(
    (item: any) => item.kind === (vscode as any).QuickPickItemKind.Separator
  );
  check(
    separators.map((item: any) => item.label).join(',') ===
      'main (main),feature-x',
    `worktrees group the results with main first: ${separators
      .map((item: any) => item.label)
      .join(', ')}`
  );

  const claudeEntry = pick.items.find(
    (item: any) => item.session?.sessionId === 'claude-search-1'
  );
  const opencodeEntry = pick.items.find(
    (item: any) => item.session?.sessionId === 'ses_search_1'
  );
  const importedEntry = pick.items.find(
    (item: any) => item.session?.sessionId === 'ses_imp_1'
  );

  check(Boolean(claudeEntry && opencodeEntry), 'both harnesses are listed');
  check(
    claudeEntry.description === '1m ago',
    `lean Claude rows keep only recency: ${claudeEntry.description}`
  );
  check(
    !claudeEntry.description.includes('Claude Code') &&
      !claudeEntry.description.includes('imported') &&
      !claudeEntry.description.includes('main'),
    'harness, import state, and branch are gone from the row text'
  );
  check(
    claudeEntry.iconPath?.light?.path.endsWith('claude-light-closed.svg'),
    `rows use the harness mark: ${claudeEntry.iconPath?.light?.path}`
  );
  check(
    importedEntry.label.startsWith('$(check) '),
    `imported sessions keep a check mark: ${importedEntry.label}`
  );
  check(
    !importedEntry.description.includes('imported'),
    'imported sessions no longer repeat the word'
  );
  check(
    claudeEntry.detail === undefined && opencodeEntry.detail === undefined,
    'rows start collapsed instead of showing five prompts each'
  );

  pick.__setActive(claudeEntry);
  await waitFor(() => claudeEntry.detail, 'claude detail');
  check(
    claudeEntry.detail.includes('You: Investigate flaky test') &&
      claudeEntry.detail.includes('Claude Code: Found a race in the setup hook'),
    `the highlighted Claude row shows the last exchange: ${claudeEntry.detail}`
  );
  check(
    !claudeEntry.detail.includes('messages') &&
      !claudeEntry.detail.includes('claude-opus-4') &&
      !claudeEntry.detail.includes('15k in'),
    'Claude details have no usage footer'
  );

  pick.__setActive(opencodeEntry);
  await waitFor(() => opencodeEntry.detail, 'opencode detail');
  check(
    opencodeEntry.detail.includes('You: Plan the migration'),
    `opencode detail shows the last ask: ${opencodeEntry.detail}`
  );
  check(
    opencodeEntry.detail.includes('6 messages') &&
      opencodeEntry.detail.includes('build') &&
      opencodeEntry.detail.includes('$0.12'),
    'opencode detail shows usage and cost'
  );
  check(
    claudeEntry.detail === undefined,
    'only one row stays expanded at a time'
  );

  pick.__accept();
  await searchRun;
  const searchedImport = storageService
    .getChatsByWorktree(featureWorktree.id)
    .filter((chat) => chat.harnessSessionId === 'ses_search_1');
  check(
    searchedImport.length === 1,
    'accepting a result imports it into the matching worktree'
  );
  check(
    searchedImport[0]?.name === 'Plan the migration',
    'the imported chat keeps the session title'
  );

  terminalManager.dispose();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL CHAT COMMAND CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
