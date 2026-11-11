import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { lastTextBlock, normalizeSpace, truncateName } from '../utils/text';
import {
  claudeProjectDirMatches,
  encodeClaudeProjectPath,
  isWithin,
} from '../utils/paths';
import { HarnessSession, PreviewMessage, TurnState } from '../harnesses/types';
import {
  ClaudeTurnReading,
  ClaudeTurnSignals,
  deriveClaudeTurnState,
  observeClaudeTurnEntry,
  readTurnStateTail,
} from './ClaudeTurnState';
import { RecordPathCatalog, StatCache } from '../utils/recordCache';
import { parseJsonLine } from '../utils/jsonlTail';
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
  private readonly sessionFileCache = new StatCache<ClaudeSession | null>(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** Session ID to transcript path, refreshed when a cached path disappears. */
  private readonly sessionPaths = new RecordPathCatalog(
    ClaudeSessionService.CACHE_LIMIT
  );
  /** Tail readings keyed by file path, invalidated by mtime+size. */
  private readonly tailCache = new StatCache<ClaudeTurnReading | null>(
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

  /** A parsed transcript; the tree can re-render without re-reading any. */
  private async parseSessionFileCached(filePath: string, sessionId: string): Promise<ClaudeSession | null> {
    return this.sessionFileCache.get(filePath, (stats) =>
      this.parseSessionFile(filePath, sessionId, stats)
    );
  }

  private parseSessionFile(filePath: string, sessionId: string, stats: fs.Stats): ClaudeSession | null {
    if (stats.size === 0) {
      return null;
    }
    const parser = new TranscriptParser(sessionId, filePath, stats.mtime);
    try {
      for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
        parser.add(line);
      }
    } catch {
      return null;
    }
    return parser.finish();
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
    return this.sessionPaths.find(
      sessionId,
      () => {
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
        return newest?.filePath ?? null;
      },
      missTtlMs
    );
  }

  /**
   * Turn state from a transcript tail, cached by mtime+size. The attention
   * tick reads the same transcripts every few seconds; without this it would
   * re-read unchanged files.
   */
  async readTurnState(filePath: string): Promise<ClaudeTurnReading | null> {
    // A null reading is a transient read failure; caching it would pin a
    // stale turn state until the transcript next changes.
    return this.tailCache.get(filePath, () => readTurnStateTail(filePath), { cacheNull: false });
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

  /**
   * A session and the earliest prompt the user typed in it that begins with
   * `opening`, ignoring case and whitespace. The transcript is streamed once:
   * an uncached one is parsed on the same pass and the parse is cached, and a
   * cached one is read only until the prompt turns up.
   */
  async findSessionPrompt(
    sessionId: string,
    opening: string
  ): Promise<{ session: ClaudeSession; prompt?: PreviewMessage } | null> {
    const filePath = this.getSessionFilePath(sessionId);
    if (!filePath) {
      return null;
    }
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    const needle = normalizeSpace(opening);
    const fresh = this.sessionFileCache.peek(filePath, stats);
    if (fresh && (!fresh.value || !needle)) {
      return fresh.value ? { session: fresh.value } : null;
    }

    const parser = fresh ? undefined : new TranscriptParser(sessionId, filePath, stats.mtime);
    let prompt: PreviewMessage | undefined;
    const stream = fs.createReadStream(filePath, 'utf-8');
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const entry = parser ? parser.add(line) : parseJsonLine(line);
        const text: string | null = prompt || !needle ? null : claudeUserPrompt(entry);
        if (text && normalizeSpace(text).startsWith(needle)) {
          const timestamp = new Date((entry as { timestamp?: string }).timestamp ?? NaN).getTime();
          prompt = { text, timestamp: isNaN(timestamp) ? null : timestamp };
          if (!parser) {
            break;
          }
        }
      }
    } catch {
      // An unreadable transcript confirms nothing.
      return null;
    } finally {
      lines.close();
      // Closing the reader leaves the file open; an early break must close it.
      stream.destroy();
    }

    const session = parser ? parser.finish() : fresh!.value;
    if (parser) {
      this.sessionFileCache.set(filePath, stats, session);
    }
    return session ? { session, prompt } : null;
  }
}

/** A transcript line's fields, as Claude writes them; any may be missing or odd. */
type TranscriptEntry = Record<string, any>;

/**
 * Builds a `ClaudeSession` from transcript lines fed in order, so a whole-file
 * read and a stream share one parse.
 */
class TranscriptParser {
  private readonly session: ClaudeSession;
  private firstUserPrompt: string | null = null;
  // Claude stores the session's display name as `ai-title` entries. They are
  // the name shown by /status and the extension UI, so they outrank a summary
  // or the first prompt as the chat's name.
  private aiTitle: string | null = null;
  // The shared turn observer reads the last conversational entry and the
  // authoritative pending-agent count the attention tick also uses.
  private readonly turnSignals: ClaudeTurnSignals = { lastConversation: null, pendingBackgroundAgents: null };

