import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { HarnessSession, PreviewMessage, TurnState } from '../harnesses/types';
import { getHarnessCommand } from '../harnesses/commandUtils';
import { canonicalPath } from '../utils/paths';
import { clampInlineText, lastTextBlock, promptMatcher } from '../utils/text';

/** Session shape returned by the opencode v2 API. */
export interface OpencodeSessionInfo {
  id: string;
  parentID?: string;
  projectID: string;
  title?: string | null;
  agent?: string;
  model?: {
    id: string;
    providerID: string;
    variant?: string;
  };
  /** Set when the last turn finished (`succeeded`, `failed`, ...). */
  outcome?: string;
  time: {
    created: number;
    updated: number;
    /** Set when the session last went idle; absent while a turn runs. */
    idle?: number;
    archived?: number;
  };
  location: {
    directory: string;
  };
}

export interface OpencodePreview {
  messages: PreviewMessage[];
  messageCount: number;
  /** Most recent assistant text (tool-only turns are skipped). */
  lastAssistant: PreviewMessage | null;
}

/**
 * Turn state from the list payload. opencode stamps `time.idle` when a session
 * becomes idle; a `time.updated` newer than that means a turn is running.
 */
export function deriveTurnState(
  time: OpencodeSessionInfo['time'] | undefined
): { turnState: TurnState; turnEndedAt: number | null } {
  const idle = time?.idle ?? 0;
  const updated = time?.updated ?? 0;
  return idle > 0 && idle >= updated
    ? { turnState: 'done', turnEndedAt: idle }
    : { turnState: 'working', turnEndedAt: null };
}

interface ListCacheEntry {
  fetchedAt: number;
  sessions: OpencodeSessionInfo[];
}

interface PreviewCacheEntry {
  fetchedAt: number;
  preview: OpencodePreview;
}

const LIST_TTL_MS = 5_000;
const PREVIEW_TTL_MS = 5 * 60_000;
const PREVIEW_CACHE_LIMIT = 50;
const API_TIMEOUT_MS = 15_000;
const EXPORT_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
const MAX_PAGES = 10;
/** The finder's global listing: enough pages for a bounded recent history. */
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 10;
const MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_PAGES = 5;

/**
 * Talks to opencode through its official CLI/API.
 *
 * We deliberately avoid reading opencode.db directly: the schema is internal
 * and changes between releases. `opencode api` also handles local-service
 * authentication for us.
 */
export class OpencodeSessionService {
  private readonly listCache = new Map<string, ListCacheEntry>();
  private readonly listRequests = new Map<string, Promise<OpencodeSessionInfo[]>>();
  private readonly previewCache = new Map<string, PreviewCacheEntry>();
  private readonly previewRequests = new Map<string, Promise<OpencodePreview>>();
  private readonly sessionIndex = new Map<string, OpencodeSessionInfo>();

  get command(): string {
    return getHarnessCommand('opencode', 'opencode');
  }

  /** Session metadata from the most recent list call, when known. */
  getCachedSession(sessionId: string): OpencodeSessionInfo | undefined {
    return this.sessionIndex.get(sessionId);
  }

  getSessionDirectory(sessionId: string): string {
    return this.sessionIndex.get(sessionId)?.location.directory ?? process.cwd();
  }

  async listSessions(
    cwd: string,
    options: { force?: boolean } = {}
  ): Promise<OpencodeSessionInfo[]> {
    const key = canonicalPath(cwd);
    const cached = this.listCache.get(key);
    if (!options.force && cached && Date.now() - cached.fetchedAt < LIST_TTL_MS) {
      return cached.sessions;
    }

    // Share one CLI fetch between concurrent callers (tree render, watcher,
    // metadata fallback) instead of spawning a process each.
    const inFlight = this.listRequests.get(key);
    if (inFlight) {
      return inFlight;
    }

    const request = this.fetchAndIndexSessions(key, cwd);
    this.listRequests.set(key, request);
    try {
      return await request;
    } finally {
      this.listRequests.delete(key);
    }
  }

