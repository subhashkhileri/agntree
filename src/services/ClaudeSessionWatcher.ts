import { StorageService } from './StorageService';
import { ClaudeSessionService } from './ClaudeSessionService';
import {
  ExactIdSessionSource,
  ExactIdSessionWatcher,
} from './ExactIdSessionWatcher';

/**
 * Links a chat's chosen pending session ID to the transcript Claude writes on
 * the first prompt.
 *
 * Claude has no session-created event, so the transcript's first appearance is
 * the link signal. The ID in the filename is authoritative: there is no
 * directory matching and no catalog of existing sessions.
 */
export class ClaudeSessionWatcher extends ExactIdSessionWatcher {
  constructor(
    storageService: StorageService,
    sessionService: ClaudeSessionService
  ) {
    super('claude', storageService, claudeSource(sessionService));
  }
}

function claudeSource(
  sessionService: ClaudeSessionService
): ExactIdSessionSource {
  return {
    watchRoots: () => [sessionService.getProjectsDirectory()],
    watchDirs: () => sessionService.getProjectDirs(),
    sessionIdForFile: (filename) =>
      filename.endsWith('.jsonl') && !filename.startsWith('agent-')
        ? filename.slice(0, -'.jsonl'.length)
        : null,
    isResumable: (sessionId) => sessionService.isSessionResumable(sessionId),
    getSummary: async (sessionId) =>
      (await sessionService.getSessionById(sessionId))?.summary ?? null,
  };
}
