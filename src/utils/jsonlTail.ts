import * as fs from 'fs';

/** What one pass over a tail window decided. */
export interface JsonlTailScan<T> {
  value: T;
  /** True once the window holds everything needed to decide. */
  decided: boolean;
}

/** The first window; it covers a typical turn's trailing entries. */
const INITIAL_WINDOW_BYTES = 16 * 1024;

async function readWindow(
  filePath: string,
  start: number,
  length: number
): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Read only the tail of an append-only JSONL file, growing the window 4× until
 * `scan` decides or the window reaches the start of the file.
 *
 * The first line of a later window is a fragment of an entry that begins
 * before it, so it is dropped. A trailing line without its newline is a write
 * in progress, so it is dropped too; the previous complete entry is the latest
 * fact we can rely on. Returns null when the file cannot be read.
 */
export async function readJsonlTail<T>(
  filePath: string,
  scan: (text: string) => JsonlTailScan<T>
): Promise<T | null> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  let windowBytes = INITIAL_WINDOW_BYTES;
  for (;;) {
    const start = Math.max(0, stats.size - windowBytes);
    let text: string;
    try {
      text = await readWindow(filePath, start, stats.size - start);
    } catch {
      return null;
    }

    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    if (!text.endsWith('\n')) {
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    }

    const result = scan(text);
    if (result.decided || start === 0) {
      return result.value;
    }

    windowBytes *= 4;
  }
}
