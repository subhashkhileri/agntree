import { ChatSession, HarnessId } from '../types';
import {
  HarnessIconState,
  HarnessSession,
  PreviewMessage,
  SessionMetadata,
  TurnState,
} from './types';
import { formatCost, formatTokenCount } from '../utils/text';

/** Stable key for one native session of one harness. */
export function harnessSessionKey(harness: HarnessId, sessionId: string): string {
  return `${harness}:${sessionId}`;
}

/**
 * Row icon variant for a chat. A session whose terminal is not open is closed,
 * whatever `status` says: status is only updated when a terminal close event is
 * observed, so sessions left behind by a window restart stay `idle`/`active`.
 *
 * An open terminal shows the animated mark while the harness reports a turn in
 * flight, and the green dot otherwise. Unknown turn state keeps the dot so a
 * freshly opened terminal does not flash the animation before the first poll.
 */
export function selectHarnessIconState(
  chat: ChatSession,
  isActive: boolean,
  turnState?: TurnState
): HarnessIconState {
  if (!isActive) {
    return chat.harnessSessionId ? 'closed' : 'new';
  }
  return turnState === 'working' ? 'working' : 'done';
}

/** Display name for a session, falling back to its prefix plus a short ID. */
export function sessionDisplayName(
  session: HarnessSession,
  prefix = 'Session '
): string {
  return session.summary?.trim() || `${prefix}${session.sessionId.substring(0, 12)}`;
}

/**
 * The last user/assistant exchange for a brief. A reply older than the last
 * ask means the agent has not answered yet; showing it would misrepresent
 * where the session stopped.
 */
export function lastExchange(
  meta: SessionMetadata | null,
  preview?: PreviewMessage[]
): {
  lastAsk: PreviewMessage | null;
  lastReply: PreviewMessage | null;
} {
  const pool = preview ?? meta?.preview ?? [];
  const lastAsk =
    meta?.lastAsk ?? (pool.length ? pool[pool.length - 1] : null) ?? null;
  const lastReply =
    meta?.lastReply &&
    (!lastAsk?.timestamp ||
      !meta.lastReply.timestamp ||
      meta.lastReply.timestamp >= lastAsk.timestamp)
      ? meta.lastReply
      : null;
  return { lastAsk, lastReply };
}

/**
 * Compact usage footer shared by the tree tooltip and the search picker:
 * "12 messages · model · agent · 1.2k in / 3.4k out · $0.12".
 */
export function sessionUsageLine(
  meta: SessionMetadata | null,
  fallback?: HarnessSession
): string | undefined {
  const parts: string[] = [];

  const messageCount = meta?.messageCount ?? fallback?.messageCount;
  if (messageCount && messageCount > 0) {
    parts.push(`${messageCount} message${messageCount === 1 ? '' : 's'}`);
  }
  const model = meta?.model ?? fallback?.model;
  if (model) {
    parts.push(model);
  }
  const agent = meta?.agent ?? fallback?.agent;
  if (agent) {
    parts.push(agent);
  }
  const tokens = meta?.tokens ?? fallback?.tokens;
  if (tokens && (tokens.input > 0 || tokens.output > 0)) {
    parts.push(
      `${formatTokenCount(tokens.input)} in / ${formatTokenCount(tokens.output)} out`
    );
  }
  const cost = typeof meta?.cost === 'number' ? meta.cost : fallback?.cost;
  if (typeof cost === 'number' && cost > 0) {
    parts.push(formatCost(cost));
  }

  return parts.length > 0 ? parts.join(' · ') : undefined;
}
