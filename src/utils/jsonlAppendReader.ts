import * as fs from 'fs';
import { BoundedCache } from './boundedCache';
import { parseJsonLine } from './jsonlTail';

/**
 * What a caller adds to `JsonlAppendReader`: a running state, how one decoded
 * entry folds into it, and the value callers receive.
 */
export interface JsonlFold<S, T> {
  /** A fresh state for a file read from its first byte. */
  initial(): S;
  /** Fold one decoded entry into the state, in file order. */
  apply(entry: unknown, state: S): void;
  /**
   * The value callers receive. It is computed once per read that found new
   * bytes and reused until the file changes, so it must not share mutable
   * parts with the state.
   */
  result(state: S, stats: fs.Stats): T;
  /**
   * Start over when the file's first line changes, for a writer that can
   * rewrite a file in place (for example, to migrate its format) as well as
   * append to it.
   */
  verifyFirstLine?: boolean;
}

interface ReaderEntry<S, T> {
  /** Bytes consumed, including an unterminated tail held in `pending`. */
  offset: number;
  mtimeMs: number;
  /** The unterminated last line, completed by a later append. */
  pending: Buffer;
  /** The first line's bytes, kept only when the fold verifies it. */
  firstLine: Buffer | null;
  state: S;
  result?: { value: T };
}

const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_PARTIAL_LINE_BYTES = 4 * 1024 * 1024;
const MAX_FIRST_LINE_BYTES = 64 * 1024;

/**
 * Reads append-only JSONL files incrementally: each file's state is kept with
 * the byte offset it has consumed, so a later read decodes only the bytes
 * appended since. A file that shrank, or whose first line changed when the
 * fold verifies it, is read again from the start.
 *
 * A trailing line without its newline is a write in progress; it is held and
 * folded once its newline arrives. Reads of one path share an in-flight
 * request, so concurrent callers cannot fold the same bytes twice. Entries are
 * evicted least recently used.
 */
export class JsonlAppendReader<S, T> {
  private readonly cache: BoundedCache<string, ReaderEntry<S, T>>;
  private readonly inFlight = new Map<string, Promise<T | null>>();

  constructor(
    private readonly fold: JsonlFold<S, T>,
    limit: number
  ) {
    this.cache = new BoundedCache(limit);
  }

  /** The fold's value for the file, or null when it cannot be read. */
  read(filePath: string): Promise<T | null> {
    const existing = this.inFlight.get(filePath);
    if (existing) {
      return existing;
    }
    const request = this.readUncached(filePath).finally(() => {
      this.inFlight.delete(filePath);
    });
    this.inFlight.set(filePath, request);
    return request;
  }

  private async readUncached(filePath: string): Promise<T | null> {
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      this.cache.delete(filePath);
      return null;
    }

    let entry = this.cache.get(filePath);
    if (
      entry?.result &&
      entry.offset === stats.size &&
      entry.mtimeMs === stats.mtimeMs
    ) {
      // Re-insert so eviction follows use, not the last change.
      this.cache.set(filePath, entry);
      return entry.result.value;
    }

    try {
      if (
        !entry ||
        entry.offset > stats.size ||
        !(await this.firstLineHolds(filePath, entry))
      ) {
        entry = {
          offset: 0,
          mtimeMs: 0,
          pending: Buffer.alloc(0),
          firstLine: null,
          state: this.fold.initial(),
        };
      }
      await this.readAppended(filePath, stats.size, entry);
    } catch {
      // The state may hold part of this read; start over next time.
      this.cache.delete(filePath);
      return null;
    }

    entry.mtimeMs = stats.mtimeMs;
    entry.result = { value: this.fold.result(entry.state, stats) };
    this.cache.set(filePath, entry);
    return entry.result.value;
  }

  /** Whether the file still begins with the first line already folded. */
  private async firstLineHolds(
    filePath: string,
    entry: ReaderEntry<S, T>
  ): Promise<boolean> {
    const expected = entry.firstLine;
    if (!expected) {
      return true;
    }
    const actual = Buffer.alloc(expected.length);
    const handle = await fs.promises.open(filePath, 'r');
    try {
      const { bytesRead } = await handle.read(actual, 0, actual.length, 0);
      return bytesRead === expected.length && actual.equals(expected);
    } finally {
      await handle.close();
    }
  }

  private async readAppended(
    filePath: string,
    size: number,
    entry: ReaderEntry<S, T>
  ): Promise<void> {
    if (entry.offset >= size) {
      return;
    }

    const handle = await fs.promises.open(filePath, 'r');
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
        // Where `chunk` begins in the file: the held tail comes first.
        const chunkStart = position - pending.length;
        position += bytesRead;

        let chunk = buffer.subarray(0, bytesRead);
        if (pending.length > 0) {
          chunk = Buffer.concat([pending, chunk]);
        }
        if (chunkStart === 0) {
          this.noteFirstLine(entry, chunk);
        }

        const lastNewline = chunk.lastIndexOf(0x0a);
        if (lastNewline >= 0) {
          let text = chunk.subarray(0, lastNewline + 1).toString('utf8');
          if (chunkStart === 0) {
            text = text.replace(/^﻿/, '');
          }
          for (const line of text.split('\n')) {
            const decoded = parseJsonLine(line);
            if (decoded !== undefined) {
              this.fold.apply(decoded, entry.state);
            }
          }
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

  /**
   * Keep the first line's bytes once they are complete, so a later read can
   * tell an in-place rewrite from an append. A first line longer than the cap
   * is fingerprinted by its first bytes.
   */
  private noteFirstLine(entry: ReaderEntry<S, T>, chunk: Buffer): void {
    if (!this.fold.verifyFirstLine || entry.firstLine) {
      return;
    }
    const newline = chunk.indexOf(0x0a);
    if (newline >= 0 && newline < MAX_FIRST_LINE_BYTES) {
      entry.firstLine = Buffer.from(chunk.subarray(0, newline + 1));
    } else if (chunk.length >= MAX_FIRST_LINE_BYTES) {
      entry.firstLine = Buffer.from(chunk.subarray(0, MAX_FIRST_LINE_BYTES));
    }
  }
}
