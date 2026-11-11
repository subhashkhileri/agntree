import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatModel,
  OpencodeSessionInfo,
  OpencodeSessionService,
  toHarnessSession,
} from '../services/OpencodeSessionService';
import { OpencodeSessionSearch } from './opencodeSearch';
import {
  ForkResult,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  LaunchOptions,
  PreviewMessage,
  SessionMetadata,
  SessionSearchSource,
} from './types';
import { commandExists, getHarnessCommand, quoteShellArgument } from './commandUtils';
import { harnessTreeIcons } from './treeIcons';
import { isWithin } from '../utils/paths';
import { logOperation } from '../services/OperationLog';

/**
 * opencode: sessions are scoped to a project (a repository plus its
 * worktrees) and reached only through the `opencode` CLI and its v2 API,
 * never its SQLite database. Previews need an export, so they load lazily.
 */
export class OpencodeHarness implements HarnessAdapter {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly icon = 'code';
  readonly treeIcons = harnessTreeIcons('opencode');
  readonly capabilities: HarnessCapabilities = {
    newSessionId: false,
    preview: 'lazy',
  };
  readonly sessionSearch: SessionSearchSource;

  private readonly sessionService = new OpencodeSessionService();

  constructor() {
    this.sessionSearch = new OpencodeSessionSearch(this.sessionService);
  }

  get command(): string {
    return getHarnessCommand('opencode', 'opencode');
  }

  async isInstalled(): Promise<boolean> {
    if (await commandExists(this.command)) {
      return true;
    }

    const dataDir =
      process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
    const configDir =
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');

    return (
      fs.existsSync(path.join(dataDir, 'opencode')) ||
      fs.existsSync(path.join(configDir, 'opencode'))
    );
  }

  buildLaunchCommand(options: LaunchOptions): string {
    const command = quoteShellArgument(this.command);
    // The TUI has no --fork flag; opencode forks are created through the API
    // (forkSession) and the new session ID is resumed instead.
    const sessionId = options.forkFromSessionId ?? options.sessionId;
    return sessionId ? `${command} --session ${quoteShellArgument(sessionId)}` : command;
  }

  async isSessionResumable(sessionId: string, cwd?: string): Promise<boolean> {
    return (await this.sessionService.getSession(sessionId, cwd)) !== null;
  }

  private isVisibleSession(session: OpencodeSessionInfo): boolean {
    return !session.parentID && !session.time?.archived;
  }

  async listSessionsForWorktree(
    worktreePath: string,
    force = false
  ): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.listSessions(worktreePath, { force });
    return sessions
      .filter(
        (session) =>
          this.isVisibleSession(session) &&
          isWithin(session.location.directory, worktreePath)
      )
      .map(toHarnessSession);
  }

  async listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.listSessions(repoRootPath);
    const roots = [repoRootPath, ...worktreePaths];

    return sessions
      .filter(
        (session) =>
          this.isVisibleSession(session) &&
          roots.some((root) => isWithin(session.location.directory, root))
      )
      .map(toHarnessSession);
  }

  async getSessionMetadata(
    sessionId: string,
    cwd?: string
  ): Promise<SessionMetadata | null> {
    const session =
      this.sessionService.getCachedSession(sessionId) ??
      (await this.sessionService.getSession(sessionId, cwd));
    if (!session) {
      return null;
    }

    // Previews require an export, so only use one that is already cached; the
    // tree triggers the export itself and refreshes when it lands.
    const preview = this.sessionService.getCachedPreview(sessionId);
    const previewMessages = preview?.messages ?? [];

    return {
      lastActivity: session.time?.updated ?? null,
      preview: previewMessages,
      lastAsk: previewMessages.length
        ? previewMessages[previewMessages.length - 1]
        : null,
      lastReply: preview?.lastAssistant ?? null,
      messageCount: preview?.messageCount,
      model: formatModel(session),
      agent: session.agent,
    };
  }

  async getPreview(sessionId: string, maxMessages = 3): Promise<PreviewMessage[]> {
    const preview = await this.sessionService.getPreview(sessionId, maxMessages);
    return preview.messages;
  }

  async forkSession(sessionId: string, cwd?: string): Promise<ForkResult> {
    return {
      kind: 'linked',
      sessionId: await this.sessionService.forkSession(sessionId, cwd),
    };
  }

  /** Fork in the source, then move the copy; a failed move deletes the orphan. */
  async prepareForkToNewWorktree(
    sessionId: string,
    sourceWorktreePath: string,
    destinationWorktreePath: string
  ): Promise<ForkResult> {
    const newSessionId = await this.sessionService.forkSession(sessionId, sourceWorktreePath);
    try {
      await this.sessionService.moveSession(newSessionId, destinationWorktreePath, sourceWorktreePath);
    } catch (error) {
      try {
        await this.sessionService.deleteSession(newSessionId, sourceWorktreePath);
        logOperation(`Deleted orphan opencode fork ${newSessionId} after a failed move`);
      } catch (deleteError) {
        // Best effort; the move error is the useful one.
        logOperation(`Could not delete orphan opencode fork ${newSessionId}: ${String(deleteError)}`);
      }
      throw error;
    }
    return { kind: 'linked', sessionId: newSessionId };
  }

}
