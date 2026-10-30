import * as fs from 'fs';
import * as path from 'path';
import { lastTextBlock, truncateName } from '../utils/text';
import {
  claudeProjectDirMatches,
  encodeClaudeProjectPath,
  isWithin,
} from '../utils/paths';
import { TurnState } from '../harnesses/types';
import {
  ClaudeTurnReading,
  ClaudeTurnSignals,
  deriveClaudeTurnState,
  observeClaudeTurnEntry,
  readTurnStateTail,
} from './ClaudeTurnState';
import { BoundedCache } from '../utils/boundedCache';
import { claudeConfigDir, claudeProjectDirOverride } from './claudeConfig';

/** A user or assistant turn extracted from a session transcript. */
export interface ClaudePreviewMessage {
  text: string;
  timestamp: number | null;
}

/**
 * Represents an existing Claude Code session discovered from ~/.claude/projects
 *
 * Only the fields the Claude UI uses are parsed: naming, previews, last
 * activity, and turn state. Recap, model/token usage, git branch, and message
 * count have no cheap native source and are intentionally absent.
 */
export interface ClaudeSession {
  /** Session UUID (filename without .jsonl) */
  sessionId: string;
  /** Working directory where session was created */
  cwd: string;
  /** Session summary/description (if available) */
  summary: string | null;
  /** Timestamp of last message */
  lastUpdated: Date | null;
  /** Timestamp of the last user prompt, if any */
  lastPromptAt: number | null;
  /** Path to the session file */
  filePath: string;
  /** Whether the transcript contains a real user or assistant entry. */
  hasMessages: boolean;
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
}

/**
 * Service for discovering existing Claude Code sessions
 */
export class ClaudeSessionService {
  private static readonly CACHE_LIMIT = 500;

  private readonly claudeDir: string;
  private readonly projectsDir: string;
  private readonly projectDirOverride: string | null;
  /** Parsed sessions keyed by file path, invalidated by mtime+size. */
  private readonly sessionFileCache = new BoundedCache<
    string,
    { mtimeMs: number; size: number; session: ClaudeSession | null }
  >(ClaudeSessionService.CACHE_LIMIT);
  /** Session ID to transcript path, refreshed when a cached path disappears. */
  private readonly sessionPathCatalog = new BoundedCache<string, string>(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** Tail readings keyed by file path, invalidated by mtime+size. */
  private readonly tailCache = new BoundedCache<
    string,
    { mtimeMs: number; size: number; reading: ClaudeTurnReading }
  >(ClaudeSessionService.CACHE_LIMIT);
  /** Session IDs that had no transcript at a given time. */
  private readonly missingSessionPaths = new BoundedCache<string, number>(
    ClaudeSessionService.CACHE_LIMIT
  );

  constructor() {
    // Read at construction time so a test can point the service at a temp
    // profile without changing the process environment mid-run.
    this.claudeDir = claudeConfigDir();
    this.projectsDir = path.join(this.claudeDir, 'projects');
    this.projectDirOverride = claudeProjectDirOverride();
  }

  /**
   * Check if Claude Code is installed (has a .claude directory)
   */
  isClaudeInstalled(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Get all project directories. Claude writes real directories, but a user
   * may symlink one in, so follow links instead of trusting the `Dirent`.
   */
  getProjectDirs(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      const dir = path.join(this.projectsDir, entry.name);
      try {
        if (fs.statSync(dir).isDirectory()) {
          dirs.push(dir);
        }
      } catch {
        // A broken symlink is not a project directory.
      }
    }
    return dirs;
  }

  /** The directory that holds one subdirectory per encoded project path. */
  getProjectsDirectory(): string {
    return this.projectsDir;
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
      lastUpdated: stats.mtime,
      lastPromptAt: null,
      filePath,
      hasMessages: false,
      turnState: 'working',
      turnEndedAt: null,
      recentUserPrompts: [],
      lastAsk: null,
      lastReply: null,
    };

    // Read file content synchronously (simpler and more reliable)
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let firstUserPrompt: string | null = null;
      // Claude stores the session's display name as `ai-title` entries. They
      // are the name shown by /status and the extension UI, so they outrank a
      // summary or the first prompt as the chat's name.
      let aiTitle: string | null = null;
      // The shared turn observer reads the last conversational entry and the
      // authoritative pending-agent count the attention tick also uses.
      const turnSignals: ClaudeTurnSignals = {
        lastConversation: null,
        pendingBackgroundAgents: null,
      };

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
            const title = entry.aiTitle.trim();
            if (title) {
              aiTitle = title;
            }
          }

          // Get summary (prefer the last one as it's usually most descriptive)
          if (entry.type === 'summary' && entry.summary) {
            session.summary = entry.summary;
          }

          observeClaudeTurnEntry(entry, turnSignals);

          const timestamp = entry.timestamp
            ? new Date(entry.timestamp).getTime()
            : NaN;

          if (
            (entry.type === 'user' || entry.type === 'assistant') &&
            !entry.isSidechain
          ) {
            session.hasMessages = true;
          }

          // Get first usable user prompt as fallback for summary
          // Skip slash commands (/model, /config, etc.) and injected system content (<...>)
          if (entry.type === 'user' && entry.message && !entry.isSidechain) {
            const text = this.extractMessageText(entry.message);
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
          }

