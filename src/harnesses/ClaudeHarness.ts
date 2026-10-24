import {
  ClaudeSession,
  ClaudeSessionService,
} from '../services/ClaudeSessionService';
import { ClaudeAgentsService } from '../services/ClaudeAgentsService';
import { ClaudeTurnReading } from '../services/ClaudeTurnState';
import { generateId } from '../types';
import {
  ForkResult,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessLiveState,
  HarnessSession,
  LaunchOptions,
  PreviewMessage,
  SessionMetadata,
} from './types';
import { commandExists, getHarnessCommand, quoteShellArgument } from './commandUtils';
import { harnessTreeIcons } from './treeIcons';

export interface ClaudeHarnessOptions {
  sessionService?: ClaudeSessionService;
  agentsService?: ClaudeAgentsService;
}

/**
 * Claude Code adapter. Wraps the JSONL-based session service so the rest of
 * the extension can treat Claude and opencode uniformly.
 */
export class ClaudeHarness implements HarnessAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly icon = 'sparkle';
  readonly treeIcons = harnessTreeIcons('claude');
  readonly capabilities: HarnessCapabilities = {
    fork: true,
    move: false,
    newSessionId: true,
    preview: 'inline',
  };

  private readonly sessionService: ClaudeSessionService;
  private readonly agentsService: ClaudeAgentsService;

  constructor(options: ClaudeHarnessOptions = {}) {
    this.sessionService =
      options.sessionService ?? new ClaudeSessionService();
    this.agentsService =
      options.agentsService ??
      new ClaudeAgentsService({ command: () => this.command });
  }

  get command(): string {
    return getHarnessCommand('claude', 'claude');
  }

  async isInstalled(): Promise<boolean> {
    if (this.sessionService.isClaudeInstalled()) {
      return true;
    }
    return commandExists(this.command);
  }

  buildLaunchCommand(options: LaunchOptions): string {
    const command = quoteShellArgument(this.command);

    if (options.forkFromSessionId) {
      if (!options.newSessionId) {
        throw new Error(
          'Claude Code forks require a chosen new session ID'
        );
      }
      return `${command} --resume ${quoteShellArgument(
        options.forkFromSessionId
      )} --fork-session --session-id ${quoteShellArgument(
        options.newSessionId
      )}`;
    }
    if (options.sessionId) {
      return `${command} --resume ${quoteShellArgument(options.sessionId)}`;
    }
    if (options.newSessionId) {
      return `${command} --session-id ${quoteShellArgument(
        options.newSessionId
      )}`;
    }
    return command;
  }

  async isSessionResumable(sessionId: string): Promise<boolean> {
    return this.sessionService.isSessionResumable(sessionId);
  }
  async listSessionsForWorktree(worktreePath: string): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.findSessionsForWorktree(worktreePath);
    return sessions.map((session) => this.toHarnessSession(session));
  }

  async listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.findSessionsForRepository(
      repoRootPath,
      worktreePaths
    );
    return sessions.map((session) => this.toHarnessSession(session));
  }

  async getSessionMetadata(
    sessionId: string,
    _cwd?: string
  ): Promise<SessionMetadata | null> {
    const session = await this.sessionService.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      lastActivity: session.lastPromptAt ?? session.lastUpdated?.getTime() ?? null,
      preview: session.recentUserPrompts,
      lastAsk: session.lastAsk,
      lastReply: session.lastReply,
    };
  }

  async getLiveStates(
    sessionIds: string[]
  ): Promise<Map<string, HarnessLiveState>> {
    const states = new Map<string, HarnessLiveState>();
    if (sessionIds.length === 0) {
      return states;
    }

    // Start the independent transcript reads immediately; the shared agents
    // call may have to spawn the CLI and must not delay them.
    const agentsPromise = this.agentsService.getStates();
    const readings = await Promise.all(
      sessionIds.map(async (sessionId): Promise<
        [string, ClaudeTurnReading] | null
      > => {
        // The negative cache stops a session whose transcript has not appeared
        // from rescanning every project dir on each attention tick.
        const filePath = this.sessionService.getSessionFilePath(
          sessionId,
          30_000
        );
        if (!filePath) {
          return null;
        }
        const reading = await this.sessionService.readTurnState(filePath);
        return reading ? [sessionId, reading] : null;
      })
    );

    const agents = await agentsPromise;
    for (const entry of readings) {
      if (!entry) {
        continue;
      }
      const [sessionId, reading] = entry;
      states.set(sessionId, {
        ...reading,
        waitingFor: agents.get(sessionId)?.waitingFor,
      });
    }

    return states;
  }

  async getPreview(sessionId: string, maxMessages = 3): Promise<PreviewMessage[]> {
    return this.sessionService.getSessionPreview(sessionId, maxMessages);
  }

  async forkSession(sessionId: string, _cwd?: string): Promise<ForkResult> {
    await this.requireSourceSession(sessionId);
    // Claude forks in the terminal (--fork-session) under an ID we choose.
    return { kind: 'terminal', pendingSessionId: generateId() };
  }

  async moveSession(_sessionId: string, _directory: string): Promise<void> {
    throw new Error('Claude Code does not support moving sessions between directories');
  }

  async prepareForkToNewWorktree(
    sessionId: string,
    _sourceWorktreePath: string,
    _destinationWorktreePath: string
  ): Promise<ForkResult> {
    await this.requireSourceSession(sessionId);
    // The fork transcript is created in the destination cwd on the first
    // prompt; there are no files to copy.
    return { kind: 'terminal', pendingSessionId: generateId() };
  }

  /** A fork that cannot resume its source can only produce a broken launch. */
  private async requireSourceSession(sessionId: string): Promise<void> {
    if (!(await this.sessionService.isSessionResumable(sessionId))) {
      throw new Error('The source Claude session no longer exists');
    }
  }

  private toHarnessSession(session: ClaudeSession): HarnessSession {
    return {
      harness: 'claude',
      sessionId: session.sessionId,
      cwd: session.cwd,
      summary: session.summary,
      gitBranch: null,
      lastUpdated: session.lastUpdated,
      lastActivity: session.lastPromptAt ?? session.lastUpdated?.getTime() ?? null,
      messageCount: 0,
      turnState: session.turnState,
      turnEndedAt: session.turnEndedAt,
    };
  }
}
