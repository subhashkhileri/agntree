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
    displayName: id === 'claude' ? 'Claude Code' : 'opencode',
    icon: id === 'claude' ? 'sparkle' : 'code',
    treeIcons: harnessTreeIcons(id),
    capabilities: {
      fork: true,
      move: id === 'opencode',
      recap: id === 'claude',
      preview: id === 'claude' ? 'inline' : 'lazy',
    },
    isInstalled: async () => true,
    buildLaunchCommand: ({ sessionId, forkFromSessionId }) => {
      if (id === 'claude') {
        if (forkFromSessionId) return `claude --resume ${forkFromSessionId} --fork-session`;
        return sessionId ? `claude --resume ${sessionId}` : 'claude';
      }
      return sessionId ? `opencode --session ${sessionId}` : 'opencode';
    },
    isSessionResumable: async () => true,
    listSessionsForWorktree: async () => behavior.sessions(),
    listSessionsForRepository: async () => behavior.sessions(),
    getSessionMetadata: async () => null,
    getPreview: async () => [],
    forkSession: behavior.fork,
    moveSession: async () => undefined,
    prepareForkToNewWorktree: behavior.prepare,
    buildHeadlessCommand: () => null,
  };
}

async function main(): Promise<void> {
  const memento = makeMemento();
  const storageService = new StorageService({ globalState: memento } as any);
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

  const behavior = {
    claudeFork: async (): Promise<ForkResult> => ({ kind: 'terminal' }),
    opencodeFork: async (): Promise<ForkResult> => ({ kind: 'linked', sessionId: 'ses_fork_same' }),
    opencodePrepare: async (): Promise<ForkResult> => ({ kind: 'linked', sessionId: 'ses_fork_moved' }),
    imports: { claude: [] as HarnessSession[], opencode: [] as HarnessSession[] },
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
  const harnessRegistry = new HarnessRegistry([claudeAdapter, opencodeAdapter]);

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

  const terminalManager = new TerminalManager(storageService as any, harnessRegistry);

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
  const terminals = (vscode as any).window.terminals as {
    name: string;
    sent: string[];
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
  check(terminals.length === terminalsBefore + 1, 'a terminal was created');
  const claudeTerminal = terminals[terminals.length - 1];
  check(claudeTerminal.sent[0] === 'claude', 'claude terminal starts a new session');
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
    pendingRegistrations.some((entry) => entry.chatId === claudeForks[0].id),
    'claude fork is registered with the watcher'
  );
  check(
    terminals[terminals.length - 1].sent[0] ===
      'claude --resume claude-original --fork-session',
    'claude fork launches --fork-session'
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
    recap: null,
    gitBranch: 'main',
    lastUpdated: new Date(lastUpdated),
    lastActivity: lastUpdated,
    messageCount: 3,
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
          recap: 'The flaky test fails on CI under load',
          recapAt: now - 90_000,
          preview: [{ text: 'Investigate flaky test', timestamp: now - 60_000 }],
          lastAsk: { text: 'Investigate flaky test', timestamp: now - 60_000 },
          lastReply: {
            text: 'Found a race in the setup hook',
            timestamp: now - 30_000,
          },
          messageCount: 12,
          model: 'claude-opus-4',
          tokens: {
            input: 15_000,
            output: 2_000,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        }
      : null;
  opencodeAdapter.getSessionMetadata = async (id: string) =>
    id === 'ses_search_1'
      ? {
          lastActivity: now - 2 * 60 * 60_000,
          recap: null,
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

  const waitFor = async <T>(read: () => T | undefined, what: string): Promise<T> => {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const value = read();
      if (value) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  const repoItem = new WorkspaceTreeItem(
    'demo',
    0 as any,
    'repository',
    repo,
    'repository'
  );
  const picksBefore = (vscode as any).__quickPicks.length;
  const searchRun = commands.executeCommand('agntree.searchSessions', repoItem);
  const pick = await waitFor(
    () => (vscode as any).__quickPicks[picksBefore],
    'search quick pick'
  );

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
    claudeEntry.description === '1m ago · 3 msgs',
    `rows keep only recency and size: ${claudeEntry.description}`
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
    claudeEntry.detail.includes('Recap: The flaky test fails'),
    `the highlighted row shows the recap: ${claudeEntry.detail}`
  );
  check(
    claudeEntry.detail.includes('12 messages') &&
      claudeEntry.detail.includes('claude-opus-4') &&
      claudeEntry.detail.includes('15k in / 2k out'),
    `the detail footer carries usage: ${claudeEntry.detail}`
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