          // A relocation entry names the session's current directory. It
          // outranks the cwd stamped on earlier entries, and the transcript
          // may still sit under the old project dir.
          if (
            entry.type === 'relocated' &&
            typeof entry.relocatedCwd === 'string'
          ) {
            session.cwd = entry.relocatedCwd;
          }

          // The session's cwd is the source of truth for discovery.
          if (entry.cwd && !session.cwd) {
            session.cwd = entry.cwd;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      // The tail reader and the full parser share this derivation so the
      // attention tick and the tree cannot disagree about a session's state.
      const turn = deriveClaudeTurnState(turnSignals);
      session.turnState = turn.turnState;
      session.turnEndedAt = turn.turnEndedAt;

      // Prefer the harness-assigned session name, then a summary, then the
      // first prompt.
      if (aiTitle) {
        session.summary = aiTitle;
      } else if (!session.summary && firstUserPrompt) {
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
      // An explicit project-dir name overrides Claude's path encoding.
      if (this.projectDirOverride && name === this.projectDirOverride) {
        return true;
      }
      return encodedRoots.some((root) => claudeProjectDirMatches(root, name));
    });
  }

  /**
   * Parse sessions from the given project dirs, most recently updated first.
   */
  private async getSessionsInDirs(dirs: string[]): Promise<ClaudeSession[]> {
    const byId = new Map<string, ClaudeSession>();
    for (const dir of dirs) {
      for (const session of await this.getSessionsInDir(dir)) {
        // A relocated session can leave a transcript in its old project dir;
        // the newest one is the live transcript.
        const existing = byId.get(session.sessionId);
        if (
          !existing ||
          (session.lastUpdated?.getTime() ?? 0) >
            (existing.lastUpdated?.getTime() ?? 0)
        ) {
          byId.set(session.sessionId, session);
        }
      }
    }

    return [...byId.values()].sort((a, b) => {
      if (!a.lastUpdated) return 1;
      if (!b.lastUpdated) return -1;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });
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
   * The ID does not reveal which project directory the session started in, so
   * the first lookup scans project dirs and the result is cached. A cached
   * path that no longer exists is refreshed before falling back to a scan.
   * When a session was relocated, the old project dir can still hold a
   * transcript with the same ID, so the newest file wins.
   *
   * `missTtlMs` memoizes a miss, so a caller that polls for a transcript that
   * does not exist yet does not rescan every project dir on each pass.
   */
  getSessionFilePath(sessionId: string, missTtlMs = 0): string | null {
    const cached = this.sessionPathCatalog.get(sessionId);
    if (cached) {
      try {
        if (fs.statSync(cached).isFile()) {
          return cached;
        }
      } catch {
        // Fall through and rescan.
      }
      this.sessionPathCatalog.delete(sessionId);
    }

    const missedAt = this.missingSessionPaths.get(sessionId);
    if (
      missTtlMs > 0 &&
      missedAt !== undefined &&
      Date.now() - missedAt < missTtlMs
    ) {
      return null;
    }

    let newest: { filePath: string; mtimeMs: number } | null = null;
    for (const dir of this.getProjectDirs()) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (stats.isFile() && (!newest || stats.mtimeMs > newest.mtimeMs)) {
        newest = { filePath, mtimeMs: stats.mtimeMs };
      }
    }

    if (!newest) {
      if (missTtlMs > 0) {
        this.missingSessionPaths.set(sessionId, Date.now());
      }
      return null;
    }

    this.missingSessionPaths.delete(sessionId);
    this.sessionPathCatalog.set(sessionId, newest.filePath);
    return newest.filePath;
  }

  /**
   * Turn state from a transcript tail, cached by mtime+size. The attention
   * tick reads the same transcripts every few seconds; without this it would
   * re-read unchanged files.
   */
  async readTurnState(filePath: string): Promise<ClaudeTurnReading | null> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return null;
    }

    const cached = this.tailCache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size
    ) {
      return cached.reading;
    }

    const reading = await readTurnStateTail(filePath);
    if (reading) {
      this.tailCache.set(filePath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        reading,
      });
    }
    return reading;
  }

  /**
   * Get session info by session ID
   */
  async getSessionById(sessionId: string): Promise<ClaudeSession | null> {
    const filePath = this.getSessionFilePath(sessionId);
    return filePath ? this.parseSessionFileCached(filePath, sessionId) : null;
  }

  /**
   * Whether a session can be resumed. This reuses the parsed transcript, so
   * after a tree render (or the first call) it costs nothing.
   */
  async isSessionResumable(sessionId: string): Promise<boolean> {
    const filePath = this.getSessionFilePath(sessionId);
    if (!filePath) {
      return false;
    }

    const session = await this.parseSessionFileCached(filePath, sessionId);
    return session !== null && session.hasMessages;
  }

  /**
   * Encode a worktree path to Claude's project directory format. Claude
   * replaces every character outside `[A-Za-z0-9]` with `-`.
   */
  encodeProjectPath(worktreePath: string): string {
    return encodeClaudeProjectPath(worktreePath);
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