  constructor(sessionId: string, filePath: string, mtime: Date) {
    this.session = {
      sessionId,
      cwd: '',
      summary: null,
      lastUpdated: mtime,
      lastPromptAt: null,
      filePath,
      hasMessages: false,
      turnState: 'working',
      turnEndedAt: null,
      recentUserPrompts: [],
      lastAsk: null,
      lastReply: null,
    };
  }

  /** Read one line; returns its entry, or undefined for a blank or corrupt line. */
  add(line: string): unknown {
    // A partial or corrupt line does not invalidate the transcript.
    const entry = parseJsonLine(line);
    if (entry && typeof entry === 'object') {
      try {
        this.observe(entry as TranscriptEntry);
      } catch {
        // One odd entry does not invalidate the transcript.
      }
    }
    return entry;
  }

  private observe(entry: TranscriptEntry): void {
    const session = this.session;

    if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string') {
      const title = entry.aiTitle.trim();
      if (title) {
        this.aiTitle = title;
      }
    }

    // The last summary is usually the most descriptive.
    if (entry.type === 'summary' && entry.summary) {
      session.summary = entry.summary;
    }

    observeClaudeTurnEntry(entry, this.turnSignals);

    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;

    if ((entry.type === 'user' || entry.type === 'assistant') && !entry.isSidechain) {
      session.hasMessages = true;
    }

    // Only prompts the user typed name the session and fill previews.
    const prompt = claudeUserPrompt(entry);
    if (prompt) {
      this.firstUserPrompt ??= prompt;
      const message: PreviewMessage = { text: prompt, timestamp: isNaN(timestamp) ? null : timestamp };
      session.lastAsk = message;
      session.recentUserPrompts.push(message);
      // Only the newest few are ever shown.
      if (session.recentUserPrompts.length > 3) {
        session.recentUserPrompts.shift();
      }
    }

    if (entry.type === 'user' && !isNaN(timestamp)) {
      session.lastPromptAt = timestamp;
    }

    // Assistant text is the closest thing to a "last reply"; tool-only turns
    // have no text block and are skipped. Sidechain entries are subagent
    // traffic, not the main conversation.
    if (entry.type === 'assistant' && entry.message && !entry.isSidechain) {
      const text = lastTextBlock((entry.message as { content?: unknown })?.content);
      if (text) {
        session.lastReply = { text, timestamp: isNaN(timestamp) ? null : timestamp };
      }
    }

    // A relocation entry names the session's current directory. It outranks
    // the cwd stamped on earlier entries, and the transcript may still sit
    // under the old project dir.
    if (entry.type === 'relocated' && typeof entry.relocatedCwd === 'string') {
      session.cwd = entry.relocatedCwd;
    }

    // The session's cwd is the source of truth for discovery.
    if (entry.cwd && !session.cwd) {
      session.cwd = entry.cwd;
    }
  }

  /** The session, or null when no line placed it in a folder. */
  finish(): ClaudeSession | null {
    const session = this.session;
    // The tail reader and the full parser share this derivation so the
    // attention tick and the tree cannot disagree about a session's state.
    const turn = deriveClaudeTurnState(this.turnSignals);
    session.turnState = turn.turnState;
    session.turnEndedAt = turn.turnEndedAt;

    // Prefer the harness-assigned session name, then a summary, then the
    // first prompt.
    if (this.aiTitle) {
      session.summary = this.aiTitle;
    } else if (!session.summary && this.firstUserPrompt) {
      session.summary = truncateName(this.firstUserPrompt);
    }
    // Discovery maps sessions by cwd; one without it cannot be placed.
    return session.cwd ? session : null;
  }
}

/**
 * The text of a prompt the user typed, or null for any other transcript line.
 * Claude also stores as user messages: tool results, subagent traffic
 * (`isSidechain`), injected context such as skills and reminders (`isMeta`),
 * compaction summaries (`isCompactSummary`), and command output (`<...>`).
 * Slash commands (`/model`) are the user's but do not describe the session.
 */
function claudeUserPrompt(entry: unknown): string | null {
  const record = entry as {
    type?: unknown;
    message?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    isCompactSummary?: unknown;
  } | null;
  if (
    record?.type !== 'user' ||
    !record.message ||
    record.isSidechain ||
    record.isMeta ||
    record.isCompactSummary
  ) {
    return null;
  }
  const text = messageText(record.message).trim();
  return text && !text.startsWith('/') && !text.startsWith('<') ? text : null;
}

/** First text block of a message, or its plain string form. */
function messageText(message: unknown): string {
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

/** A parsed transcript in the shape every harness reports. */
export function toHarnessSession(session: ClaudeSession): HarnessSession {
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
