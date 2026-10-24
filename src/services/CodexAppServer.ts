import { ChildProcess, spawn } from 'child_process';
import { getHarnessCommand } from '../harnesses/commandUtils';

/**
 * Newline-delimited JSON-RPC client for the Codex app-server.
 *
 * The protocol is marked experimental upstream. Keep all wire handling in this
 * file: the harness and watcher should only see typed helpers.
 */

/** A thread row from `thread/list` or `thread/read`. Only fields we use. */
export interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string;
  cwd: string;
  model?: string | null;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  path?: string | null;
  parentThreadId?: string | null;
  ephemeral?: boolean;
  gitInfo?: {
    branch?: string | null;
    sha?: string | null;
    originUrl?: string | null;
  } | null;
}

export interface CodexThreadListParams {
  limit?: number;
  cursor?: string | null;
  sortDirection?: 'asc' | 'desc';
  /** Avoid the slow scan-and-repair path. Always true for discovery. */
  useStateDbOnly?: boolean;
}

export interface CodexThreadListPage {
  data: CodexThread[];
  nextCursor?: string | null;
}

export interface CodexThreadReadResult {
  thread: CodexThread;
}

/** One item in a thread's history, as returned by `thread/items/list`. */
export interface CodexItemEntry {
  turnId: string;
  item: CodexThreadItem;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
}

/**
 * Thread items are a large tagged union upstream. Agntree only reads user and
 * agent messages, so keep one permissive shape and check `type` at the call
 * site instead of modeling every tool item.
 */
