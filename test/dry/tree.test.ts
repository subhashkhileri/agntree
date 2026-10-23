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

  const gitService = { listWorktrees: () => [worktree] };

  const terminalManager = {
    onTerminalStateChange: () => ({ dispose: () => undefined }),
    isActive: () => false,
  };

  const claudeAdapter = {
    id: 'claude',
    displayName: 'Claude Code',
    icon: 'sparkle',
    treeIcons: harnessTreeIcons('claude'),
    capabilities: { fork: true, move: false, recap: true, preview: 'inline' },
    getSessionMetadata: async (id: string) =>
      id === 'claude-1'
        ? {
            lastActivity: now - 16 * 60 * 1000,
            recap: 'A claude recap',
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
    capabilities: { fork: true, move: true, recap: false, preview: 'lazy' },
    getSessionMetadata: async (id: string) =>
      id === 'ses_2'
        ? {
            lastActivity: now - 33 * 60 * 1000,
            recap: null,
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
  check(claudeTooltip.includes('A claude recap'), 'claude tooltip shows the recap');
  check(claudeTooltip.includes('Last ask'), 'claude tooltip shows the last ask');
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
  check(
    refreshed.tooltip.value.includes('opencode preview'),
    'opencode preview appears after the background fetch'
  );
  check(
    (provider as any).previewCache.has('opencode:ses_2'),
    'opencode preview is cached for subsequent renders'
  );

  provider.dispose();
  console.log(`\n${failures === 0 ? 'ALL TREE PROVIDER CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
