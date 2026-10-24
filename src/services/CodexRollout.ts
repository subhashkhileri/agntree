import * as fs from 'fs';
import { HarnessSession, TurnState } from '../harnesses/types';

/**
 * Minimal rollout reader for live turn state and token usage.
 *
 * The app-server is not the executor for `codex` processes started by
 * Agntree, so `thread/list` always reports `notLoaded` for them. The rollout
 * file is the only live signal: `task_started` / `task_complete` /
 * `turn_aborted` bracket a turn, and `token_count` carries cumulative usage.
 *
 * Files are parsed incrementally: the cache tracks the byte offset of the last
 * complete line, so a 4s poll only reads what the TUI appended since the last
 * poll. A full scan happens once per session.
 */
export interface CodexRolloutState {
  turnState?: TurnState;
  turnEndedAt: number | null;
  tokens?: HarnessSession['tokens'];
  /** User + agent messages completed so far. */
  messageCount: number;
}

interface RolloutCacheEntry {
  offset: number;
  mtimeMs: number;
  pending: Buffer;
  state: CodexRolloutState;
  usedAt: number;
}

const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_PARTIAL_LINE_BYTES = 4 * 1024 * 1024;
const CACHE_LIMIT = 100;

export class CodexRolloutService {
  private readonly cache = new Map<string, RolloutCacheEntry>();
  private readonly inFlight = new Map<
    string,
    Promise<CodexRolloutState | null>
  >();

  /**
   * Read the rollout, parsing only bytes appended since the previous call.
   * Returns null when the file is missing or compressed (`.zst`).
   *
   * Reads for the same path share one in-flight request so concurrent tree
   * renders cannot parse the same bytes twice.
   */
  read(rolloutPath: string | null | undefined): Promise<CodexRolloutState | null> {
    if (!rolloutPath || rolloutPath.endsWith('.zst')) {
      return Promise.resolve(null);
    }

    const existing = this.inFlight.get(rolloutPath);
    if (existing) {
      return existing;
    }

    const request = this.readUncached(rolloutPath).finally(() => {
      this.inFlight.delete(rolloutPath);
    });
    this.inFlight.set(rolloutPath, request);
    return request;
  }

  private async readUncached(
    rolloutPath: string
  ): Promise<CodexRolloutState | null> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(rolloutPath);
    } catch {
      this.cache.delete(rolloutPath);
      return null;
    }

    let entry = this.cache.get(rolloutPath);
    if (
      entry &&
      entry.offset === stats.size &&
      entry.mtimeMs === stats.mtimeMs
    ) {
      entry.usedAt = Date.now();
      return entry.state;
    }

    if (!entry || entry.offset > stats.size) {
      entry = {
        offset: 0,
        mtimeMs: 0,
        pending: Buffer.alloc(0),
        state: {
          turnState: undefined,
          turnEndedAt: null,
          tokens: undefined,
          messageCount: 0,
        },
        usedAt: Date.now(),
      };
      this.cache.set(rolloutPath, entry);
    }

    try {
      await this.readAppended(rolloutPath, stats.size, entry);
    } catch {
      this.cache.delete(rolloutPath);
      return null;
    }

    entry.mtimeMs = stats.mtimeMs;
    entry.usedAt = Date.now();
    this.evict();
    return entry.state;
  }

  private async readAppended(
    rolloutPath: string,
    size: number,
    entry: RolloutCacheEntry
  ): Promise<void> {
    if (entry.offset >= size) {
      return;
    }

    const handle = await fs.promises.open(rolloutPath, 'r');
    try {
      // One reusable read buffer; only an unterminated tail is copied, so a
      // large scan does not retain every chunk through `subarray`.
      const buffer = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, size - entry.offset)
      );
      let position = entry.offset;
      let pending = entry.pending;

      while (position < size) {
        const length = Math.min(buffer.length, size - position);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        if (bytesRead <= 0) {
          break;
        }
        position += bytesRead;

        let chunk = buffer.subarray(0, bytesRead);
        if (pending.length > 0) {
          chunk = Buffer.concat([pending, chunk]);
        }

        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline >= 0) {
          const complete = chunk
            .subarray(0, lastNewline + 1)
            .toString('utf8');
          this.parseLines(complete, entry.state);
          const tail = chunk.subarray(lastNewline + 1);
          pending = tail.length > 0 ? Buffer.from(tail) : Buffer.alloc(0);
        } else {
          pending = chunk.length > 0 ? Buffer.from(chunk) : Buffer.alloc(0);
        }

        // A single pathological line should not pin memory forever.
        if (pending.length > MAX_PARTIAL_LINE_BYTES) {
          pending = Buffer.alloc(0);
        }
      }

      entry.offset = position;
      entry.pending = pending;
    } finally {
      await handle.close();
    }
  }

  private parseLines(text: string, state: CodexRolloutState): void {
    for (const line of text.split('\n')) {
      if (!line.trim()) {
        continue;
      }

      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (entry.type === 'event_msg') {
        const payload = entry.payload as Record<string, unknown> | undefined;
        if (!payload || typeof payload.type !== 'string') {
          continue;
        }
        this.applyEvent(payload, state);
      }
    }
  }

  private applyEvent(
    payload: Record<string, unknown>,
    state: CodexRolloutState
  ): void {
    switch (payload.type) {
      case 'task_started':
        state.turnState = 'working';
        state.turnEndedAt = null;
        return;
      case 'task_complete':
      case 'turn_aborted':
        state.turnState = 'done';
        state.turnEndedAt = toEpochMs(payload.completed_at) ?? Date.now();
        return;
      case 'token_count': {
        const info = payload.info as Record<string, unknown> | undefined;
        const total = info?.total_token_usage as
          | Record<string, unknown>
          | undefined;
        if (!total) {
          return;
        }
        state.tokens = {
          input: toNumber(total.input_tokens),
          output: toNumber(total.output_tokens),
          reasoning: toNumber(total.reasoning_output_tokens),
          cacheRead: toNumber(total.cached_input_tokens),
          cacheWrite: toNumber(total.cache_write_input_tokens),
        };
        return;
      }
      case 'item_completed': {
        const item = payload.item as Record<string, unknown> | undefined;
        if (item?.type === 'UserMessage' || item?.type === 'AgentMessage') {
          state.messageCount++;
        }
        return;
      }
      default:
        return;
    }
  }

  private evict(): void {
    if (this.cache.size <= CACHE_LIMIT) {
      return;
    }
    const oldest = Array.from(this.cache.entries()).sort(
      (a, b) => a[1].usedAt - b[1].usedAt
    );
    for (let i = 0; i < oldest.length - CACHE_LIMIT; i++) {
      this.cache.delete(oldest[i][0]);
    }
  }
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Rollout timestamps are Unix seconds; tolerate milliseconds too. */
function toEpochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value < 1e12 ? value * 1000 : value;
}
