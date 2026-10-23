import * as vscode from 'vscode';
import * as path from 'path';
import { Repository, Worktree, ChatSession, TreeItemType } from '../types';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { GitHubService } from '../services/GitHubService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { harnessSessionKey, lastExchange, selectHarnessIconState, sessionUsageLine } from '../harnesses/sessionUtils';
import { harnessIconPath } from '../harnesses/treeIcons';
import {
  HarnessAdapter,
  HarnessIconState,
  PreviewMessage,
  SessionMetadata,
  TurnState,
} from '../harnesses/types';
import { clampInlineText, formatRelativeTime } from '../utils/text';

/** Codicon fallback for harnesses that ship no custom art. */
const FALLBACK_CHAT_ICONS: Record<
  HarnessIconState,
  { id: string; color: string }
> = {
  working: { id: 'pulse', color: 'charts.green' },
  done: { id: 'circle-filled', color: 'charts.green' },
  closed: { id: 'history', color: 'charts.orange' },
  new: { id: 'comment', color: 'charts.foreground' },
};

/**
 * Tree item representing a node in the workspaces tree
 */
export class WorkspaceTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    public readonly data: Repository | Worktree | ChatSession,
    public readonly contextValue: string
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    // Set stable ID for tree item identification across refreshes
    this.id = `${itemType}-${data.id}`;
  }
}

/**
 * Provides the tree data for the Workspaces view
 */
