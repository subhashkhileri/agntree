import {
  ClaudeSession,
  ClaudeSessionService,
} from '../services/ClaudeSessionService';
import {
  ForkResult,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessSession,
  HeadlessAction,
  HeadlessCommand,
  LaunchOptions,
  PreviewMessage,
  SessionMetadata,
} from './types';
import { commandExists, getHarnessCommand, quoteShellCommand } from './commandUtils';
import { harnessTreeIcons } from './treeIcons';

/**
 * Claude Code adapter. Wraps the existing JSONL-based session service so the
 * rest of the extension can treat Claude and opencode uniformly.
 */
export class ClaudeHarness implements HarnessAdapter {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly icon = 'sparkle';
  readonly treeIcons = harnessTreeIcons('claude');
  readonly capabilities: HarnessCapabilities = {
    fork: true,
    move: false,
    recap: true,
    preview: 'inline',
  };

  private readonly sessionService = new ClaudeSessionService();

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
    const command = quoteShellCommand(this.command);

    if (options.forkFromSessionId) {
      return `${command} --resume ${options.forkFromSessionId} --fork-session`;
    }
    if (options.sessionId) {
      return `${command} --resume ${options.sessionId}`;
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
      recap: session.recap,
      preview: this.getPreviewSync(sessionId, 3),
    };
  }

  async getPreview(sessionId: string, maxMessages = 3): Promise<PreviewMessage[]> {
    return this.getPreviewSync(sessionId, maxMessages);
  }

  async forkSession(_sessionId: string, _cwd?: string): Promise<ForkResult> {
    // Claude forks in the terminal (--fork-session); the watcher captures the
    // new native session ID once Claude writes its first message.
    return {};
  }

  async moveSession(_sessionId: string, _directory: string): Promise<void> {
    throw new Error('Claude Code does not support moving sessions between directories');
  }

  async prepareForkToNewWorktree(
    sessionId: string,
    sourceWorktreePath: string,
    destinationWorktreePath: string
  ): Promise<ForkResult> {
    const copied = this.sessionService.copySessionToWorktree(
      sessionId,
      sourceWorktreePath,
      destinationWorktreePath
    );

    if (!copied) {
      throw new Error('Failed to copy Claude session data to the new worktree');
    }

    // The copied JSONL keeps the same session ID, so the fork resumes it.
    return { sessionId };
  }

  buildHeadlessCommand(action: HeadlessAction): HeadlessCommand | null {
    if (!action.allowedTools) {
      return null;
    }

    return {
      command: this.command,
      args: ['-p', action.prompt, '--allowedTools', action.allowedTools],
    };
  }

  private getPreviewSync(sessionId: string, maxMessages: number): PreviewMessage[] {
    return this.sessionService.getSessionPreview(sessionId, maxMessages);
  }

  private toHarnessSession(session: ClaudeSession): HarnessSession {
    return {
      harness: 'claude',
      sessionId: session.sessionId,
      cwd: session.cwd,
      summary: session.summary,
      recap: session.recap,
      gitBranch: session.gitBranch,
      lastUpdated: session.lastUpdated,
      lastActivity: session.lastPromptAt ?? session.lastUpdated?.getTime() ?? null,
      messageCount: session.messageCount,
    };
  }
}
