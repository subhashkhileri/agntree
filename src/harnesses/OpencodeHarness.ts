import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  OpencodeSessionInfo,
  OpencodeSessionService,
} from '../services/OpencodeSessionService';
import {
  ForkResult,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  LaunchOptions,
  PreviewMessage,
  SessionMetadata,
} from './types';
import { commandExists, getHarnessCommand, quoteShellCommand } from './commandUtils';
import { harnessTreeIcons } from './treeIcons';
import { isWithin } from '../utils/paths';
import { logOperation } from '../services/OperationLog';

/**
 * opencode v2 adapter.
 *
 * Sessions live in opencode's own database and are scoped to a project (a git
 * repo plus all of its worktrees). We discover/act on them through the
 * `opencode` CLI and its v2 API rather than reading the SQLite file.
 */
export class OpencodeHarness implements HarnessAdapter {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly icon = 'code';
  readonly treeIcons = harnessTreeIcons('opencode');
  readonly capabilities: HarnessCapabilities = {
    fork: true,
    move: true,
    recap: false,
    preview: 'lazy',
  };

  private readonly sessionService = new OpencodeSessionService();

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
    const command = quoteShellCommand(this.command);
    // The TUI has no --fork flag; opencode forks are created through the API
    // (forkSession) and the new session ID is resumed instead.
    const sessionId = options.forkFromSessionId ?? options.sessionId;
    return sessionId ? `${command} --session ${sessionId}` : command;
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
      .map((session) => this.toHarnessSession(session));
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
      .map((session) => this.toHarnessSession(session));
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
      recap: null,
      preview: previewMessages,
      lastAsk: previewMessages.length
        ? previewMessages[previewMessages.length - 1]
        : null,
      lastReply: preview?.lastAssistant ?? null,
      messageCount: preview?.messageCount,
      model: formatModel(session),
      agent: session.agent,
      cost: session.cost,
      tokens: mapTokens(session),
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

  async moveSession(
    sessionId: string,
    directory: string,
    cwd?: string
  ): Promise<void> {
    await this.sessionService.moveSession(sessionId, directory, cwd);
  }

  async prepareForkToNewWorktree(
    sessionId: string,
    sourceWorktreePath: string,
    destinationWorktreePath: string
  ): Promise<ForkResult> {
    const newSessionId = await this.sessionService.forkSession(
      sessionId,
      sourceWorktreePath
    );

    try {
      await this.moveSession(
        newSessionId,
        destinationWorktreePath,
        sourceWorktreePath
      );
    } catch (error) {
      // Don't leave an orphan fork behind in the source worktree.
      try {
        await this.sessionService.deleteSession(
          newSessionId,
          sourceWorktreePath
        );
        logOperation(
          `Deleted orphan opencode fork ${newSessionId} after a failed move`
        );
      } catch (deleteError) {
        // Best effort only; the original error is the useful one.
        logOperation(
          `Could not delete orphan opencode fork ${newSessionId}: ${String(deleteError)}`
        );
      }
      throw error;
    }

    return { kind: 'linked', sessionId: newSessionId };
  }

  private toHarnessSession(session: OpencodeSessionInfo): HarnessSession {
    const updated = session.time?.updated ?? null;

    return {
      harness: 'opencode',
      sessionId: session.id,
      cwd: session.location.directory,
      summary: session.title?.trim() || null,
      recap: null,
      gitBranch: null,
      lastUpdated: updated ? new Date(updated) : null,
      lastActivity: updated,
      messageCount: 0,
      model: formatModel(session),
      agent: session.agent,
      cost: session.cost,
      tokens: mapTokens(session),
    };
  }
}

function formatModel(session: OpencodeSessionInfo): string | undefined {
  if (!session.model) {
    return undefined;
  }
  const base = `${session.model.providerID}/${session.model.id}`;
  return session.model.variant ? `${base}#${session.model.variant}` : base;
}

function mapTokens(session: OpencodeSessionInfo): HarnessSession['tokens'] {
  if (!session.tokens) {
    return undefined;
  }
  return {
    input: session.tokens.input ?? 0,
    output: session.tokens.output ?? 0,
    reasoning: session.tokens.reasoning ?? 0,
    cacheRead: session.tokens.cache?.read ?? 0,
    cacheWrite: session.tokens.cache?.write ?? 0,
  };
}
