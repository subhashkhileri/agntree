import { ChatSession, HarnessId } from '../types';
import { HarnessIconState, HarnessSession } from './types';

/** Stable key for one native session of one harness. */
export function harnessSessionKey(harness: HarnessId, sessionId: string): string {
  return `${harness}:${sessionId}`;
}

/** Row icon variant for a chat: running wins, then closed, then session state. */
export function selectHarnessIconState(
  chat: ChatSession,
  isActive: boolean
): HarnessIconState {
  if (isActive) {
    return 'running';
  }
  if (chat.status === 'closed') {
    return 'closed';
  }
  return chat.harnessSessionId ? 'default' : 'new';
}

/** Display name for a session, falling back to its prefix plus a short ID. */
export function sessionDisplayName(
  session: HarnessSession,
  prefix = 'Session '
): string {
  return session.summary?.trim() || `${prefix}${session.sessionId.substring(0, 12)}`;
}
