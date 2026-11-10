import * as fs from 'fs';
import * as path from 'path';
import { lastTextBlock, truncateName } from '../utils/text';
import {
  claudeProjectDirMatches,
  encodeClaudeProjectPath,
  isWithin,
} from '../utils/paths';
import { PreviewMessage, TurnState } from '../harnesses/types';
import {
  ClaudeTurnReading,
  ClaudeTurnSignals,
  deriveClaudeTurnState,
  observeClaudeTurnEntry,
  readTurnStateTail,
} from './ClaudeTurnState';
import { BoundedCache } from '../utils/boundedCache';
import { claudeConfigDir, claudeProjectDirOverride } from './claudeConfig';

/**
 * A Claude Code session parsed from its JSONL transcript. Deliberately lean
 * (ADR 0007): naming, previews, last activity, and turn state. Recap,
 * model/token usage, git branch, and message counts have no cheap native
 * source and are absent.
 */
export interface ClaudeSession {
  /** The transcript's file name without `.jsonl`. */
  sessionId: string;
  /** Where the session runs; a `relocated` entry overrides the first stamp. */
  cwd: string;
  /** The `ai-title`, else the last `summary`, else the first prompt. */
  summary: string | null;
  /** The transcript's mtime. */
  lastUpdated: Date | null;
  lastPromptAt: number | null;
  filePath: string;
  /** Whether the transcript has a main-chain user or assistant entry; required to resume. */
  hasMessages: boolean;
  turnState: TurnState;
  /** When the last completed turn ended; null while working. */
  turnEndedAt: number | null;
  /** The last three user prompts, oldest first. */
  recentUserPrompts: PreviewMessage[];
  lastAsk: PreviewMessage | null;
  /** Most recent assistant text; tool-only turns are skipped. */
  lastReply: PreviewMessage | null;
}

/** A value derived from a file, valid while the file's mtime and size hold. */
interface StatCached<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

/**
 * Discovers Claude Code sessions under the profile's `projects/` directory.
 * Transcripts only append, so parses are cached by mtime+size.
 */
export class ClaudeSessionService {
  private static readonly CACHE_LIMIT = 500;

  private readonly claudeDir: string;
  private readonly projectsDir: string;
  private readonly projectDirOverride: string | null;
  /** Parsed sessions keyed by file path, invalidated by mtime+size. */
  private readonly sessionFileCache = new BoundedCache<string, StatCached<ClaudeSession | null>>(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** Session ID to transcript path, refreshed when a cached path disappears. */
  private readonly sessionPathCatalog = new BoundedCache<string, string>(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** Tail readings keyed by file path, invalidated by mtime+size. */
  private readonly tailCache = new BoundedCache<string, StatCached<ClaudeTurnReading | null>>(
    ClaudeSessionService.CACHE_LIMIT
  );
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

  /** Whether a Claude profile directory exists. */
  isClaudeInstalled(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Every project directory. Claude writes real directories, but a user may
   * symlink one in, so follow links instead of trusting the `Dirent`.
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
        console.error(`Failed to parse session ${file}:`, err);
      }
    }

    return sessions;
  }

  /**
   * `compute` for a file, reused while its mtime and size are unchanged.
   * Null when the file is gone.
   */
  private async statCached<T>(
    cache: BoundedCache<string, StatCached<T>>,
    filePath: string,
    compute: (stats: fs.Stats) => Promise<T> | T,
    { cacheNull = true }: { cacheNull?: boolean } = {}
  ): Promise<T | null> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return null;
    }
    const cached = cache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return cached.value;
    }
    const value = await compute(stats);
    if (value !== null || cacheNull) {
      cache.set(filePath, { mtimeMs: stats.mtimeMs, size: stats.size, value });
    }
    return value;
  }

  /** A parsed transcript; the tree can re-render without re-reading any. */
  private async parseSessionFileCached(filePath: string, sessionId: string): Promise<ClaudeSession | null> {
    return this.statCached(this.sessionFileCache, filePath, (stats) =>
      this.parseSessionFile(filePath, sessionId, stats)
    );
  }

  private parseSessionFile(filePath: string, sessionId: string, stats: fs.Stats): ClaudeSession | null {
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

          // The last summary is usually the most descriptive.
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

          // A prompt that names the session: not a slash command (/model)
          // and not injected system content (<...>).
          if (entry.type === 'user' && entry.message && !entry.isSidechain) {
            const text = this.extractMessageText(entry.message);
            const trimmed = text.trimStart();
            if (trimmed && !trimmed.startsWith('/') && !trimmed.startsWith('<')) {
              if (!firstUserPrompt) {
                firstUserPrompt = trimmed;
              }
              const message: PreviewMessage = {
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
          // A partial or corrupt line does not invalidate the transcript.
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

    // Discovery maps sessions by cwd; one without it cannot be placed.
    return session.cwd ? session : null;
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
    const encodedRoots = paths.map(encodeClaudeProjectPath);

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

  /** Sessions whose cwd is the worktree or inside it. */
  async findSessionsForWorktree(worktreePath: string): Promise<ClaudeSession[]> {
    const sessions = await this.getSessionsInDirs(
      this.getProjectDirsForPaths([worktreePath])
    );

    // The directory match can over-include when encoding is ambiguous; keep
    // the exact cwd check as the source of truth.
    return sessions.filter((session) => isWithin(session.cwd, worktreePath));
  }

  /** Sessions whose cwd is inside the repository root or any of its worktrees. */
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
    // A null reading is a transient read failure; caching it would pin a
    // stale turn state until the transcript next changes.
    return this.statCached(this.tailCache, filePath, () => readTurnStateTail(filePath), { cacheNull: false });
  }

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

  /** The last few user prompts, from the cached parse. */
  async getSessionPreview(sessionId: string, maxMessages = 3): Promise<PreviewMessage[]> {
    const session = await this.getSessionById(sessionId);
    if (!session) {
      return [];
    }
    return session.recentUserPrompts.slice(-maxMessages);
  }
}