export interface CodexThreadItem {
  type: string;
  id?: string;
  text?: string;
  phase?: 'commentary' | 'partial_answer' | 'final_answer' | null;
  content?: Array<{
    type?: string;
    text?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface CodexItemsPage {
  data: CodexItemEntry[];
}

export interface CodexServerInfo {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface CodexAppServerOptions {
  /** Override the CLI command (tests use a fixture process). */
  command?: string;
  /** Resolve the CLI command when the process starts, so settings changes apply. */
  resolveCommand?: () => string;
  /** Override the full argument list. */
  args?: string[];
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** How long the server may stay idle before it is stopped. 0 disables. */
  idleTimeoutMs?: number;
  /** Informational client version sent during the handshake. */
  clientVersion?: string;
}

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 20_000;
const START_FAILURE_BACKOFF_MS = 30_000;
const STDERR_TAIL_LIMIT = 2_000;

/**
 * The private server only needs threads loaded while a request is in flight.
 * Codex keeps a writer lock on a loaded thread for 30 minutes by default, so a
 * resumed fork would look "open in another app" until then.
 */
export const CODEX_APP_SERVER_ARGS = [
  '-c',
  'thread_unload_delay_secs=0',
  'app-server',
  '--listen',
  'stdio://',
] as const;

export class CodexAppServer {
  private readonly resolveCommand: () => string;
  private readonly args: string[];
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly clientVersion: string;

  private child: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private stopping = false;
  private disposed = false;
  private startFailure: { at: number; message: string } | undefined;
  private stdoutBuffer = '';
  private stderrTail = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private idleTimer: NodeJS.Timeout | undefined;

  private _serverInfo: CodexServerInfo | undefined;

  constructor(options: CodexAppServerOptions = {}) {
    const command = options.command;
    this.resolveCommand =
      options.resolveCommand ??
      (command ? () => command : () => getHarnessCommand('codex', 'codex'));
    this.args = options.args ?? [...CODEX_APP_SERVER_ARGS];
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clientVersion = options.clientVersion ?? '1.0.0';
  }

  /** Handshake details from the running server, once initialized. */
  get serverInfo(): CodexServerInfo | undefined {
    return this._serverInfo;
  }

  get isRunning(): boolean {
    return Boolean(this.child);
  }

  async listThreads(
    params: CodexThreadListParams = {}
  ): Promise<CodexThreadListPage> {
    return this.request<CodexThreadListPage>('thread/list', params, 60_000);
  }

  async readThread(
    threadId: string,
    includeTurns = false
  ): Promise<CodexThreadReadResult> {
    return this.request<CodexThreadReadResult>('thread/read', {
      threadId,
      includeTurns,
    });
  }

  async listItems(
    threadId: string,
    options: {
      limit?: number;
      sortDirection?: 'asc' | 'desc';
    } = {}
  ): Promise<CodexItemsPage> {
    return this.request<CodexItemsPage>('thread/items/list', {
      threadId,
      limit: options.limit ?? 50,
      sortDirection: options.sortDirection ?? 'desc',
    });
  }

  async forkThread(
    threadId: string,
    cwd: string
  ): Promise<CodexThread> {
    const response = await this.request<{ thread: CodexThread }>(
      'thread/fork',
      { threadId, cwd, excludeTurns: true },
      60_000
    );
    if (!response.thread?.id) {
      throw new CodexAppServerError(
        'Codex app-server did not return a thread ID for the fork'
      );
    }

    try {
      // Unloading releases the thread's writer lock. Without this the terminal
      // that opens the fork immediately afterwards reports that the
      // conversation is already open in another app.
      await this.request(
        'thread/unsubscribe',
        { threadId: response.thread.id },
        10_000
      );
    } catch {
      // Older servers may not know `thread/unsubscribe`. Stopping the private
      // server also releases the lock; the next request starts a new one.
      this.stopChild();
    }
    return response.thread;
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request('thread/delete', { threadId });
  }

  /** Send a typed request, starting the server first when needed. */
  async request<T>(
    method: string,
    params: unknown,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    await this.ensureStarted();
    return this.sendRequest<T>(method, params, timeoutMs);
  }

  private async ensureStarted(): Promise<void> {
    if (this.disposed) {
      throw new CodexAppServerError('The Codex app-server client was disposed');
    }
    if (this.child) {
      // A request arrived just as the idle timer was about to fire.
      this.clearIdleTimer();
      return;
    }
    if (
      this.startFailure &&
      Date.now() - this.startFailure.at < START_FAILURE_BACKOFF_MS
    ) {
      throw new CodexAppServerError(
        `Codex app-server is unavailable: ${this.startFailure.message}`
      );
    }
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.start();
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async start(): Promise<void> {
    try {
      this.stderrTail = '';
      const child = spawn(this.resolveCommand(), this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
      this.child = child;
      this.stopping = false;

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.handleStdout(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
      });
      child.on('error', (error) => this.handleExit(child, error));
      child.on('exit', (code, signal) => {
        const detail = signal
          ? `signal ${signal}`
          : `exit code ${code ?? 'unknown'}`;
        this.handleExit(
          child,
          new CodexAppServerError(
            `Codex app-server stopped (${detail})${this.stderrDetail()}`
          )
        );
      });

      this._serverInfo = await this.sendRequest<CodexServerInfo>(
        'initialize',
        {
          clientInfo: {
            name: 'agntree',
            title: 'Agntree',
            version: this.clientVersion,
          },
        },
        Math.min(this.requestTimeoutMs, START_TIMEOUT_MS)
      );
      this.notify('initialized', {});
      this.startFailure = undefined;
    } catch (error) {
      this.startFailure = {
        at: Date.now(),
        message: error instanceof Error ? error.message : String(error),
      };
      this.stopChild();
      throw error;
    }
  }

  private sendRequest<T>(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      return Promise.reject(
        new CodexAppServerError(
          `Codex app-server is not running${this.stderrDetail()}`
        )
      );
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexAppServerError(
            `Codex app-server request "${method}" timed out after ${timeoutMs}ms`
          )
        );
        this.scheduleIdleShutdown();
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new CodexAppServerError(String(error))
        );
      }
    });
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child || !child.stdin || child.stdin.destroyed) {
      return;
    }
    try {
      child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    } catch {
      // The exit handler reports a broken pipe on the next request.
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) {
        continue;
      }

      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        // A malformed line is not actionable; keep reading.
        continue;
      }

      // Notifications have no id and are intentionally ignored.
      if (typeof message.id !== 'number') {
        continue;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        const detail =
          typeof message.error.message === 'string'
            ? message.error.message
            : 'Unknown error';
        pending.reject(
          new CodexAppServerError(
            `Codex app-server ${pending.method} failed: ${detail}`,
            message.error.code,
            message.error.data
          )
        );
      } else {
        pending.resolve(message.result);
      }
      this.scheduleIdleShutdown();
    }
  }

  private handleExit(child: ChildProcess, error: Error): void {
    // A process we already stopped (idle shutdown, dispose, restart) may emit
    // exit after a replacement has started. Ignore the stale event.
    if (this.child !== child) {
      return;
    }

    this.child = undefined;
    this._serverInfo = undefined;
    this.clearIdleTimer();
    this.stdoutBuffer = '';
    this.rejectPending(error);

    if (!this.stopping && !this.disposed) {
      console.error(`[CodexAppServer] ${error.message}`);
    }
    this.stopping = false;
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer();
    if (this.idleTimeoutMs <= 0 || this.pending.size > 0) {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.stopChild();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private stopChild(): void {
    this.clearIdleTimer();
    const child = this.child;
    if (!child) {
      return;
    }

    this.stopping = true;
    this.child = undefined;
    this._serverInfo = undefined;
    this.rejectPending(
      new CodexAppServerError('Codex app-server was stopped')
    );

    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  private rejectPending(error: Error): void {
    const pending = Array.from(this.pending.values());
    this.pending.clear();
    for (const request of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private stderrDetail(): string {
    const detail = this.stderrTail.trim();
    return detail ? `: ${detail}` : '';
  }

  dispose(): void {
    this.disposed = true;
    this.stopChild();
  }
}
