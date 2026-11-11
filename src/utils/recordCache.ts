import * as fs from 'fs';
import { BoundedCache } from './boundedCache';

/**
 * Values derived from append-only session files, reused while a file's mtime
 * and size hold. The tree and the attention tick read the same records every
 * few seconds; this keeps them from re-reading files that did not change.
 */
export class StatCache<T> {
  private readonly entries: BoundedCache<
    string,
    { mtimeMs: number; size: number; value: T }
  >;

  constructor(limit: number) {
    this.entries = new BoundedCache(limit);
  }

  /** The cached value, when it was derived from a file with these stats. */
  peek(filePath: string, stats: fs.Stats): { value: T } | undefined {
    const cached = this.entries.get(filePath);
    return cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size
      ? cached
      : undefined;
  }

  set(filePath: string, stats: fs.Stats, value: T): void {
    this.entries.set(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      value,
    });
  }

  /**
   * `compute` for a file, reused while its mtime and size are unchanged. Null
   * when the file is gone. With `cacheNull: false`, a null result is treated
   * as a transient failure and recomputed on the next call instead of pinned
   * until the file changes.
   */
  async get(
    filePath: string,
    compute: (stats: fs.Stats) => Promise<T> | T,
    { cacheNull = true }: { cacheNull?: boolean } = {}
  ): Promise<T | null> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return null;
    }
    const fresh = this.peek(filePath, stats);
    if (fresh) {
      return fresh.value;
    }
    const value = await compute(stats);
    if (value !== null || cacheNull) {
      this.set(filePath, stats, value);
    }
    return value;
  }
}

/**
 * Session ID to record path. A cached path is trusted while it is still a
 * file; otherwise the caller's scan runs. `missTtlMs` memoizes a miss, so a
 * caller polling for a record that does not exist yet does not rescan every
 * session directory on each pass.
 */
export class RecordPathCatalog {
  private readonly paths: BoundedCache<string, string>;
  private readonly misses: BoundedCache<string, number>;

  constructor(limit: number) {
    this.paths = new BoundedCache(limit);
    this.misses = new BoundedCache(limit);
  }

  find(
    sessionId: string,
    scan: () => string | null,
    missTtlMs = 0
  ): string | null {
    const cached = this.paths.get(sessionId);
    if (cached) {
      // The record was verified when it was cached; a stat is enough here,
      // because this lookup runs for every row on a tree render.
      try {
        if (fs.statSync(cached).isFile()) {
          return cached;
        }
      } catch {
        // Fall through and rescan.
      }
      this.paths.delete(sessionId);
    }

    const missedAt = this.misses.get(sessionId);
    if (
      missTtlMs > 0 &&
      missedAt !== undefined &&
      Date.now() - missedAt < missTtlMs
    ) {
      return null;
    }

    const found = scan();
    if (!found) {
      if (missTtlMs > 0) {
        this.misses.set(sessionId, Date.now());
      }
      return null;
    }
    this.misses.delete(sessionId);
    this.paths.set(sessionId, found);
    return found;
  }
}
