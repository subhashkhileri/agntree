import * as fs from 'fs';
import { TurnState } from '../harnesses/types';

/** The last conversational entry in a transcript. */
export interface ClaudeConversationEntry {
  type: string;
  stopReason: string | null;
  timestamp: number | null;
}

/** The two transcript facts that decide whether a Claude turn is over. */
export interface ClaudeTurnSignals {
  lastConversation: ClaudeConversationEntry | null;
  /** `turn_duration.pendingBackgroundAgentCount`; null when absent. */
  pendingBackgroundAgents: number | null;
}

export interface ClaudeTurnReading {
  turnState: TurnState;
  turnEndedAt: number | null;
}

interface ClaudeTranscriptEntry {
  type?: unknown;
  subtype?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  pendingBackgroundAgentCount?: unknown;
  message?: { stop_reason?: unknown };
}

/**
 * Fold one decoded transcript entry into the turn signals. The tail reader and
 * the full parser share this so both read `stop_reason`, sidechains, and
 * `turn_duration` the same way.
 */
export function observeClaudeTurnEntry(
  entry: unknown,
  signals: ClaudeTurnSignals
): void {
  if (!entry || typeof entry !== 'object') {
    return;
  }
  const record = entry as ClaudeTranscriptEntry;

  // Claude writes this at every turn end and omits the count when nothing is
  // pending, so a missing field means zero.
  if (record.type === 'system' && record.subtype === 'turn_duration') {
    signals.pendingBackgroundAgents =
      typeof record.pendingBackgroundAgentCount === 'number'
        ? record.pendingBackgroundAgentCount
        : 0;
  }

  if (
    (record.type === 'user' || record.type === 'assistant') &&
    !record.isSidechain
  ) {
    const stopReason = record.message?.stop_reason;
    const timestamp = record.timestamp
      ? new Date(record.timestamp as string | number).getTime()
      : NaN;
    signals.lastConversation = {
      type: record.type,
      stopReason: typeof stopReason === 'string' ? stopReason : null,
      timestamp: Number.isNaN(timestamp) ? null : timestamp,
    };
  }
}

/** The first tail window; it covers a typical turn's trailing entries. */
const INITIAL_WINDOW_BYTES = 16 * 1024;

/**
 * Turn state from the transcript's deciding entries. A user entry (including
 * a tool result) or a still-streaming/tool-using assistant entry means the
 * turn is open. A terminal assistant entry means done unless a background
 * agent is still pending.
 */
export function deriveClaudeTurnState(
  signals: ClaudeTurnSignals
): ClaudeTurnReading {
  const pending = signals.pendingBackgroundAgents ?? 0;
  const last = signals.lastConversation;
  if (
    pending <= 0 &&
    last?.type === 'assistant' &&
    last.stopReason &&
    last.stopReason !== 'tool_use'
  ) {
    return { turnState: 'done', turnEndedAt: last.timestamp };
  }
  return { turnState: 'working', turnEndedAt: null };
}

interface WindowScan {
  reading: ClaudeTurnReading;
  /** True once the window contains everything needed to decide the state. */
  decided: boolean;
}

function scanText(text: string): WindowScan {
  const signals: ClaudeTurnSignals = {
    lastConversation: null,
    pendingBackgroundAgents: null,
  };

  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // An incomplete or corrupt line is not a fact.
      continue;
    }
    observeClaudeTurnEntry(entry, signals);
  }

  const lastConversation = signals.lastConversation;
  const terminalAssistant =
    lastConversation?.type === 'assistant' &&
    Boolean(lastConversation.stopReason) &&
    lastConversation.stopReason !== 'tool_use';

  return {
    reading: deriveClaudeTurnState(signals),
    decided:
      lastConversation !== null &&
      (!terminalAssistant || signals.pendingBackgroundAgents !== null),
  };
}

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
 * Read only the tail of a transcript, growing the window until the latest
 * conversation entry is complete and, for a finished assistant turn, a
 * `turn_duration` is visible. If the deciding entries are not found, the same
 * reader expands to the start of the file rather than falling back to a full
 * parse.
 *
 * Returns null when the file cannot be read; an empty or not-yet-conversational
 * transcript is `working`, matching the full parser's default.
 */
export async function readTurnStateTail(
  filePath: string
): Promise<ClaudeTurnReading | null> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    return null;
  }

  if (stats.size === 0) {
    return { turnState: 'working', turnEndedAt: null };
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
      // The first line is a fragment of an entry that begins before the
      // window; it cannot be trusted.
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    if (!text.endsWith('\n')) {
      // The file is being written; the previous complete entry is the latest
      // fact we can rely on.
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
    }

    const scan = scanText(text);
    if (scan.decided || start === 0) {
      return scan.reading;
    }

    windowBytes *= 4;
  }
}