  /**
   * Every top-level, non-archived session across all projects, newest first.
   * The finder uses this to build its snapshot; the list is deliberately not
   * cached beyond the call, since the snapshot is already per-search. A stop
   * or the search's preparation deadline ends the listing early.
   */
  async listAllSessions(
    options: { signal?: AbortSignal; deadline?: number } = {}
  ): Promise<OpencodeSessionInfo[]> {
    const sessions = new Map<string, OpencodeSessionInfo>();
    const pages = this.pages<OpencodeSessionInfo>(
      'session.list',
      { limit: String(SEARCH_PAGE_SIZE), parentID: 'null', archived: 'false' },
      { maxPages: MAX_SEARCH_PAGES, cwd: os.tmpdir(), ...options }
    );
    for await (const data of pages) {
      for (const session of data) {
        if (!sessions.has(session.id)) {
          sessions.set(session.id, session);
        }
      }
    }
    return [...sessions.values()].sort(
      (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
    );
  }

  /**
   * The user's own prompts in a session, oldest first. The message API
   * returns the messages the user sent, not opencode's synthetic context, so
   * these are the prompts a finder can quote.
   */
  async listUserMessages(
    sessionId: string,
    cwd?: string,
    signal?: AbortSignal
  ): Promise<PreviewMessage[]> {
    const prompts: PreviewMessage[] = [];
    const seen = new Set<string>();
    const pages = this.pages<{
      id?: string;
      text?: unknown;
      content?: unknown;
      time?: { created?: number };
    }>(
      'session.message.list',
      { sessionID: sessionId, type: 'user', limit: String(MESSAGE_PAGE_SIZE) },
      { maxPages: MAX_MESSAGE_PAGES, cwd: cwd ?? os.tmpdir(), signal }
    );
    for await (const data of pages) {
      for (const message of data) {
        const text =
          typeof message.text === 'string'
            ? message.text.trim()
            : lastTextBlock(message.content);
        if (!text || (message.id && seen.has(message.id))) {
          continue;
        }
        if (message.id) {
          seen.add(message.id);
        }
        prompts.push({ text, timestamp: message.time?.created ?? null });
      }
    }
    return prompts.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  }

  /**
   * A session and the earliest prompt the user typed in it that begins with
   * `opening`, ignoring case and whitespace. Null when the session no longer
   * exists; `prompt` is absent when the quote is not one of its prompts.
   */
  async findSessionPrompt(
    sessionId: string,
    opening: string,
    cwd?: string
  ): Promise<{ session: OpencodeSessionInfo; prompt?: PreviewMessage } | null> {
    const session = await this.getSession(sessionId, cwd);
    if (!session) {
      return null;
    }
    const matches = promptMatcher(opening);
    const prompt = matches
      ? (await this.listUserMessages(sessionId, cwd)).find((candidate) => matches(candidate.text))
      : undefined;
    return { session, prompt };
  }

  /**
   * Each page of a cursor-paged API operation, until the cursor runs out,
   * `maxPages`, or the deadline. The first page always runs; a deadline that
   * has passed stops before another round trip.
   */
  private async *pages<T>(
    operation: string,
    params: Record<string, string>,
    options: { maxPages: number; cwd: string; signal?: AbortSignal; deadline?: number }
  ): AsyncGenerator<T[]> {
    let cursor: string | undefined;
    for (let page = 0; page < options.maxPages; page++) {
      if (page > 0 && options.deadline !== undefined && Date.now() >= options.deadline) {
        return;
      }
      const response = await this.api<{ data?: T[]; cursor?: { next?: string } }>(
        operation,
        cursor ? { ...params, cursor } : params,
        undefined,
        options.cwd,
        options.signal
      );
      const data = response.data ?? [];
      yield data;
      const next = response.cursor?.next;
      if (!next || data.length === 0) {
        return;
      }
      cursor = next;
    }
  }

  private async fetchAndIndexSessions(
    key: string,
    cwd: string
  ): Promise<OpencodeSessionInfo[]> {
    let sessions: OpencodeSessionInfo[];
    try {
      sessions = await this.fetchSessions(cwd);
    } catch {
      // The CLI list is the documented fallback if the v2 API is unavailable.
      sessions = await this.fetchSessionsViaCli(cwd);
    }

    const byId = new Map<string, OpencodeSessionInfo>();
    for (const session of sessions) {
      byId.set(session.id, session);
      this.sessionIndex.set(session.id, session);
    }

    const result = Array.from(byId.values()).sort(
      (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
    );

    this.listCache.set(key, { fetchedAt: Date.now(), sessions: result });
    return result;
  }

  async getSession(
    sessionId: string,
    cwd?: string
  ): Promise<OpencodeSessionInfo | null> {
    try {
      const response = await this.api<{ data?: OpencodeSessionInfo }>(
        'session.get',
        { sessionID: sessionId },
        undefined,
        cwd ?? this.getSessionDirectory(sessionId)
      );
      const session = response.data;
      if (session) {
        this.sessionIndex.set(session.id, session);
      }
      return session ?? null;
    } catch {
      // A missing session and a transient error both end up here. Never claim
      // a session is resumable based on stale cache.
      return null;
    }
  }

  async forkSession(sessionId: string, cwd?: string): Promise<string> {
    const workdir = cwd ?? this.getSessionDirectory(sessionId);
    const response = await this.api<{ data?: OpencodeSessionInfo }>(
      'session.fork',
      { sessionID: sessionId },
      // The operation requires a JSON body; `before` is optional.
      {},
      workdir
    );

    const fork = response.data;
    if (!fork?.id) {
      throw new Error('opencode did not return a session ID for the fork');
    }

    this.sessionIndex.set(fork.id, fork);
    this.clearCaches();
    return fork.id;
  }

  async moveSession(
    sessionId: string,
    directory: string,
    cwd?: string
  ): Promise<void> {
    const workdir = cwd ?? this.getSessionDirectory(sessionId);
    await this.api(
      'session.move',
      { sessionID: sessionId },
      { directory },
      workdir
    );
    const cached = this.sessionIndex.get(sessionId);
    if (cached) {
      this.sessionIndex.set(sessionId, {
        ...cached,
        location: { directory },
      });
    }
    this.clearCaches();
  }

  async deleteSession(sessionId: string, cwd?: string): Promise<void> {
    // Only ever delete something that looks like an opencode session ID;
    // this runs unattended as fork cleanup.
    if (!/^ses_[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Refusing to delete "${sessionId}": not a valid session ID`);
    }
    const workdir = cwd ?? this.getSessionDirectory(sessionId);
    await this.exec(['session', 'delete', sessionId], workdir);
    this.sessionIndex.delete(sessionId);
    this.clearCaches();
  }

  /** Last parsed preview, without triggering an export. */
  getCachedPreview(sessionId: string): OpencodePreview | null {
    const cached = this.previewCache.get(sessionId);
    if (!cached || Date.now() - cached.fetchedAt >= PREVIEW_TTL_MS) {
      return null;
    }
    return cached.preview;
  }

  async getPreview(
    sessionId: string,
    maxMessages = 3,
    cwd?: string
  ): Promise<OpencodePreview> {
    const cached = this.getCachedPreview(sessionId);
    if (cached) {
      return cached;
    }

    // The tree and the search picker may ask for the same preview at once;
    // share the export instead of spawning two processes.
    const inFlight = this.previewRequests.get(sessionId);
    if (inFlight) {
      return inFlight;
    }

    const request = this.fetchPreview(sessionId, maxMessages, cwd);
    this.previewRequests.set(sessionId, request);
    try {
      return await request;
    } finally {
      this.previewRequests.delete(sessionId);
    }
  }

  private async fetchPreview(
    sessionId: string,
    maxMessages: number,
    cwd?: string
  ): Promise<OpencodePreview> {
    const exportCwd = cwd ?? this.getSessionDirectory(sessionId);
    // `opencode session export` truncates large transcripts when stdout is a
    // pipe. Redirect stdout straight to a file, which is not truncated.
    const raw = await this.execToFile(
      ['session', 'export', sessionId],
      exportCwd,
      EXPORT_TIMEOUT_MS
    );
    const parsed = JSON.parse(raw) as {
      info?: OpencodeSessionInfo;
      messages?: Array<{
        type?: string;
        text?: string;
        time?: { created?: number };
        content?: Array<{ type?: string; text?: string }>;
      }>;
    };

    if (parsed.info) {
      this.sessionIndex.set(parsed.info.id, parsed.info);
    }

    const messages = parsed.messages ?? [];
    const userMessages: PreviewMessage[] = [];
    let lastAssistant: PreviewMessage | null = null;
    for (const message of messages) {
      if (message.type === 'assistant') {
        const text = lastTextBlock(message.content);
        if (text) {
          lastAssistant = {
            text: clampInlineText(text, 220),
            timestamp: message.time?.created ?? null,
          };
        }
        continue;
      }
      if (message.type !== 'user' || typeof message.text !== 'string') {
        continue;
      }
      const text = message.text.trim();
      if (!text || text.startsWith('<')) {
        continue;
      }
      userMessages.push({
        text: clampInlineText(text, 100),
        timestamp: message.time?.created ?? null,
      });
    }

    const preview: OpencodePreview = {
      messages: userMessages.slice(-maxMessages),
      messageCount: messages.filter(
        (message) => message.type === 'user' || message.type === 'assistant'
      ).length,
      lastAssistant,
    };

    this.previewCache.set(sessionId, { fetchedAt: Date.now(), preview });
    this.evictPreviewCache();
    return preview;
  }

  clearCaches(): void {
    this.listCache.clear();
  }

  private async fetchSessions(cwd: string): Promise<OpencodeSessionInfo[]> {
    const sessions: OpencodeSessionInfo[] = [];
    const pages = this.pages<OpencodeSessionInfo>(
      'session.list',
      { limit: String(PAGE_SIZE) },
      { maxPages: MAX_PAGES, cwd }
    );
    for await (const data of pages) {
      sessions.push(...data);
    }
    return sessions;
  }

  /**
   * Fallback for environments where `opencode api` is unavailable.
   * The CLI list is project-scoped, top-level only, and lacks model/token data.
   */
  private async fetchSessionsViaCli(cwd: string): Promise<OpencodeSessionInfo[]> {
    const raw = await this.exec(
      ['session', 'list', '--format', 'json', '--max-count', String(PAGE_SIZE)],
      cwd
    );
    const parsed = JSON.parse(raw) as Array<{
      id: string;
      title?: string | null;
      updated?: number;
      created?: number;
      projectId?: string;
      directory?: string;
    }>;

    return (parsed ?? []).map((session) => ({
      id: session.id,
      projectID: session.projectId ?? '',
      title: session.title ?? null,
      time: {
        created: session.created ?? 0,
        updated: session.updated ?? session.created ?? 0,
      },
      location: { directory: session.directory ?? cwd },
    }));
  }

  private async api<T>(
    operation: string,
    params: Record<string, string>,
    data: unknown | undefined,
    cwd: string,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted();
    const args = ['api', operation];
    for (const [key, value] of Object.entries(params)) {
      args.push('--param', `${key}=${value}`);
    }
    if (data !== undefined) {
      args.push('--data', JSON.stringify(data));
    }

    let raw: string;
    try {
      raw = await this.exec(args, cwd, API_TIMEOUT_MS, signal);
    } catch (error) {
      // A stop is not a down service; retrying standalone would outlive it.
      signal?.throwIfAborted();
      if (!looksLikeServiceError(error)) {
        throw error;
      }
      // A private server keeps working when the background service is down.
      raw = await this.exec(
        ['api', '--standalone', operation, ...args.slice(2)],
        cwd,
        API_TIMEOUT_MS,
        signal
      );
    }

    if (!raw.trim()) {
      return {} as T;
    }
    return JSON.parse(raw) as T;
  }

  private exec(
    args: string[],
    cwd: string,
    timeoutMs = API_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        this.command,
        args,
        {
          cwd,
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
          env: process.env,
          signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            const detail = String(stderr || '').trim();
            const message = detail
              ? `${error.message}\n${detail}`
              : error.message;
            reject(new Error(message));
            return;
          }
          resolve(String(stdout));
        }
      );
    });
  }

  /**
   * Run a command with stdout redirected to a file, then return its contents.
   *
   * opencode truncates large output (session exports especially) when stdout
   * is a pipe, so we give it a regular file descriptor instead.
   */
  private execToFile(
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-opencode-'));
      const file = path.join(dir, 'output.json');
      let out: number | undefined;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }

        if (out !== undefined) {
          try {
            fs.closeSync(out);
          } catch {
            // Already closed by the child/OS.
          }
        }

        try {
          if (error) {
            reject(error);
          } else {
            resolve(fs.readFileSync(file, 'utf8'));
          }
        } catch (readError) {
          reject(readError instanceof Error ? readError : new Error(String(readError)));
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      };

      try {
        out = fs.openSync(file, 'w');
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      const child = spawn(this.command, args, {
        cwd,
        stdio: ['ignore', out, 'pipe'],
        windowsHide: true,
        env: process.env,
      });

      let stderr = '';
      timer = setTimeout(() => {
        child.kill();
        finish(
          new Error(`opencode ${args.slice(0, 2).join(' ')} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);

      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (code === 0) {
          finish();
          return;
        }
        const detail = stderr.trim();
        finish(
          new Error(
            `opencode ${args.slice(0, 2).join(' ')} failed (exit ${code})${detail ? `: ${detail}` : ''}`
          )
        );
      });
    });
  }

  private evictPreviewCache(): void {
    if (this.previewCache.size <= PREVIEW_CACHE_LIMIT) {
      return;
    }

    const oldest = Array.from(this.previewCache.entries()).sort(
      (a, b) => a[1].fetchedAt - b[1].fetchedAt
    );
    for (let i = 0; i < oldest.length - PREVIEW_CACHE_LIMIT; i++) {
      this.previewCache.delete(oldest[i][0]);
    }
  }
}

/** Map a listed session onto the shared session shape. */
export function toHarnessSession(session: OpencodeSessionInfo): HarnessSession {
  const updated = session.time?.updated ?? null;

  return {
    harness: 'opencode',
    sessionId: session.id,
    cwd: session.location.directory,
    summary: session.title?.trim() || null,
    gitBranch: null,
    lastUpdated: updated ? new Date(updated) : null,
    lastActivity: updated,
    messageCount: 0,
    ...deriveTurnState(session.time),
    model: formatModel(session),
    agent: session.agent,
  };
}

/** The session's model as `provider/model`, with `#variant` when one is set. */
export function formatModel(session: OpencodeSessionInfo): string | undefined {
  if (!session.model) {
    return undefined;
  }
  const base = `${session.model.providerID}/${session.model.id}`;
  return session.model.variant ? `${base}#${session.model.variant}` : base;
}

function looksLikeServiceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNREFUSED|ECONNRESET|fetch failed|server|service|connect/i.test(message);
}
