import * as fs from 'fs';
import * as path from 'path';
import { lastTextBlock, truncateName } from '../utils/text';
import { encodeClaudeProjectPath, isWithin } from '../utils/paths';
import { TurnState } from '../harnesses/types';

/**
 * Claude's tool result when it launched an agent in the background. The parent
 * turn may then end while that agent keeps working, so the transcript alone
 * looks idle until a task notification or the agent's hand-back arrives.
 */
const ASYNC_AGENT_MARKER = 'Async agent launched successfully';

/** A user or assistant turn extracted from a session transcript. */
export interface ClaudePreviewMessage {
  text: string;
  timestamp: number | null;
}

/**
 * Represents an existing Claude Code session discovered from ~/.claude/projects
 */
export interface ClaudeSession {
  /** Session UUID (filename without .jsonl) */
  sessionId: string;
  /** Working directory where session was created */
  cwd: string;
  /** Session summary/description (if available) */
  summary: string | null;
  /** Latest recap from away_summary entries (if available) */
  recap: string | null;
  /** When the latest recap was produced */
  recapAt: number | null;
  /** Git branch (if available) */
  gitBranch: string | null;
  /** Timestamp of last message */
  lastUpdated: Date | null;
  /** Timestamp of the last user prompt, if any */
  lastPromptAt: number | null;
  /** Path to the session file */
  filePath: string;
  /** Number of messages in session */
  messageCount: number;
  /** Whether Claude is mid-turn (`working`) or has finished responding (`done`) */
  turnState: TurnState;
  /** Timestamp the last completed turn ended at (null while working) */
  turnEndedAt: number | null;
  /** Last few user prompts, oldest first */
  recentUserPrompts: ClaudePreviewMessage[];
  /** Most recent user prompt */
  lastAsk: ClaudePreviewMessage | null;
  /** Most recent assistant text (tool-only turns are skipped) */
  lastReply: ClaudePreviewMessage | null;
  /** Model used by the most recent assistant turn */
  model: string | null;
  /** Token usage summed across assistant turns */
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  } | null;
}

/**
 * Service for discovering existing Claude Code sessions
 */
export class ClaudeSessionService {
  private static readonly SESSION_CACHE_LIMIT = 500;

