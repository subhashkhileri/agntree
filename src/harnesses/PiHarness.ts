import {
  PiSessionService,
  toHarnessSession,
} from '../services/PiSessionService';
import { generateId } from '../types';
import { PiSearchRunner, PiSessionSearch } from './piSearch';
import {
  ForkResult,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessLiveState,
  HarnessSession,
  LaunchOptions,
  PreviewMessage,
  SessionMetadata,
  SessionSearchRunner,
  SessionSearchSource,
} from './types';
import {
  commandExists,
  getHarnessCommand,
  quoteShellArgument,
} from './commandUtils';
import { harnessTreeIcons } from './treeIcons';

export interface PiHarnessOptions {
  sessionService?: PiSessionService;
}

/**
 * Pi (the `pi` coding-agent CLI): sessions are append-only JSONL records in
 * `~/.pi/agent/sessions/`, one directory per working directory. New chats
 * choose their ID up front with `--session-id`, forks choose the new ID with
 * `--fork … --session-id …`, and live turn state comes from the record tail.
 */
export class PiHarness implements HarnessAdapter {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi';
  readonly icon = 'terminal';
  readonly treeIcons = harnessTreeIcons('pi');
  readonly capabilities: HarnessCapabilities = {
    newSessionId: true,
    preview: 'inline',
  };
  readonly sessionSearch: SessionSearchSource;
  readonly sessionSearchRunner: SessionSearchRunner;

  private readonly sessionService: PiSessionService;

  constructor(options: PiHarnessOptions = {}) {
    this.sessionService =
      options.sessionService ?? new PiSessionService();
    this.sessionSearch = new PiSessionSearch(this.sessionService);
    this.sessionSearchRunner = new PiSearchRunner({
      command: () => this.command,
    });
  }

  get command(): string {
    return getHarnessCommand('pi', 'pi');
  }

  async isInstalled(): Promise<boolean> {
    if (this.sessionService.isPiInstalled()) {
      return true;
    }
    return commandExists(this.command);
  }

  buildLaunchCommand(options: LaunchOptions): string {
    const command = quoteShellArgument(this.command);

    if (options.forkFromSessionId) {
      if (!options.newSessionId) {
        throw new Error('Pi forks require a chosen new session ID');
      }
      return `${command} --fork ${quoteShellArgument(
        options.forkFromSessionId
      )} --session-id ${quoteShellArgument(options.newSessionId)}`;
    }
    if (options.sessionId) {
      // `--session-id` would silently create a new session when the ID is
      // missing; `--session` fails instead. Pass the record path when it is
      // known: Pi resolves a bare ID only against the process cwd's project,
      // so a session started in a subdirectory looks like a session from
      // another project and Pi offers to fork instead of resuming. A path is
      // opened in the cwd recorded in its header.
      const target =
        this.sessionService.getSessionFilePath(
          options.sessionId,
          options.worktreePath
        ) ?? options.sessionId;
      return `${command} --session ${quoteShellArgument(target)}`;
    }
    if (options.newSessionId) {
      return `${command} --session-id ${quoteShellArgument(
        options.newSessionId
      )}`;
    }
    return command;
  }

  async isSessionResumable(
    sessionId: string,
    cwd?: string
  ): Promise<boolean> {
    return this.sessionService.isSessionResumable(sessionId, cwd);
  }

  async listSessionsForWorktree(
    worktreePath: string,
    force = false
  ): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.listSessionsForWorktree(
      worktreePath,
      force
    );
    return sessions.map(toHarnessSession);
  }

  async listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]> {
    const sessions = await this.sessionService.listSessionsForRepository(
      repoRootPath,
      worktreePaths
    );
    return sessions.map(toHarnessSession);
  }

  async getLiveStates(
    sessionIds: string[],
    cwd?: string
  ): Promise<Map<string, HarnessLiveState>> {
    const states = new Map<string, HarnessLiveState>();
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        // The negative cache stops a record that has not appeared yet from
        // rescanning every session directory on each attention tick.
        const filePath = this.sessionService.getSessionFilePath(
          sessionId,
          cwd,
          30_000
        );
        const reading = filePath
          ? await this.sessionService.readTurnState(filePath)
          : null;
        if (reading) {
          states.set(sessionId, reading);
        }
      })
    );
    return states;
  }

  async getSessionMetadata(
    sessionId: string,
    cwd?: string
  ): Promise<SessionMetadata | null> {
    const session = await this.sessionService.getSessionById(
      sessionId,
      cwd
    );
    if (!session) {
      return null;
    }

    const prompts = session.recentUserPrompts;
    return {
      lastActivity: session.lastUpdated.getTime(),
      preview: prompts,
      lastAsk: prompts[prompts.length - 1] ?? null,
      lastReply: session.lastReply,
      messageCount: session.messageCount,
      model: session.model,
    };
  }

  async getPreview(
    sessionId: string,
    maxMessages = 3
  ): Promise<PreviewMessage[]> {
    const session = await this.sessionService.getSessionById(sessionId);
    if (!session || maxMessages <= 0) {
      return [];
    }
    return session.recentUserPrompts.slice(-maxMessages);
  }

  async forkSession(
    sessionId: string,
    cwd?: string
  ): Promise<ForkResult> {
    await this.requireSourceSession(sessionId, cwd);
    // Pi forks in the terminal with `--fork`; the watcher links the chosen ID.
    return { kind: 'terminal', pendingSessionId: generateId() };
  }

  async prepareForkToNewWorktree(
    sessionId: string,
    sourceWorktreePath: string,
    _destinationWorktreePath: string
  ): Promise<ForkResult> {
    await this.requireSourceSession(sessionId, sourceWorktreePath);
    // `--fork` writes the copy into the destination cwd on launch; there are
    // no files to move and no orphan to clean up.
    return { kind: 'terminal', pendingSessionId: generateId() };
  }

  /** A fork that cannot open its source can only produce a broken launch. */
  private async requireSourceSession(
    sessionId: string,
    cwd?: string
  ): Promise<void> {
    if (!(await this.isSessionResumable(sessionId, cwd))) {
      throw new Error('The source Pi session no longer exists');
    }
  }
}
