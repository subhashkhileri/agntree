import {
  CodexAppServer,
  CodexItemEntry,
  CodexThread,
  CodexThreadItem,
} from '../services/CodexAppServer';
import { CodexRolloutService } from '../services/CodexRollout';
import { CodexUiService } from '../services/CodexUiService';
import { CodexUiSurfaceService } from '../services/CodexUiSurfaceService';
import {
  ForkResult,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  LaunchOptions,
  NativeUiCapability,
  NativeUiOpenResult,
  PreviewMessage,
  SessionMetadata,
} from './types';
import {
  commandExists,
  getHarnessCommand,
  quoteShellArgument,
} from './commandUtils';
import { harnessTreeIcons } from './treeIcons';
import { isWithin } from '../utils/paths';
import { clampInlineText } from '../utils/text';

export interface CodexHarnessOptions {
  appServer?: CodexAppServer;
  rollouts?: CodexRolloutService;
  uiService?: CodexUiService;
  uiSurfaces?: CodexUiSurfaceService;
}

const THREAD_CACHE_TTL_MS = 5_000;
const ITEM_CACHE_TTL_MS = 5_000;
const ITEM_CACHE_LIMIT = 50;
const LIVE_WINDOW_MS = 15 * 60_000;
const MAX_LIVE_READS = 25;
const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 20;

/**
 * Codex harness backed by `codex app-server`.
 *
 * Threads, previews, metadata, and forks all come from the app-server. The
 * one exception is live turn state: the app-server does not execute the
 * `codex` processes Agntree starts, so it cannot report whether a TUI-owned
 * thread is working. That comes from the tail of the thread's rollout file.
 */
export class CodexHarness implements HarnessAdapter {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly icon = 'terminal';
  readonly treeIcons = harnessTreeIcons('codex');
  readonly capabilities: HarnessCapabilities = {
    fork: true,
    move: false,
    newSessionId: false,
    preview: 'inline',
  };
  readonly nativeUi: NativeUiCapability;

  private readonly appServer: CodexAppServer;
  private readonly rollouts: CodexRolloutService;
  private readonly uiService: CodexUiService;
  private readonly uiSurfaces: CodexUiSurfaceService;

  private threadCache:
    | { fetchedAt: number; threads: CodexThread[] }
    | undefined;
  private threadRequest: Promise<CodexThread[]> | undefined;
  private readonly itemCache = new Map<
    string,
    { fetchedAt: number; items: CodexItemEntry[] }
  >();

  constructor(options: CodexHarnessOptions = {}) {
    this.appServer =
      options.appServer ??
      new CodexAppServer({ resolveCommand: () => this.command });
    this.rollouts = options.rollouts ?? new CodexRolloutService();
    this.uiService = options.uiService ?? new CodexUiService();
    this.uiSurfaces = options.uiSurfaces ?? new CodexUiSurfaceService();
    this.nativeUi = {
      displayName: 'Codex UI',
      contextValueSuffix: 'CodexUi',
      extensionId: this.uiService.extensionId,
      isInstalled: () => this.uiService.isInstalled(),
      checkAvailability: (cwd) => this.uiService.checkAvailability(cwd),
      checkNewSessionAvailability: (cwd) =>
        this.uiService.checkNewSessionAvailability(cwd),
      openNewSession: (cwd) => this.uiService.openNewSession(cwd),
      openSession: (sessionId, cwd) =>
        this.uiService.openSession(sessionId, cwd),
      surfaces: this.uiSurfaces,
    };
  }

  get command(): string {
    return getHarnessCommand('codex', 'codex');
  }

  async isInstalled(): Promise<boolean> {
    return commandExists(this.command);
  }

  buildLaunchCommand(options: LaunchOptions): string {
    const command = quoteShellArgument(this.command);
    const cwd = quoteShellArgument(options.worktreePath);

    if (options.forkFromSessionId) {
      return `${command} fork ${quoteShellArgument(
        options.forkFromSessionId
      )} --cd ${cwd}`;
    }
    if (options.sessionId) {
      return `${command} resume ${quoteShellArgument(
        options.sessionId
      )} --cd ${cwd}`;
    }
    return command;
  }