export class WorkspacesTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<WorkspaceTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Cache of worktrees by repository ID */
  private worktreeCache: Map<string, Worktree[]> = new Map();

  /** Cache of ahead/behind state, keyed by worktree path */
  private syncCache = new Map<
    string,
    { ahead: number; behind: number; fetchedAt: number }
  >();

  /** Lazily fetched previews for harnesses that do not inline them */
  private previewCache = new Map<string, PreviewMessage[]>();

  /**
   * Live turn state per chat, wired to the attention service after both exist.
   * Undefined means the harness has not reported one yet.
   */
  private turnStateProvider: (chatId: string) => TurnState | undefined =
    () => undefined;

  /** Service for GitHub PR status */
  private gitHubService = new GitHubService();

  /** Map of worktree ID to PR URL for context menu */
  private worktreePRUrls = new Map<string, string>();

  /** File watchers for git HEAD changes (branch switches) - one per repository */
  private headWatchers: vscode.FileSystemWatcher[] = [];

  /** Disposable for terminal state change listener */
  private terminalStateDisposable: vscode.Disposable;

  /** Debounce timer for HEAD change refresh */
  private headRefreshTimer: NodeJS.Timeout | undefined;

  /** Debounce timer for coalescing rapid refresh() calls */
  private refreshDebounceTimer: NodeJS.Timeout | undefined;

  /** Whether the pending debounced refresh should also drop caches */
  private pendingCacheClear = false;

  /** Tracks which repos have active HEAD watchers to avoid unnecessary recreation */
  private watchedRepoIds = '';

  /** Generation counter to discard stale PR background fetches */
  private prFetchGeneration = 0;

  /** Timer for periodic PR status refresh (every 5 minutes) */
  private prRefreshInterval: NodeJS.Timeout | undefined;

  /** PR refresh interval in milliseconds (5 minutes) */
  private static readonly PR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  /** Debounce window for coalescing refresh calls (ms) */
  private static readonly REFRESH_DEBOUNCE_MS = 300;

  /** How long ahead/behind counts stay cached (ms) */
  private static readonly SYNC_CACHE_MS = 15_000;

  constructor(
    private storageService: StorageService,
    private gitService: GitService,
    private terminalManager: TerminalManager,
    private harnessRegistry: HarnessRegistry,
    private extensionUri: vscode.Uri
  ) {
    // Refresh when terminal state changes
    this.terminalStateDisposable = terminalManager.onTerminalStateChange(() => {
      this.refresh();
    });

    // Watch for branch changes (git checkout/switch)
    this.setupHeadWatchers();

    // Start periodic PR status refresh (every 5 minutes)
    this.prRefreshInterval = setInterval(() => {
      this.gitHubService.clearCache();
      this._onDidChangeTreeData.fire(undefined);
    }, WorkspacesTreeProvider.PR_REFRESH_INTERVAL_MS);
  }

  /**
   * Set up file watchers for .git/HEAD changes to detect branch switches
   * Uses RelativePattern with absolute paths to watch repositories outside workspace
   */
  setupHeadWatchers(): void {
    // Dispose existing watchers
    this.headWatchers.forEach(w => w.dispose());
    this.headWatchers = [];

    const debouncedRefresh = () => {
      if (this.headRefreshTimer) {
        clearTimeout(this.headRefreshTimer);
      }
      this.headRefreshTimer = setTimeout(() => {
        // A branch switch changes the upstream distance.
        this.syncCache.clear();
        this.refresh();
      }, 300); // 300ms debounce
    };

    // Create watchers for each repository
    const repositories = this.storageService.getRepositories();
    for (const repo of repositories) {
      const gitDir = path.join(repo.rootPath, '.git');

      // Watch main worktree HEAD: .git/HEAD
      const mainPattern = new vscode.RelativePattern(gitDir, 'HEAD');
      const mainWatcher = vscode.workspace.createFileSystemWatcher(mainPattern);
      mainWatcher.onDidChange(debouncedRefresh);
      mainWatcher.onDidCreate(debouncedRefresh);
      this.headWatchers.push(mainWatcher);

      // Watch other worktrees HEAD: .git/worktrees/*/HEAD
      const worktreesPattern = new vscode.RelativePattern(gitDir, 'worktrees/*/HEAD');
      const worktreesWatcher = vscode.workspace.createFileSystemWatcher(worktreesPattern);
      worktreesWatcher.onDidChange(debouncedRefresh);
      worktreesWatcher.onDidCreate(debouncedRefresh);
      this.headWatchers.push(worktreesWatcher);
    }
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.terminalStateDisposable.dispose();
    this.headWatchers.forEach(w => w.dispose());
    this.headWatchers = [];
    this.syncCache.clear();
    if (this.headRefreshTimer) {
      clearTimeout(this.headRefreshTimer);
    }
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    if (this.prRefreshInterval) {
      clearInterval(this.prRefreshInterval);
    }
  }

  /**
   * Get PR URL for a worktree (used by context menu command)
   */
  getPRUrl(worktreeId: string): string | undefined {
    return this.worktreePRUrls.get(worktreeId);
  }

  /**
   * Wire the live turn state used to pick the working/done mark. Wired after
   * construction because the attention service depends on this provider for
   * worktree lookup.
   */
  setTurnStateProvider(
    provider: (chatId: string) => TurnState | undefined
  ): void {
    this.turnStateProvider = provider;
  }

  /**
   * Refresh the tree view (debounced — multiple rapid calls coalesce into one)
   */
  refresh(): void {
    this.scheduleRefresh(true);
  }

  /**
   * Re-render without dropping the worktree/PR caches. Use when a chat's
   * content changed (name, preview) but the repository structure did not.
   */
  softRefresh(): void {
    this.scheduleRefresh(false);
  }

  private scheduleRefresh(clearCaches: boolean): void {
    this.pendingCacheClear = this.pendingCacheClear || clearCaches;
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
    }
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = undefined;
      const clear = this.pendingCacheClear;
      this.pendingCacheClear = false;
      this.doRefresh(clear);
    }, WorkspacesTreeProvider.REFRESH_DEBOUNCE_MS);
  }

  private doRefresh(clearCaches: boolean = true): void {
    if (clearCaches) {
      this.worktreeCache.clear();
      this.gitHubService.clearCache();
      this.worktreePRUrls.clear();
    }
    this.updateHeadWatchersIfNeeded();
    this._onDidChangeTreeData.fire(undefined);
  }

  private updateHeadWatchersIfNeeded(): void {
    const repositories = this.storageService.getRepositories();
    const currentRepoIds = repositories.map(r => r.id).sort().join(',');
    if (currentRepoIds !== this.watchedRepoIds) {
      this.watchedRepoIds = currentRepoIds;
      this.setupHeadWatchers();
    }
  }

  /**
   * Get tree item for display
   */
  getTreeItem(element: WorkspaceTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get parent of a tree item (required for reveal() to work)
   */
  getParent(element: WorkspaceTreeItem): WorkspaceTreeItem | undefined {
    switch (element.itemType) {
      case 'chat': {
        const chat = element.data as ChatSession;
        const worktree = this.getWorktreeById(chat.worktreeId);
        return worktree ? this.getWorktreeTreeItem(worktree) : undefined;
      }
      case 'worktree': {
        const worktree = element.data as Worktree;
        const repo = this.storageService.getRepository(worktree.repoId);
        return repo ? this.getRepositoryTreeItem(repo) : undefined;
      }
      case 'repository':
      default:
        return undefined;
    }
  }

  /**
   * Get children of a tree item
   */
  async getChildren(element?: WorkspaceTreeItem): Promise<WorkspaceTreeItem[]> {
    if (!element) {
      // Root level: show repositories
      return this.getRepositoryItems();
    }

    switch (element.itemType) {
      case 'repository':
        return this.getWorktreeItems(element.data as Repository);
      case 'worktree':
        return this.getChatItems(element.data as Worktree);
      case 'chat':
        // Chats don't have children (could add changed files here)
        return [];
      default:
        return [];
    }
  }

  /**
   * Get repository tree items
   */
  private getRepositoryItems(): WorkspaceTreeItem[] {
    const repositories = this.storageService.getRepositories();

    return repositories.map((repo) => {
      const worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      this.worktreeCache.set(repo.id, worktrees);

      const item = new WorkspaceTreeItem(
        repo.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'repository',
        repo,
        'repository'
      );

      item.iconPath = new vscode.ThemeIcon(
        'repo',
        new vscode.ThemeColor('descriptionForeground')
      );

      item.tooltip = repo.rootPath;

      return item;
    });
  }

  /**
   * Get worktree tree items for a repository (sync, uses cached PR info)
   */
  private getWorktreeItems(repo: Repository): WorkspaceTreeItem[] {
    // Check cache first
    let worktrees = this.worktreeCache.get(repo.id);

    if (!worktrees) {
      worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      this.worktreeCache.set(repo.id, worktrees);
    }

    // Get current workspace folder to highlight active worktree
    const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Collect uncached branches for background fetch
    const uncachedBranches: string[] = [];

    const items = worktrees.map((worktree) => {
      const isCurrentWorkspace = currentFolder === worktree.path;

      const item = new WorkspaceTreeItem(
        worktree.name,
        vscode.TreeItemCollapsibleState.Collapsed,
        'worktree',
        worktree,
        'worktree'
      );

      // Check if this worktree was checked out from a PR
      const prWorktreeNumber = this.storageService.getPRWorktree(worktree.id);

      // Color marks state, not identity: amber for the open workspace, blue
      // for a PR checkout, green for the main worktree, neutral otherwise.
      if (isCurrentWorkspace) {
        item.iconPath = new vscode.ThemeIcon(
          'target',
          new vscode.ThemeColor('charts.yellow')
        );
      } else if (prWorktreeNumber) {
        item.iconPath = new vscode.ThemeIcon(
          'git-pull-request',
          new vscode.ThemeColor('charts.blue')
        );
      } else if (worktree.isMain) {
        item.iconPath = new vscode.ThemeIcon(
          'git-branch',
          new vscode.ThemeColor('charts.green')
        );
      } else {
        item.iconPath = new vscode.ThemeIcon(
          'git-branch',
          new vscode.ThemeColor('descriptionForeground')
        );
      }

      // Build the right-aligned state description.
      const descParts: string[] = [];
      if (isCurrentWorkspace) {
        descParts.push('●');
      }

      const sync = this.getSyncState(worktree.path);
      if (sync?.ahead) {
        descParts.push(`↑${sync.ahead}`);
      }
      if (sync?.behind) {
        descParts.push(`↓${sync.behind}`);
      }

      // Get cached PR info (sync - may be undefined if not fetched yet)
      const prInfo = this.gitHubService.getCachedPRInfo(repo.rootPath, worktree.name);

      if (prInfo === undefined) {
        // Not cached yet, queue for background fetch
        uncachedBranches.push(worktree.name);
      } else if (prInfo !== null) {
        // Store PR URL in Map for context menu
        this.worktreePRUrls.set(worktree.id, prInfo.url);
      }

      const prNumber = prWorktreeNumber ?? prInfo?.number;
      if (prNumber) {
        descParts.push(`PR #${prNumber}`);
      }

      if (descParts.length > 0) {
        item.description = descParts.join(' · ');
      }

      const tooltipParts = [worktree.path];
      if (isCurrentWorkspace) {
        tooltipParts.push('Active workspace');
      }
      if (prInfo) {
        tooltipParts.push(`PR #${prInfo.number}: ${prInfo.title}`);
      }
      item.tooltip = tooltipParts.join('\n\n');

      return item;
    });

    // Start background fetch for uncached branches
    if (uncachedBranches.length > 0) {
      this.fetchPRInfoInBackground(repo.rootPath, uncachedBranches);
    }

    return items;
  }

  /**
   * Ahead/behind counts are cached briefly because every terminal state change
   * refreshes the tree, and each count costs a git process.
   */
  private getSyncState(
    worktreePath: string
  ): { ahead: number; behind: number } | null {
    const cached = this.syncCache.get(worktreePath);
    if (
      cached &&
      Date.now() - cached.fetchedAt < WorkspacesTreeProvider.SYNC_CACHE_MS
    ) {
      return { ahead: cached.ahead, behind: cached.behind };
    }

    const state = this.gitService.getAheadBehind(worktreePath);
    if (!state) {
      this.syncCache.delete(worktreePath);
      return null;
    }

    this.syncCache.set(worktreePath, { ...state, fetchedAt: Date.now() });
    return state;
  }

  /**
   * Fetch PR info for branches in background, then refresh tree
   */
  private fetchPRInfoInBackground(repoPath: string, branches: string[]): void {
    const generation = ++this.prFetchGeneration;

    Promise.all(
      branches.map((branch) => this.gitHubService.fetchPRInfo(repoPath, branch))
    )
      .then(() => {
        if (generation === this.prFetchGeneration) {
          this._onDidChangeTreeData.fire(undefined);
        }
      })
      .catch((error) => {
        console.error('Failed to fetch PR info in background:', error);
        if (generation === this.prFetchGeneration) {
          this._onDidChangeTreeData.fire(undefined);
        }
      });
  }

  /**
   * Get chat tree items for a worktree
   */
  private async getChatItems(worktree: Worktree): Promise<WorkspaceTreeItem[]> {
    const chats = this.storageService.getChatsByWorktree(worktree.id);

    const starredIds = this.storageService.getStarredChatIds();

    const multiHarness = await this.harnessRegistry.hasMultipleInstalled();

    // Fetch metadata through each chat's adapter. Expensive fields (opencode
    // previews) are fetched lazily by getPreview when the tooltip needs them.
    const metadata = new Map<string, SessionMetadata | null>();
    await Promise.all(
      chats.map(async (chat) => {
        if (!chat.harnessSessionId) {
          return;
        }

        const adapter = this.harnessRegistry.get(chat.harness);
        try {
          const meta = await adapter.getSessionMetadata(
            chat.harnessSessionId,
            worktree.path
          );
          if (meta) {
            metadata.set(chat.id, meta);
          }
        } catch {
          metadata.set(chat.id, null);
        }
      })
    );

    const sortTime = (chat: ChatSession): number =>
      metadata.get(chat.id)?.lastActivity ??
      chat.lastAccessedAt ??
      chat.createdAt;

    // Pinned first, then open terminals, then everything by recent activity.
    const activeIds = new Set(
      chats.filter((chat) => this.terminalManager.isActive(chat.id)).map((chat) => chat.id)
    );
    const rank = (chat: ChatSession): number => {
      if (starredIds.has(chat.id)) return 0;
      return activeIds.has(chat.id) ? 1 : 2;
    };

    chats.sort((a, b) => rank(a) - rank(b) || sortTime(b) - sortTime(a));

    return chats.map((chat) => {
      const isActive = activeIds.has(chat.id);
      const isStarred = starredIds.has(chat.id);
      const meta = metadata.get(chat.id) ?? null;
      const lastActivity = meta?.lastActivity ?? null;
      const adapter = this.harnessRegistry.get(chat.harness);
      // The mark carries harness identity. Keep the text label only for
      // adapters without custom art, where the icon is just a state codicon.
      const harnessLabel =
        multiHarness && !adapter.treeIcons ? ` · ${chat.harness}` : '';

      const item = new WorkspaceTreeItem(
        chat.name,
        vscode.TreeItemCollapsibleState.None,
        'chat',
        chat,
        isActive ? (isStarred ? 'runningStarredChat' : 'runningChat') : (isStarred ? 'starredChat' : 'chat')
      );

      this.applyChatIcon(item, chat, adapter, isActive, isStarred);

      let description: string;
      if (!chat.harnessSessionId) {
        description = 'new';
      } else {
        const timeSource =
          lastActivity ?? (isActive ? Date.now() : chat.lastAccessedAt);
        description = formatRelativeTime(timeSource, { short: true });
      }
      if (isStarred) {
        description = `★ ${description}`;
      }

      item.description = `${description}${harnessLabel}`;
      item.tooltip = this.formatChatTooltip(chat, adapter.displayName, meta);

      // Make it clickable to open the chat
      item.command = {
        command: 'agntree.openChat',
        title: 'Open Chat',
        arguments: [item],
      };

      return item;
    });
  }

  /**
   * Custom harness marks carry harness identity; the generated state variants
   * animate the mark while a turn runs and add the done/closed/new badge.
   * Adapters without custom art fall back to the state codicons.
   */
  private applyChatIcon(
    item: WorkspaceTreeItem,
    chat: ChatSession,
    adapter: HarnessAdapter,
    isActive: boolean,
    isStarred: boolean
  ): void {
    const state = selectHarnessIconState(
      chat,
      isActive,
      this.turnStateProvider(chat.id)
    );

    if (adapter.treeIcons) {
      item.iconPath = harnessIconPath(this.extensionUri, adapter, state);
      return;
    }

    const icon = isStarred
      ? {
          id: 'star-full',
          color: isActive ? 'charts.green' : 'charts.yellow',
        }
      : FALLBACK_CHAT_ICONS[state];
    item.iconPath = new vscode.ThemeIcon(
      icon.id,
      new vscode.ThemeColor(icon.color)
    );
  }

  /**
   * Get a minimal tree item for a repository (for getParent/reveal)
   */
  getRepositoryTreeItem(repo: Repository): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      repo.name,
      vscode.TreeItemCollapsibleState.Expanded,
      'repository',
      repo,
      'repository'
    );
  }

  /**
   * Get a minimal tree item for a worktree (for getParent/reveal)
   */
  getWorktreeTreeItem(worktree: Worktree): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      worktree.name,
      vscode.TreeItemCollapsibleState.Expanded,
      'worktree',
      worktree,
      'worktree'
    );
  }

  /**
   * Get a minimal tree item for a chat (for getParent/reveal)
   */
  getChatTreeItem(chat: ChatSession): WorkspaceTreeItem {
    return new WorkspaceTreeItem(
      chat.name,
      vscode.TreeItemCollapsibleState.None,
      'chat',
      chat,
      'chat'
    );
  }

  /**
   * Get worktree by ID (for use by commands)
   */
  getWorktreeById(worktreeId: string): Worktree | undefined {
    for (const worktrees of this.worktreeCache.values()) {
      const found = worktrees.find((w) => w.id === worktreeId);
      if (found) return found;
    }

    // If not in cache, search all repos
    const repos = this.storageService.getRepositories();
    for (const repo of repos) {
      const worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      const found = worktrees.find((w) => w.id === worktreeId);
      if (found) return found;
    }

    return undefined;
  }

  findWorktreeByPath(targetPath: string): Worktree | undefined {
    for (const worktrees of this.worktreeCache.values()) {
      const found = worktrees.find((w) => w.path === targetPath);
      if (found) return found;
    }
    const repos = this.storageService.getRepositories();
    for (const repo of repos) {
      const worktrees = this.gitService.listWorktrees(repo.rootPath, repo.id);
      const found = worktrees.find((w) => w.path === targetPath);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * A session brief: what the session is about, where the last turn ended,
   * and the usage facts that are not visible in the row.
   *
   * Harness, open/closed state, the worktree, and the star are deliberately
   * absent: the row already carries all of them.
   */
  private formatChatTooltip(
    chat: ChatSession,
    harnessName: string,
    meta: SessionMetadata | null
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportHtml = true;

    md.appendMarkdown(`**${this.escapeTooltipText(chat.name)}**\n\n`);

    if (!chat.harnessSessionId) {
      md.appendMarkdown(`**No messages yet**\n\n`);
      md.appendMarkdown(`The first prompt will create the native session.\n\n`);
      md.appendMarkdown(`Started ${formatRelativeTime(chat.createdAt)}.\n\n`);
      return md;
    }

    if (!meta) {
      md.appendMarkdown(`**Session unavailable**\n\n`);
      md.appendMarkdown(
        `Agntree could not read the native session. It may have been removed or moved.\n\n`
      );
      return md;
    }

    const preview = this.getChatPreview(chat, meta);
    const { lastAsk, lastReply } = lastExchange(meta, preview);

    if (meta.recap) {
      const age = meta.recapAt
        ? ` · ${formatRelativeTime(meta.recapAt)}`
        : '';
      md.appendMarkdown(`**Recap${age}**\n\n`);
      md.appendMarkdown(
        `${this.escapeTooltipText(clampInlineText(meta.recap, 320))}\n\n`
      );

      if (lastAsk) {
        md.appendMarkdown(
          `**Last ask${this.formatTooltipTime(lastAsk.timestamp)}**\n\n`
        );
        md.appendMarkdown(
          `> ${this.escapeTooltipText(clampInlineText(lastAsk.text, 220))}\n\n`
        );
      }
    } else if (lastAsk || lastReply) {
      md.appendMarkdown(`**Last exchange**\n\n`);

      if (lastAsk) {
        md.appendMarkdown(
          `**You${this.formatTooltipTime(lastAsk.timestamp)}**\n\n`
        );
        md.appendMarkdown(
          `> ${this.escapeTooltipText(clampInlineText(lastAsk.text, 220))}\n\n`
        );
      }
      if (lastReply) {
        md.appendMarkdown(
          `**${this.escapeTooltipText(harnessName)}${this.formatTooltipTime(lastReply.timestamp)}**\n\n`
        );
        md.appendMarkdown(
          `${this.escapeTooltipText(clampInlineText(lastReply.text, 220))}\n\n`
        );
      }
    } else if (!meta.model && !meta.agent && !meta.tokens) {
      md.appendMarkdown(`No recent messages.\n\n`);
    }

    const footer: string[] = [];
    const usage = sessionUsageLine(meta);
    if (usage) {
      footer.push(usage);
    }
    if (
      meta.lastActivity &&
      Date.now() - meta.lastActivity > 24 * 60 * 60 * 1000
    ) {
      footer.push(
        `last active ${new Date(meta.lastActivity).toLocaleDateString()}`
      );
    }

    if (footer.length > 0) {
      md.appendMarkdown(`---\n\n${footer.join(' · ')}\n\n`);
    }

    return md;
  }

  private formatTooltipTime(timestamp: number | null | undefined): string {
    return timestamp ? ` · ${formatRelativeTime(timestamp)}` : '';
  }

  private escapeTooltipText(text: string): string {
    return text.replace(/([\\`*_{}\[\]<>#|~])/g, '\\$1');
  }

  /**
   * Claude previews arrive with the metadata. Harnesses that mark previews as
   * lazy (opencode) need an export, so fetch it once in the background and
   * refresh when it lands.
   */
  private getChatPreview(
    chat: ChatSession,
    meta: SessionMetadata | null
  ): PreviewMessage[] {
    if (!chat.harnessSessionId) {
      return [];
    }
    if (meta?.preview && meta.preview.length > 0) {
      return meta.preview;
    }

    const adapter = this.harnessRegistry.get(chat.harness);
    if (adapter.capabilities.preview !== 'lazy') {
      return meta?.preview ?? [];
    }

    const key = harnessSessionKey(chat.harness, chat.harnessSessionId);
    const cached = this.previewCache.get(key);
    if (cached) {
      return cached;
    }

    // Cache an empty placeholder while the export is in flight so repeated
    // renders do not queue more of them.
    this.previewCache.set(key, []);
    void adapter
      .getPreview(chat.harnessSessionId, 3)
      .then((messages) => {
        this.previewCache.set(key, messages);
        if (messages.length > 0) {
          this.softRefresh();
        }
      })
      .catch(() => {
        // Keep the empty placeholder so a broken session doesn't retry every render.
      });

    return [];
  }

}