  private claudeDir: string;
  private projectsDir: string;
  /** Parsed sessions keyed by file path, invalidated by mtime+size. */
  private readonly sessionFileCache = new Map<
    string,
    { mtimeMs: number; size: number; session: ClaudeSession | null }
  >();

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.claudeDir = path.join(homeDir, '.claude');
    this.projectsDir = path.join(this.claudeDir, 'projects');
  }

  /**
   * Check if Claude Code is installed (has a .claude directory)
   */
  isClaudeInstalled(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Get all project directories
   */
  getProjectDirs(): string[] {
    if (!fs.existsSync(this.projectsDir)) {
      return [];
    }

    try {
      return fs.readdirSync(this.projectsDir)
        .filter(name => !name.startsWith('.'))
        .map(name => path.join(this.projectsDir, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  /**
   * Get all sessions in a project directory
   */
  private async getSessionsInDir(projectDir: string): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];

    let files: string[];
    try {
      files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    } catch {
      return [];
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');

      try {
        const session = await this.parseSessionFileCached(filePath, sessionId);
        if (session) {
          sessions.push(session);
        }
      } catch (err) {
        // Skip files that can't be parsed
        console.error(`Failed to parse session ${file}:`, err);
      }
    }

    return sessions;
  }

  /**
   * Parse a session file, reusing the previous result while the file is
   * unchanged. Sessions only append, so mtime+size is a sound invalidator and
   * the tree can re-render without re-reading every transcript.
   */
  private async parseSessionFileCached(
    filePath: string,
    sessionId: string
  ): Promise<ClaudeSession | null> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return null;
    }

    const cached = this.sessionFileCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.session;
    }

    const session = await this.parseSessionFile(filePath, sessionId);
    this.sessionFileCache.set(filePath, {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      session,
    });

    if (this.sessionFileCache.size > ClaudeSessionService.SESSION_CACHE_LIMIT) {
      const oldest = this.sessionFileCache.keys().next().value;
      if (oldest) {
        this.sessionFileCache.delete(oldest);
      }
    }

    return session;
  }

  /**
   * Parse a session file to extract metadata
   */
  private async parseSessionFile(filePath: string, sessionId: string): Promise<ClaudeSession | null> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return null;
    }

    // Skip empty files
    if (stats.size === 0) {
      return null;
    }

    const session: ClaudeSession = {
      sessionId,
      cwd: '',
      summary: null,
      recap: null,
      recapAt: null,
      gitBranch: null,
      lastUpdated: stats.mtime,
      lastPromptAt: null,
      filePath,
      messageCount: 0,
      turnState: 'working',
      turnEndedAt: null,
      recentUserPrompts: [],
      lastAsk: null,
      lastReply: null,
      model: null,
      tokens: null,
    };

    // Read file content synchronously (simpler and more reliable)
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let firstUserPrompt: string | null = null;
      let latestRecapTimestamp = 0;
      // The last conversational entry decides whether Claude is working. A
      // `user` entry can be a tool result, so it means mid-turn; an assistant
      // entry with a stop reason other than `tool_use` means the turn is over.
      let lastConversation: {
        type: string;
        stopReason: string | null;
        timestamp: number | null;
      } | null = null;

      // Background agents outlive the parent turn: the parent ends with
      // `end_turn` while they run, so a session with a pending agent is still
      // working. Claude's turn_duration entry carries the authoritative count;
      // the launch/notification prose covers transcripts that predate it.
      const pendingAgents = new Map<string, string | null>();
      let pendingBackgroundAgents: number | null = null;
      const resolveAgent = (id: string): void => {
        for (const [toolUseId, agentId] of pendingAgents) {
          if (toolUseId === id || agentId === id) {
            pendingAgents.delete(toolUseId);
          }
        }
      };
      const trackAgents = (content: unknown, text: string): void => {
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block?.type !== 'tool_result' ||
              typeof block.tool_use_id !== 'string'
            ) {
              continue;
            }
            const result = lastTextBlock(block.content);
            if (result.includes(ASYNC_AGENT_MARKER)) {
              pendingAgents.set(
                block.tool_use_id,
                /agentId:\s*([\w-]+)/.exec(result)?.[1] ?? null
              );
            }
          }
        }
        if (text.includes('<task-notification>')) {
          for (const notification of text.matchAll(
            /<task-notification>([\s\S]*?)<\/task-notification>/g
          )) {
            for (const id of notification[1].matchAll(
              /<(?:task-id|tool-use-id)>([^<]+)<\/(?:task-id|tool-use-id)>/g
            )) {
              resolveAgent(id[1].trim());
            }
          }
        }
        if (text.includes('<agent-message from="')) {
          for (const handBack of text.matchAll(
            /<agent-message from="([^"]+)"/g
          )) {
            resolveAgent(handBack[1].trim());
          }
        }
      };

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Get summary (prefer the last one as it's usually most descriptive)
          if (entry.type === 'summary' && entry.summary) {
            session.summary = entry.summary;
          }

          // Get recap from away_summary entries — keep the most recent by timestamp
          if (entry.type === 'system' && entry.subtype === 'away_summary' && entry.content) {
            const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
            if (ts >= latestRecapTimestamp) {
              latestRecapTimestamp = ts;
              session.recapAt = ts || null;
              // Strip the trailing "(disable recaps in /config)" hint
              session.recap = entry.content.replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
            }
          }

          // Claude writes a turn_duration entry at the end of every turn and
          // includes pendingBackgroundAgentCount only when agents are still
          // running, so a missing field means zero. This is authoritative; the
          // launch/notification prose below only feeds older transcripts.
          if (entry.type === 'system' && entry.subtype === 'turn_duration') {
            const pending = (entry as {
              pendingBackgroundAgentCount?: unknown;
            }).pendingBackgroundAgentCount;
            pendingBackgroundAgents =
              typeof pending === 'number' ? pending : 0;
          }

          const timestamp = entry.timestamp
            ? new Date(entry.timestamp).getTime()
            : NaN;

          if (
            (entry.type === 'user' || entry.type === 'assistant') &&
            !entry.isSidechain
          ) {
            const stopReason = (entry.message as { stop_reason?: unknown })
              ?.stop_reason;
            lastConversation = {
              type: entry.type,
              stopReason: typeof stopReason === 'string' ? stopReason : null,
              timestamp: isNaN(timestamp) ? null : timestamp,
            };
          }

          // Get first usable user prompt as fallback for summary
          // Skip slash commands (/model, /config, etc.) and injected system content (<...>)
          if (entry.type === 'user' && entry.message && !entry.isSidechain) {
            const text = this.extractMessageText(entry.message);
            trackAgents(
              (entry.message as { content?: unknown }).content,
              text
            );

            const trimmed = text.trimStart();
            if (trimmed && !trimmed.startsWith('/') && !trimmed.startsWith('<')) {
              if (!firstUserPrompt) {
                firstUserPrompt = trimmed;
              }
              const message: ClaudePreviewMessage = {
                text: trimmed,
                timestamp: isNaN(timestamp) ? null : timestamp,
              };
              session.lastAsk = message;
              session.recentUserPrompts.push(message);
              // Only the newest few are ever shown.
              if (session.recentUserPrompts.length > 3) {
                session.recentUserPrompts.shift();
              }
            }
          }

          // Track the latest user prompt timestamp for sorting/metadata
          if (entry.type === 'user' && entry.timestamp) {
            const ts = new Date(entry.timestamp).getTime();
            if (!isNaN(ts)) {
              session.lastPromptAt = ts;
            }
          }

          // Assistant text is the closest thing to a "last reply"; tool-only
          // turns have no text block and are skipped. Sidechain entries are
          // subagent traffic, not the main conversation.
          if (entry.type === 'assistant' && entry.message && !entry.isSidechain) {
            const text = lastTextBlock(
              (entry.message as { content?: unknown })?.content
            );
            if (text) {
              session.lastReply = {
                text,
                timestamp: isNaN(timestamp) ? null : timestamp,
              };
            }
            if (entry.message.model) {
              session.model = entry.message.model;
            }
            const usage = entry.message.usage;
            if (usage) {
              const tokens = (session.tokens ??= {
                input: 0,
                output: 0,
                reasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
              });
              tokens.input += usage.input_tokens ?? 0;
              tokens.output += usage.output_tokens ?? 0;
              tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
              tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
            }
          }

          // Get cwd and branch from user/assistant messages
          if (entry.cwd && !session.cwd) {
            session.cwd = entry.cwd;
          }

          if (entry.gitBranch && !session.gitBranch) {
            session.gitBranch = entry.gitBranch;
          }

          // Count messages
          if (entry.type === 'user' || entry.type === 'assistant') {
            session.messageCount++;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      // Any stop reason other than `tool_use` means the model finished the
      // turn (end_turn, stop_sequence, max_tokens, refusal, ...). A null stop
      // reason means the entry is still streaming. A background agent that has
      // not reported back still counts as work.
      const agentsPending =
        pendingBackgroundAgents !== null
          ? pendingBackgroundAgents > 0
          : pendingAgents.size > 0;
      if (
        !agentsPending &&
        lastConversation?.type === 'assistant' &&
        lastConversation.stopReason &&
        lastConversation.stopReason !== 'tool_use'
      ) {
        session.turnState = 'done';
        session.turnEndedAt = lastConversation.timestamp;
      }

      // Use first user prompt as fallback if no summary
      if (!session.summary && firstUserPrompt) {
        session.summary = truncateName(firstUserPrompt);
      }
    } catch {
      return null;
    }

    // Skip sessions without a working directory
    if (!session.cwd) {
      return null;
    }

    return session;
  }

  /** First text block of a message, or its plain string form. */
  private extractMessageText(message: unknown): string {
    if (typeof message === 'string') {
      return message;
    }
    const content = (message as { content?: unknown })?.content;
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          return block.text;
        }
      }
    }
    return '';
  }


  /**
   * Claude stores each session under `<projects>/<encoded cwd>`. A worktree's
   * sessions live in its own project dir, and sessions started in a
   * subdirectory encode as `<worktree>-<subdir>`, so only those dirs need to
   * be parsed.
   *
   * The name match is deliberately a superset: the encoding is lossy
   * (`/x/repo-other` encodes like `/x/repo/other`), and callers still verify
   * the parsed `cwd`.
   */
  private getProjectDirsForPaths(paths: string[]): string[] {
    const encodedRoots = paths.map((worktreePath) =>
      this.encodeProjectPath(worktreePath)
    );

    return this.getProjectDirs().filter((dir) => {
      const name = path.basename(dir);
      return encodedRoots.some(
        (root) => name === root || name.startsWith(`${root}-`)
      );
    });
  }

  /**
   * Parse sessions from the given project dirs, most recently updated first.
   */
  private async getSessionsInDirs(dirs: string[]): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];
    for (const dir of dirs) {
      sessions.push(...(await this.getSessionsInDir(dir)));
    }

    sessions.sort((a, b) => {
      if (!a.lastUpdated) return 1;
      if (!b.lastUpdated) return -1;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });

    return sessions;
  }

  /**
   * Find sessions matching a worktree path
   * Matches sessions where the session's cwd equals or is inside the worktree
   */
  async findSessionsForWorktree(worktreePath: string): Promise<ClaudeSession[]> {
    const sessions = await this.getSessionsInDirs(
      this.getProjectDirsForPaths([worktreePath])
    );

    // The directory match can over-include when encoding is ambiguous; keep
    // the exact cwd check as the source of truth.
    return sessions.filter((session) => isWithin(session.cwd, worktreePath));
  }

  /**
   * Find all sessions related to a repository (main worktree + all worktrees)
   * Matches sessions whose cwd equals or is inside any provided path
   */
  async findSessionsForRepository(repoRootPath: string, worktreePaths: string[]): Promise<ClaudeSession[]> {
    const roots = [repoRootPath, ...worktreePaths];
    const sessions = await this.getSessionsInDirs(
      this.getProjectDirsForPaths(roots)
    );

    return sessions.filter((session) =>
      roots.some((root) => isWithin(session.cwd, root))
    );
  }

  /**
   * Locate a session's transcript by ID.
   *
   * A session lives under the project directory of the cwd it started in,
   * which the ID does not reveal, so each project dir is checked in turn.
   */
  private findSessionFile(sessionId: string): string | null {
    for (const dir of this.getProjectDirs()) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }
    return null;
  }

  /**
   * Get session info by session ID
   */
  async getSessionById(sessionId: string): Promise<ClaudeSession | null> {
    const filePath = this.findSessionFile(sessionId);
    return filePath ? this.parseSessionFileCached(filePath, sessionId) : null;
  }

  /**
   * Whether a session can be resumed. This reuses the parsed transcript, so
   * after a tree render (or the first call) it costs nothing.
   */
  async isSessionResumable(sessionId: string): Promise<boolean> {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) {
      return false;
    }

    const session = await this.parseSessionFileCached(filePath, sessionId);
    return session !== null && session.messageCount > 0;
  }

  /**
   * Encode a worktree path to Claude's project directory format
   * Claude replaces all path separators and dots with dashes
   * (Based on CCManager's pathToClaudeProjectName implementation)
   */
  encodeProjectPath(worktreePath: string): string {
    return encodeClaudeProjectPath(worktreePath);
  }

  /**
   * Get the Claude project directory for a worktree path
   */
  getProjectDir(worktreePath: string): string {
    const encoded = this.encodeProjectPath(worktreePath);
    return path.join(this.projectsDir, encoded);
  }

  /**
   * Copy all session data from one worktree's project folder to another
   * This enables forking sessions across worktrees
   * (Based on CCManager's copyClaudeSessionData implementation)
   */
  copySessionToWorktree(sessionId: string, sourceWorktreePath: string, destWorktreePath: string): boolean {
    try {
      const sourceProjectDir = this.getProjectDir(sourceWorktreePath);
      const destProjectDir = this.getProjectDir(destWorktreePath);

      if (!fs.existsSync(sourceProjectDir)) {
        console.error(`Source project directory not found: ${sourceProjectDir}`);
        return false;
      }

      // Copy the entire project directory recursively
      // This preserves all session files and context. Existing files are never
      // overwritten: a name collision means the fork would clobber a session.
      fs.cpSync(sourceProjectDir, destProjectDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });

      return true;
    } catch (error) {
      console.error('Failed to copy session data:', error);
      return false;
    }
  }

  /**
   * Get the last few user messages from a session (for preview).
   *
   * Reuses the parsed session (and its file cache) instead of re-reading the
   * JSONL with a second parser.
   */
  async getSessionPreview(
    sessionId: string,
    maxMessages: number = 3
  ): Promise<ClaudePreviewMessage[]> {
    const session = await this.getSessionById(sessionId);
    if (!session) {
      return [];
    }
    return session.recentUserPrompts.slice(-maxMessages);
  }
}