  async isSessionResumable(sessionId: string): Promise<boolean> {
    try {
      await this.appServer.readThread(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  async listSessionsForWorktree(
    worktreePath: string,
    force = false
  ): Promise<HarnessSession[]> {
    return this.sessionsFor([worktreePath], force);
  }

  async listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]> {
    return this.sessionsFor([repoRootPath, ...worktreePaths]);
  }

  private async sessionsFor(
    roots: string[],
    force = false
  ): Promise<HarnessSession[]> {
    const threads = await this.listThreads(force);
    const visible = this.visibleThreads(threads)
      .filter((thread) =>
        roots.some((root) => isWithin(thread.cwd, root))
      )
      .sort(byRecency);

    const sessions = new Map(
      visible.map((thread) => [thread.id, this.toHarnessSession(thread)])
    );
    await this.applyLiveState(visible, sessions);

    // `visible` is already newest-first, and the map preserves insertion
    // order, so the session list is sorted without a second comparison.
    return Array.from(sessions.values());
  }

  async getSessionMetadata(
    sessionId: string,
    _cwd?: string
  ): Promise<SessionMetadata | null> {
    const cached = this.threadCache?.threads.find(
      (thread) => thread.id === sessionId
    );

    let thread: CodexThread;
    let items: CodexItemEntry[];
    try {
      [thread, items] = await Promise.all([
        cached ??
          this.appServer
            .readThread(sessionId)
            .then((response) => response.thread),
        this.recentItems(sessionId),
      ]);
    } catch {
      return null;
    }

    const rollout = await this.rollouts.read(thread.path);
    // Items are newest-first; metadata previews are oldest-first.
    const preview = userPreviews(items).slice(0, 3).reverse();
    const lastReply = lastAgentReply(items);

    return {
      lastActivity: latestActivity(thread, items),
      preview,
      lastAsk: preview.length ? preview[preview.length - 1] : null,
      lastReply,
      messageCount:
        rollout && rollout.messageCount > 0
          ? rollout.messageCount
          : undefined,
      model: thread.model ?? undefined,
      tokens: rollout?.tokens,
    };
  }

  async getPreview(
    sessionId: string,
    maxMessages = 3
  ): Promise<PreviewMessage[]> {
    const items = await this.recentItems(sessionId);
    // Items are newest-first; return the newest prompts oldest-first.
    return userPreviews(items).slice(0, maxMessages).reverse();
  }

  async forkSession(
    sessionId: string,
    cwd?: string
  ): Promise<ForkResult> {
    const workdir = cwd ?? (await this.resolveThreadCwd(sessionId));
    const fork = await this.appServer.forkThread(sessionId, workdir);
    this.invalidateCaches();
    return { kind: 'linked', sessionId: fork.id };
  }

  async moveSession(
    _sessionId: string,
    _directory: string
  ): Promise<void> {
    throw new Error('Codex does not support moving a thread between directories');
  }

  async prepareForkToNewWorktree(
    sessionId: string,
    _sourceWorktreePath: string,
    destinationWorktreePath: string
  ): Promise<ForkResult> {
    // thread/fork materializes the fork in the destination cwd immediately, so
    // there is nothing to move and no orphan to clean up.
    return this.forkSession(sessionId, destinationWorktreePath);
  }

  /** Stop the private app-server process and tab listeners. */
  dispose(): void {
    this.threadCache = undefined;
    this.itemCache.clear();
    this.uiSurfaces.dispose();
    this.appServer.dispose();
  }

  private async listThreads(force = false): Promise<CodexThread[]> {
    if (
      !force &&
      this.threadCache &&
      Date.now() - this.threadCache.fetchedAt < THREAD_CACHE_TTL_MS
    ) {
      return this.threadCache.threads;
    }
    if (this.threadRequest) {
      return this.threadRequest;
    }

    const request = this.fetchThreads();
    this.threadRequest = request;
    try {
      const threads = await request;
      this.threadCache = { fetchedAt: Date.now(), threads };
      return threads;
    } finally {
      this.threadRequest = undefined;
    }
  }

  private async fetchThreads(): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const response = await this.appServer.listThreads({
        limit: LIST_PAGE_SIZE,
        cursor,
        sortDirection: 'desc',
        // The default scan-and-repair path is slower, returns duplicates, and
        // blocks pagination while it inspects rollouts.
        useStateDbOnly: true,
      });
      threads.push(...response.data);

      const next = response.nextCursor ?? undefined;
      if (!next || response.data.length === 0 || seenCursors.has(next)) {
        break;
      }
      seenCursors.add(next);
      cursor = next;
    }

    // The state DB can briefly report the same thread twice while a rollout is
    // being indexed. Keep the newest row for each ID.
    return Array.from(
      new Map(threads.map((thread) => [thread.id, thread])).values()
    );
  }

  private visibleThreads(threads: CodexThread[]): CodexThread[] {
    return threads.filter(
      (thread) => !thread.ephemeral && !thread.parentThreadId
    );
  }

