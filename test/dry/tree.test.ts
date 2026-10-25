import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspacesTreeProvider } from '../../src/providers/WorkspacesTreeProvider';
import { harnessTreeIcons } from '../../src/harnesses/treeIcons';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => Promise<boolean> | boolean,
  timeoutMs = 2000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return true;
    }
    await wait(25);
  }
  return false;
}

async function main(): Promise<void> {
  const now = Date.now();
  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    name: 'feature',
    path: '/tmp/agntree-dry-tree-worktree',
    branch: 'feature',
    isMain: true,
  };

  const chats = [
    {
      id: 'chat-new',
      worktreeId: 'wt-1',
      name: 'New opencode',
      harness: 'opencode',
      harnessSessionId: null,
      createdAt: 3,
      lastAccessedAt: 3,
      status: 'idle',
      baseCommit: null,
    },
    {
      id: 'chat-opencode',
      worktreeId: 'wt-1',
      name: 'Opencode session',
      harness: 'opencode',
      harnessSessionId: 'ses_2',
      createdAt: 2,
      lastAccessedAt: 2,
      status: 'idle',
      baseCommit: null,
    },
    {
      id: 'chat-claude',
      worktreeId: 'wt-1',
      name: 'Claude session',
      harness: 'claude',
      harnessSessionId: 'claude-1',
      createdAt: 1,
      lastAccessedAt: 1,
      status: 'idle',
      baseCommit: null,
    },
  ];

  const storage = {
    getRepositories: () => [],
    getRepository: () => undefined,
    getChatsByWorktree: (id: string) => (id === 'wt-1' ? chats : []),
    getStarredChatIds: () => new Set(['chat-claude']),
    getPRWorktree: () => undefined,
  };

  const gitService = {
    listWorktrees: () => [worktree],
    listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }),
  };

  const terminalManager = {
    onTerminalStateChange: () => ({ dispose: () => undefined }),
    isActive: () => false,
  };

  const claudeAdapter = {
    id: 'claude',
    displayName: 'Claude Code',
    icon: 'sparkle',
    treeIcons: harnessTreeIcons('claude'),
    capabilities: {
      fork: true,
      move: false,
      newSessionId: true,
      preview: 'inline',
    },
    getSessionMetadata: async (id: string) =>
      id === 'claude-1'
        ? {
            lastActivity: now - 16 * 60 * 1000,
            preview: [{ text: 'claude preview', timestamp: null }],
          }
        : null,
    listSessionsForWorktree: async () => [],
    getPreview: async () => [],
  };

  const opencodeAdapter = {
    id: 'opencode',
    displayName: 'opencode',
    icon: 'code',
    treeIcons: harnessTreeIcons('opencode'),
    capabilities: {
      fork: true,
      move: true,
      newSessionId: false,
      preview: 'lazy',
    },
    getSessionMetadata: async (id: string) =>
      id === 'ses_2'
        ? {
            lastActivity: now - 33 * 60 * 1000,
            preview: [],
            model: 'enmaas/rits/model#high',
            agent: 'build',
            cost: 0.12,
            tokens: { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 0 },
          }
        : null,
    listSessionsForWorktree: async () => [],
    getPreview: async () => [{ text: 'opencode preview', timestamp: null }],
  };

  const harnessRegistry = {
    getInstalled: async () => [claudeAdapter, opencodeAdapter],
    hasMultipleInstalled: async () => true,
    get: (id: string) => (id === 'opencode' ? opencodeAdapter : claudeAdapter),
  };

  const provider = new WorkspacesTreeProvider(
    storage as any,
    gitService as any,
    terminalManager as any,
    harnessRegistry as any,
    { scheme: 'file', path: '/extension' } as any
  );

  const worktreeItem = new (vscode as any).TreeItem(worktree.name, 1);
  worktreeItem.itemType = 'worktree';
  worktreeItem.data = worktree;

  console.log('\n== tree ordering + labels ==');
  let items = await provider.getChildren(worktreeItem as any);
  const byId = new Map(items.map((item: any) => [item.data.id, item]));

  check(items.length === 3, 'all chats are rendered');
  check(items[0].data.id === 'chat-claude', 'starred chat sorts first');
  check(items[1].data.id === 'chat-opencode', 'newest activity sorts before a new session');
  check(items[2].data.id === 'chat-new', 'chat without a session falls back to createdAt');
  check(
    byId.get('chat-claude').description === '★ 16m',
    `claude description: ${byId.get('chat-claude').description}`
  );
  check(
    byId.get('chat-opencode').description === '33m',
    `opencode description: ${byId.get('chat-opencode').description}`
  );
  check(
    byId.get('chat-new').description === 'new',
    `new session description: ${byId.get('chat-new').description}`
  );

  console.log('\n== harness icons ==');
  check(
    byId.get('chat-claude').iconPath.light.path.endsWith('claude-light-closed.svg'),
    `claude session icon: ${byId.get('chat-claude').iconPath.light.path}`
  );
  check(
    byId.get('chat-opencode').iconPath.dark.path.endsWith('opencode-dark-closed.svg'),
    `opencode session icon: ${byId.get('chat-opencode').iconPath.dark.path}`
  );
  check(
    byId.get('chat-new').iconPath.light.path.endsWith('opencode-light-new.svg'),
    `new session icon: ${byId.get('chat-new').iconPath.light.path}`
  );

  console.log('\n== tooltips ==');
  const claudeTooltip = byId.get('chat-claude').tooltip.value;
  check(
    claudeTooltip.includes('Last exchange'),
    'claude tooltip shows the last exchange'
  );
  check(claudeTooltip.includes('claude preview'), 'claude tooltip shows the preview');
  check(!claudeTooltip.includes('Harness:'), 'tooltip drops the redundant harness line');
  check(!claudeTooltip.includes('Status:'), 'tooltip drops the redundant status line');

  const opencodeTooltip = byId.get('chat-opencode').tooltip.value;
  check(
    opencodeTooltip.includes('enmaas/rits/model#high'),
    'opencode tooltip shows the model'
  );
  check(opencodeTooltip.includes('build'), 'opencode tooltip shows the agent');
  check(
    opencodeTooltip.includes('10 in / 5 out'),
    `opencode tooltip shows token totals: ${opencodeTooltip}`
  );
  check(opencodeTooltip.includes('$0.12'), 'opencode tooltip shows cost');
  check(
    !opencodeTooltip.includes('opencode preview'),
    'opencode preview is fetched lazily'
  );

  const newTooltip = byId.get('chat-new').tooltip.value;
  check(
    newTooltip.includes('No messages yet'),
    'new session tooltip explains the pending state'
  );

  await wait(200);
  items = await provider.getChildren(worktreeItem as any);
  const refreshed = items.find((item: any) => item.data.id === 'chat-opencode');
  const refreshedTooltip = refreshed?.tooltip as
    | vscode.MarkdownString
    | undefined;
  check(
    refreshedTooltip?.value.includes('opencode preview') === true,
    'opencode preview appears after the background fetch'
  );
  check(
    (provider as any).previewCache.has('opencode:ses_2'),
    'opencode preview is cached for subsequent renders'
  );

  console.log('\n== cold worktree lookup ==');
  {
    const repos = [
      { id: 'repo-a', name: 'a', rootPath: '/tmp/a', hidden: false },
      { id: 'repo-b', name: 'b', rootPath: '/tmp/b', hidden: false },
    ];
    const listed: string[] = [];
    const lookupGit = {
      listRepositoryWorktrees: (repoPath: string, repoId: string) => {
        listed.push(repoId);
        return {
          isGit: true,
          worktrees: [
            {
              id: repoId === 'repo-a' ? 'wt-a' : 'wt-b',
              repoId,
              name: 'main',
              path: repoPath,
              isMain: true,
            },
          ],
        };
      },
    };
    const lookupStorage = {
      getRepositories: () => repos,
      getRepository: (id: string) => repos.find((repo) => repo.id === id),
      getChatsByWorktree: () => [],
      getStarredChatIds: () => new Set(),
      getPRWorktree: () => undefined,
    };
    const lookupProvider = new WorkspacesTreeProvider(
      lookupStorage as any,
      lookupGit as any,
      terminalManager as any,
      harnessRegistry as any,
      { scheme: 'file', path: '/extension' } as any
    );

    check(
      lookupProvider.getWorktreeById('wt-b')?.path === '/tmp/b',
      'a cold lookup finds a worktree in any repository'
    );
    check(
      lookupProvider.getWorktreeById('wt-b')?.path === '/tmp/b',
      'a second lookup finds the same worktree'
    );
    check(
      lookupProvider.findWorktreeByPath('/tmp/a')?.id === 'wt-a',
      'a path lookup uses the warm cache'
    );
    check(
      listed.filter((id) => id === 'repo-a').length === 1 &&
        listed.filter((id) => id === 'repo-b').length === 1,
      `each repository is listed once (${listed.join(',')})`
    );

    lookupProvider.dispose();
  }

  console.log('\n== plain folder root ==');
  {
    const folderRepo = {
      id: 'repo-f',
      name: 'notes',
      rootPath: '/tmp/agntree-notes',
      hidden: false,
    };
    const emptyRepo = {
      id: 'repo-empty',
      name: 'empty',
      rootPath: '/tmp/agntree-empty',
      hidden: false,
    };
    const folderChats = [
      {
        id: 'chat-folder',
        worktreeId: 'wt-folder',
        name: 'Folder session',
        harness: 'claude',
        harnessSessionId: 'claude-folder',
        createdAt: 1,
        lastAccessedAt: 1,
        status: 'idle',
        baseCommit: null,
      },
    ];
    let isGit = false;
    const folderGit = {
      isGitRepository: () => isGit,
      listRepositoryWorktrees: (repoPath: string, repoId: string) => ({
        isGit,
        worktrees: [
          {
            id: repoId === 'repo-f' ? 'wt-folder' : `wt-${repoId}`,
            repoId,
            name: isGit ? 'main' : path.basename(repoPath),
            path: repoPath,
            isMain: true,
          },
        ],
      }),
    };
    const folderStorage = {
      getRepositories: () => [folderRepo, emptyRepo],
      getRepository: (id: string) =>
        id === folderRepo.id
          ? folderRepo
          : id === emptyRepo.id
            ? emptyRepo
            : undefined,
      getChatsByWorktree: (id: string) =>
        id === 'wt-folder' ? folderChats : [],
      getStarredChatIds: () => new Set<string>(),
      getPRWorktree: () => undefined,
    };
    const folderHarness = {
      getInstalled: async () => [claudeAdapter],
      hasMultipleInstalled: async () => false,
      get: () => claudeAdapter,
    };
    const folderProvider = new WorkspacesTreeProvider(
      folderStorage as any,
      folderGit as any,
      terminalManager as any,
      folderHarness as any,
      { scheme: 'file', path: '/extension' } as any
    );

    const roots = await folderProvider.getChildren();
    const folderRoot = roots[0] as any;
    check(
      folderRoot.contextValue === 'folderRepository',
      `plain folder context: ${folderRoot.contextValue}`
    );
    check(
      folderRoot.iconPath.id === 'folder',
      `plain folder icon: ${folderRoot.iconPath.id}`
    );
    check(
      folderRoot.tooltip.includes('Not a git repository'),
      'tooltip explains that the root is not a git repository'
    );
    check(
      folderRoot.collapsibleState ===
        vscode.TreeItemCollapsibleState.Collapsed,
      'a plain folder with sessions expands'
    );
    check(
      (roots[1] as any).collapsibleState ===
        vscode.TreeItemCollapsibleState.None,
      'an empty plain folder has nothing to expand'
    );

    const folderChildren = await folderProvider.getChildren(folderRoot);
    check(
      folderChildren.length === 1 && folderChildren[0].itemType === 'chat',
      'sessions render directly under a plain folder'
    );
    check(
      folderProvider.getParent(folderChildren[0])?.id === folderRoot.id,
      'a folder session reveals through its folder row'
    );
    check(
      folderProvider.getWorktreeForItem(folderRoot)?.id === 'wt-folder',
      'a folder row resolves to its root worktree'
    );
    check(
      folderProvider.getTreeItemForWorktree(
        folderProvider.getWorktreeForItem(folderRoot)!
      ).itemType === 'repository',
      'a plain folder worktree reveals through its folder row'
    );

    // `git init` upgrades the row through a file watcher alone; no manual
    // refresh. The deterministic worktree id keeps every chat bound to it.
    // Deliver the event to every watcher registered under the root, the way
    // VS Code does, so the test proves the behavior rather than naming the
    // watcher that implements it.
    const fireFileEvent = (base: string, event: 'create' | 'delete') => {
      // Snapshot: a handler may rebuild the watcher set, which appends to the
      // stub's registry.
      for (const watcher of [...(vscode as any).__fileWatchers]) {
        if (!watcher.disposed && watcher.pattern?.base === base) {
          if (event === 'create') {
            watcher.__fireCreate();
          } else {
            watcher.__fireDelete();
          }
        }
      }
    };

    check(
      (vscode as any).__fileWatchers.some(
        (watcher: any) =>
          watcher.pattern?.base === '/tmp/agntree-notes' && !watcher.disposed
      ),
      'the folder root is watched for git changes'
    );
    isGit = true;
    fireFileEvent('/tmp/agntree-notes', 'create');
    check(
      await waitFor(async () => {
        const currentRoots = await folderProvider.getChildren();
        return (currentRoots[0] as any)?.contextValue === 'repository';
      }),
      'creating .git upgrades the row without a manual refresh'
    );

    const upgradedRoots = await folderProvider.getChildren();
    const upgradedRoot = upgradedRoots[0] as any;
    check(
      upgradedRoot.contextValue === 'repository',
      `upgraded context: ${upgradedRoot.contextValue}`
    );
    const upgradedParent = folderProvider.getParent(folderChildren[0]);
    check(
      upgradedParent?.itemType === 'worktree' &&
        (upgradedParent.data as any).id === 'wt-folder',
      'after git init a folder session reveals through the main worktree'
    );
    check(
      folderProvider.getWorktreeForItem(upgradedRoot) === undefined,
      'a git repository row no longer stands in for a worktree'
    );
    check(
      folderProvider.getTreeItemForWorktree(
        folderProvider.getWorktreeById('wt-folder')!
      ).itemType === 'worktree',
      'a git worktree reveals through its worktree row'
    );
    const folderChatItems = await folderProvider.getChildren(
      upgradedParent as any
    );
    check(
      folderChatItems.length === 1 && folderChatItems[0].data.id === 'chat-folder',
      'sessions stay bound after git init'
    );

    // Removing `.git` turns the row back into a plain folder, again through
    // the watcher alone.
    isGit = false;
    fireFileEvent('/tmp/agntree-notes', 'delete');
    check(
      await waitFor(async () => {
        const currentRoots = await folderProvider.getChildren();
        return (currentRoots[0] as any)?.contextValue === 'folderRepository';
      }),
      'deleting .git turns the row back into a plain folder'
    );
    check(
      folderProvider.getParent(folderChatItems[0])?.itemType === 'repository',
      'after .git is removed a session reveals through its folder row again'
    );

    folderProvider.dispose();
  }

  provider.dispose();
  console.log(`\n${failures === 0 ? 'ALL TREE PROVIDER CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