  private async applyLiveState(
    threads: CodexThread[],
    sessions: Map<string, HarnessSession>
  ): Promise<void> {
    const now = Date.now();
    const hot = threads
      .filter(
        (thread) =>
          Boolean(thread.path) &&
          now - threadTimestampMs(thread) < LIVE_WINDOW_MS
      )
      .slice(0, MAX_LIVE_READS);

    await Promise.all(
      hot.map(async (thread) => {
        const state = await this.rollouts.read(thread.path);
        const session = sessions.get(thread.id);
        if (!state || !session) {
          return;
        }
        if (state.turnState) {
          session.turnState = state.turnState;
          session.turnEndedAt = state.turnEndedAt;
        }
        if (state.tokens) {
          session.tokens = state.tokens;
        }
        if (state.messageCount > 0) {
          session.messageCount = state.messageCount;
        }
      })
    );
  }

  private async recentItems(threadId: string): Promise<CodexItemEntry[]> {
    const cached = this.itemCache.get(threadId);
    if (cached && Date.now() - cached.fetchedAt < ITEM_CACHE_TTL_MS) {
      // Refresh insertion order so the bound behaves as an LRU.
      this.itemCache.delete(threadId);
      this.itemCache.set(threadId, cached);
      return cached.items;
    }

    try {
      const page = await this.appServer.listItems(threadId, {
        limit: 50,
        sortDirection: 'desc',
      });
      this.cacheItems(threadId, page.data);
      return page.data;
    } catch {
      // Metadata is still useful (model, timestamps) without items. Cache the
      // empty page briefly so a failing server is not retried per render.
      this.cacheItems(threadId, []);
      return [];
    }
  }

  private cacheItems(threadId: string, items: CodexItemEntry[]): void {
    this.itemCache.delete(threadId);
    this.itemCache.set(threadId, { fetchedAt: Date.now(), items });

    while (this.itemCache.size > ITEM_CACHE_LIMIT) {
      const oldest = this.itemCache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.itemCache.delete(oldest);
    }
  }

  private async resolveThreadCwd(sessionId: string): Promise<string> {
    const cached = this.threadCache?.threads.find(
      (thread) => thread.id === sessionId
    );
    if (cached) {
      return cached.cwd;
    }
    const { thread } = await this.appServer.readThread(sessionId);
    return thread.cwd;
  }

  private invalidateCaches(): void {
    this.threadCache = undefined;
    this.itemCache.clear();
  }

  private toHarnessSession(thread: CodexThread): HarnessSession {
    const updatedAt = threadTimestampMs(thread);
    const preview = thread.preview?.trim();

    return {
      harness: 'codex',
      sessionId: thread.id,
      cwd: thread.cwd,
      summary: thread.name?.trim() || (preview ? clampInlineText(preview, 100) : null),
      gitBranch: thread.gitInfo?.branch ?? null,
      lastUpdated: updatedAt ? new Date(updatedAt) : null,
      lastActivity: updatedAt || null,
      // A message count needs the rollout or a full item page; it is filled
      // in for recent threads and by getSessionMetadata for tooltips.
      messageCount: 0,
      model: thread.model ?? undefined,
    };
  }
}

function threadTimestampMs(thread: CodexThread): number {
  const seconds = thread.updatedAt || thread.recencyAt || thread.createdAt || 0;
  return seconds > 0 ? seconds * 1000 : 0;
}

function byRecency(a: CodexThread, b: CodexThread): number {
  return threadTimestampMs(b) - threadTimestampMs(a);
}

function userPreviews(items: CodexItemEntry[]): PreviewMessage[] {
  const previews: PreviewMessage[] = [];
  for (const entry of items) {
    const text = userMessageText(entry.item);
    if (!text) {
      continue;
    }
    previews.push({
      text: clampInlineText(text, 100),
      timestamp: entryTimestamp(entry),
    });
  }
  return previews;
}

function lastAgentReply(items: CodexItemEntry[]): PreviewMessage | null {
  let fallback: PreviewMessage | null = null;

  for (const entry of items) {
    const item = entry.item;
    if (item.type !== 'agentMessage') {
      continue;
    }
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) {
      continue;
    }
    const message = {
      text: clampInlineText(text, 220),
      timestamp: entryTimestamp(entry),
    };
    if (item.phase === 'final_answer') {
      return message;
    }
    fallback ??= message;
  }

  return fallback;
}

function userMessageText(item: CodexThreadItem): string {
  if (item.type !== 'userMessage' || !Array.isArray(item.content)) {
    return '';
  }
  return item.content
    .filter(
      (part) => part.type === 'text' && typeof part.text === 'string'
    )
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join('\n');
}

function entryTimestamp(entry: CodexItemEntry): number | null {
  return entry.startedAtMs ?? entry.completedAtMs ?? null;
}

function latestActivity(
  thread: CodexThread,
  items: CodexItemEntry[]
): number | null {
  let latest = threadTimestampMs(thread) || null;
  for (const entry of items) {
    const timestamp = entry.completedAtMs ?? entry.startedAtMs ?? null;
    if (timestamp && (!latest || timestamp > latest)) {
      latest = timestamp;
    }
  }
  return latest;
}
