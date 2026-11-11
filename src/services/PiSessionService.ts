import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessSession, PreviewMessage, TurnState } from '../harnesses/types';
import {
  canonicalPath,
  encodePiProjectDir,
  isWithin,
  piProjectDirMatches,
} from '../utils/paths';
import { BoundedCache } from '../utils/boundedCache';
import { JsonlTailScan, readJsonlTail } from '../utils/jsonlTail';

/**
 * A Pi session parsed from its JSONL record.
 *
 * Pi documents the format (`docs/session-format.md`) and also offers an SDK,
 * but Agntree reads the documented JSONL files, like Claude's transcripts:
 * importing the installed package would couple the extension to a private
 * install path. Pi's CLI remains the process boundary for create, resume, and
 * fork. The record is append-only and versioned.
 */
export interface PiSession {
  sessionId: string;
  /** The working directory recorded in the session header. */
  cwd: string;
  /** Latest `/name`, else the first user prompt. */
  summary: string | null;
  lastUpdated: Date | null;
  lastActivity: number | null;
  /** Every `message` entry, as Pi's own session stats count them. */
  messageCount: number;
  turnState: TurnState;
  /** When the last completed turn ended; null while working. */
  turnEndedAt: number | null;
  /** The last few user prompts, oldest first. */
  recentUserPrompts: PreviewMessage[];
  lastAsk: PreviewMessage | null;
  /** Most recent assistant text; tool-only turns are skipped. */
  lastReply: PreviewMessage | null;
  /** The model selected by the latest `model_change`. */
  model?: string;
  tokens?: HarnessSession['tokens'];
  cost?: number;
}

export interface PiTurnReading {
  turnState: TurnState;
  turnEndedAt: number | null;
}

/** A value derived from a file, valid while the file's mtime and size hold. */
interface StatCached<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

interface PiUsageTotals {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

interface PiEntry {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  name?: unknown;
  provider?: unknown;
  modelId?: unknown;
  usage?: unknown;
  message?: unknown;
}

interface PiMessage {
  role?: unknown;
  content?: unknown;
  timestamp?: unknown;
  provider?: unknown;
  model?: unknown;
  responseModel?: unknown;
  stopReason?: unknown;
  usage?: unknown;
}

interface PiUsage {
  input?: unknown;
  output?: unknown;
  reasoning?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
  cost?: { total?: unknown };
}

interface PiConversationEntry {
  role: string;
  stopReason: string | null;
  timestamp: number | null;
}

const CACHE_LIMIT = 500;
const MAX_PREVIEW_PROMPTS = 10;
const SESSION_DIR_CACHE_TTL_MS = 15_000;
const DIRECTORY_CACHE_TTL_MS = 5_000;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('\n').trim();
}

function entryTime(entry: PiEntry): number | null {
  const message = entry.message as PiMessage | undefined;
  const nested = finiteNumber(message?.timestamp);
  if (nested !== undefined) {
    return nested;
  }
  if (typeof entry.timestamp === 'string') {
    const parsed = new Date(entry.timestamp).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function readUsage(value: unknown): PiUsage | null {
  return value && typeof value === 'object' ? (value as PiUsage) : null;
}

function addUsage(totals: PiUsageTotals, usage: PiUsage | null): boolean {
  if (!usage) {
    return false;
  }
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const reasoning = finiteNumber(usage.reasoning);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  const cost = finiteNumber(usage.cost?.total);
  totals.input += input ?? 0;
  totals.output += output ?? 0;
  totals.reasoning += reasoning ?? 0;
  totals.cacheRead += cacheRead ?? 0;
  totals.cacheWrite += cacheWrite ?? 0;
  totals.cost += cost ?? 0;
  return (
    input !== undefined ||
    output !== undefined ||
    reasoning !== undefined ||
    cacheRead !== undefined ||
    cacheWrite !== undefined ||
    cost !== undefined
  );
}

function modelFromEntry(entry: PiEntry): string | undefined {
  const provider = typeof entry.provider === 'string' ? entry.provider.trim() : '';
  const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
  if (!modelId) {
    return undefined;
  }
  return provider ? `${provider}/${modelId}` : modelId;
}

function modelFromMessage(message: PiMessage): string | undefined {
  const provider = typeof message.provider === 'string' ? message.provider.trim() : '';
  const model =
    (typeof message.responseModel === 'string' && message.responseModel.trim()) ||
    (typeof message.model === 'string' ? message.model.trim() : '');
  if (!model) {
    return undefined;
  }
  return provider ? `${provider}/${model}` : model;
}

function conversationEntry(message: PiMessage, timestamp: number | null): PiConversationEntry | null {
  const role = typeof message.role === 'string' ? message.role : '';
  if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') {
    return null;
  }
  const stopReason =
    typeof message.stopReason === 'string' ? message.stopReason : null;
  return { role, stopReason, timestamp };
}

/**
 * A terminal assistant message ends a turn; `toolUse` means more work follows.
 * This is the last persisted fact, not Pi's `agent_settled`: automatic retry,
 * queued follow-ups, and compaction are events, not session entries, so a
 * failed attempt can briefly look finished.
 */
function readingFor(
  last: PiConversationEntry | null
): PiTurnReading {
  const done =
    last?.role === 'assistant' &&
    last.stopReason !== null &&
    last.stopReason !== 'toolUse' &&
    last.stopReason !== 'pending';
  return done
    ? { turnState: 'done', turnEndedAt: last.timestamp }
    : { turnState: 'working', turnEndedAt: null };
}

/**
 * Parse one Pi JSONL record. Null when the file has no valid session header;
 * an unreadable or truncated trailing line is skipped rather than failing the
 * whole session.
 */
function parsePiSession(
  filePath: string,
  stats: fs.Stats
): PiSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  let header: PiEntry | null = null;
  let headerIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/^\uFEFF/, '').trim();
    if (!line) {
      continue;
    }
    try {
      const candidate = JSON.parse(line) as PiEntry;
      if (candidate.type !== 'session') {
        return null;
      }
      header = candidate;
      headerIndex = index;
    } catch {
      return null;
    }
    break;
  }

  if (!header) {
    return null;
  }
  const sessionId = typeof header.id === 'string' ? header.id : '';
  const cwd = typeof header.cwd === 'string' ? header.cwd : '';
  if (!sessionId || !cwd) {
    return null;
  }

  const headerTime =
    typeof header.timestamp === 'string'
      ? new Date(header.timestamp).getTime()
      : NaN;

  let name: string | undefined;
  let firstPrompt: string | undefined;
  let messageCount = 0;
  let lastActivity: number | null = null;
  let lastConversation: PiConversationEntry | null = null;
  let lastReply: PreviewMessage | null = null;
  let latestModelChange: string | undefined;
  let latestAssistantModel: string | undefined;
  let sawUsage = false;
  const totals: PiUsageTotals = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  const prompts: PreviewMessage[] = [];

  for (let index = headerIndex + 1; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      // A partial line while Pi is writing is not a fact.
      continue;
    }

    if (entry.type === 'session_info') {
      name =
        typeof entry.name === 'string' && entry.name.trim()
          ? entry.name.trim()
          : undefined;
      continue;
    }

    if (entry.type === 'model_change') {
      latestModelChange = modelFromEntry(entry) ?? latestModelChange;
      continue;
    }

    if (entry.type === 'usage') {
      sawUsage = addUsage(totals, readUsage(entry.usage)) || sawUsage;
      continue;
    }

    if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      sawUsage = addUsage(totals, readUsage(entry.usage)) || sawUsage;
      continue;
    }

    if (entry.type !== 'message') {
      continue;
    }

    messageCount++;
    const message = (entry.message ?? {}) as PiMessage;
    const role = typeof message.role === 'string' ? message.role : '';
    const timestamp = entryTime(entry);

    if (role === 'user' || role === 'assistant') {
      const activity =
        timestamp ?? (Number.isNaN(headerTime) ? stats.mtime.getTime() : headerTime);
      lastActivity = Math.max(lastActivity ?? 0, activity);
    }

    if (role === 'user') {
      const text = textFromContent(message.content);
      if (text) {
        firstPrompt ??= text;
        prompts.push({ text, timestamp });
        if (prompts.length > MAX_PREVIEW_PROMPTS) {
          prompts.shift();
        }
      }
    } else if (role === 'assistant') {
      const text = textFromContent(message.content);
      if (text) {
        lastReply = { text, timestamp };
      }
      latestAssistantModel = modelFromMessage(message) ?? latestAssistantModel;
      sawUsage = addUsage(totals, readUsage(message.usage)) || sawUsage;
    } else if (role === 'toolResult') {
      sawUsage = addUsage(totals, readUsage(message.usage)) || sawUsage;
    }

    const conversation = conversationEntry(message, timestamp);
    if (conversation) {
      lastConversation = conversation;
    }
  }

  const reading = readingFor(lastConversation);
  const preview = prompts.slice();
  const lastAsk = preview.length ? preview[preview.length - 1] : null;
  const model = latestModelChange ?? latestAssistantModel;
  const lastUpdated =
    lastActivity !== null
      ? new Date(lastActivity)
      : !Number.isNaN(headerTime)
        ? new Date(headerTime)
        : stats.mtime;

  return {
    sessionId,
    cwd,
    summary: name ?? firstPrompt ?? null,
    lastUpdated,
    lastActivity: lastActivity ?? lastUpdated.getTime(),
    messageCount,
    turnState: reading.turnState,
    turnEndedAt: reading.turnEndedAt,
    recentUserPrompts: preview,
    lastAsk,
    lastReply,
    model,
    tokens: sawUsage
      ? {
          input: totals.input,
          output: totals.output,
          reasoning: totals.reasoning,
          cacheRead: totals.cacheRead,
          cacheWrite: totals.cacheWrite,
        }
      : undefined,
    cost: sawUsage ? totals.cost : undefined,
  };
}

function scanTurnText(text: string): JsonlTailScan<PiTurnReading> {
  let last: PiConversationEntry | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let entry: PiEntry;
    try {
      entry = JSON.parse(line) as PiEntry;
    } catch {
      continue;
    }
    if (entry.type !== 'message') {
      continue;
    }
    const message = (entry.message ?? {}) as PiMessage;
    const conversation = conversationEntry(message, entryTime(entry));
    if (conversation) {
      last = conversation;
    }
  }
  return { value: readingFor(last), decided: last !== null };
}

/**
 * The session ID in Pi's `<timestamp>_<id>.jsonl` file name. The timestamp is
 * ISO with `:` and `.` replaced by `-`, so it has no underscore; a session ID
 * may, so split at the first one. If the timestamp format ever gains an
 * underscore this fast path stops matching, and the 5-second poll (which
 * matches the ID suffix) still links the record.
 */
export function piSessionIdFromFileName(filename: string): string | null {
  if (!filename.endsWith('.jsonl')) {
    return null;
  }
  const base = filename.slice(0, -'.jsonl'.length);
  const separator = base.indexOf('_');
  if (separator <= 0 || separator === base.length - 1) {
    return null;
  }
  return base.slice(separator + 1);
}

/**
 * Discovers Pi CLI sessions under `~/.pi/agent/sessions/`, one directory per
 * encoded working directory. The record is append-only, so parses are cached
 * by mtime+size. Session storage may be moved by `PI_CODING_AGENT_DIR`,
 * `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting; the first two are
 * environment overrides, and the setting is read from the same files Pi reads.
 */
export class PiSessionService {
  /** Parsed sessions keyed by file path, invalidated by mtime+size. */
  private readonly sessionFileCache = new BoundedCache<
    string,
    StatCached<PiSession | null>
  >(CACHE_LIMIT);
  /** Session ID to record path, refreshed when a cached path disappears. */
  private readonly sessionPathCatalog = new BoundedCache<string, string>(
    CACHE_LIMIT
  );
  /** Tail readings keyed by file path, invalidated by mtime+size. */
  private readonly tailCache = new BoundedCache<
    string,
    StatCached<PiTurnReading | null>
  >(CACHE_LIMIT);
  /** Session IDs that had no record at a given time. */
  private readonly missingSessionPaths = new BoundedCache<string, number>(
    CACHE_LIMIT
  );
  /** Resolved `sessionDir` per working directory, bounded by a short TTL. */
  private readonly sessionDirCache = new BoundedCache<
    string,
    { at: number; value: string | null }
  >(200);
  /** Directory listings for encoded session roots. */
  private readonly directoryCache = new BoundedCache<
    string,
    { at: number; names: string[] }
  >(200);

  /** Whether a Pi profile directory exists. */
  isPiInstalled(): boolean {
    return fs.existsSync(this.getAgentDirectory());
  }

  /** `PI_CODING_AGENT_DIR` or `~/.pi/agent`, resolved for a session's cwd. */
  private getAgentDirectory(cwd: string = process.cwd()): string {
    const configured = process.env.PI_CODING_AGENT_DIR?.trim();
    if (configured) {
      return this.resolveConfiguredPath(configured, cwd);
    }
    return path.join(os.homedir(), '.pi', 'agent');
  }

  private getSessionsRoot(cwd: string = process.cwd()): string {
    return path.join(this.getAgentDirectory(cwd), 'sessions');
  }

  /**
   * The flat session directory when `PI_CODING_AGENT_SESSION_DIR` or the
   * `sessionDir` setting overrides the per-cwd layout. Environment wins over
   * global settings, and project settings win over global ones.
   */
  private sessionDirOverride(cwd: string): string | null {
    const cached = this.sessionDirCache.get(cwd);
    if (cached && Date.now() - cached.at < SESSION_DIR_CACHE_TTL_MS) {
      return cached.value;
    }
    const value = this.resolveSessionDirOverride(cwd);
    this.sessionDirCache.set(cwd, { at: Date.now(), value });
    return value;
  }

  private resolveSessionDirOverride(cwd: string): string | null {
    const fromEnvironment =
      process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
    if (fromEnvironment) {
      return this.resolveConfiguredPath(fromEnvironment, cwd);
    }

    const agentDir = this.getAgentDirectory(cwd);
    const global = this.readSettingsSessionDir(
      path.join(agentDir, 'settings.json'),
      cwd
    );
    const project = this.readSettingsSessionDir(
      path.join(canonicalPath(cwd), '.pi', 'settings.json'),
      cwd
    );
    return project ?? global ?? null;
  }

  private readSettingsSessionDir(
    settingsPath: string,
    cwd: string
  ): string | null {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, '')
      ) as { sessionDir?: unknown };
      if (typeof parsed?.sessionDir !== 'string' || !parsed.sessionDir.trim()) {
        return null;
      }
      return this.resolveConfiguredPath(parsed.sessionDir.trim(), cwd);
    } catch {
      return null;
    }
  }

  private resolveConfiguredPath(value: string, cwd: string): string {
    if (value === '~') {
      return os.homedir();
    }
    if (value.startsWith('~/') || value.startsWith('~\\')) {
      return path.resolve(os.homedir(), value.slice(2));
    }
    return path.resolve(cwd, value);
  }

  /** Directories that may hold sessions for the given working directories. */
  private getSessionDirsForPaths(paths: string[], force = false): string[] {
    const dirs = new Set<string>();
    // Several worktrees share the default sessions root; list it once.
    const listings = new Map<string, string[]>();
    const namesIn = (root: string): string[] => {
      let names = listings.get(root);
      if (!names) {
        names = this.readDirectoryNames(root, force);
        listings.set(root, names);
      }
      return names;
    };

    for (const cwd of paths) {
      if (!cwd) {
        continue;
      }
      // Pi reads project settings from the process cwd only and resolves a
      // relative `sessionDir` against it. A Pi started in a subdirectory of
      // this worktree therefore ignores this worktree's setting and uses the
      // default layout, so keep scanning both. A `sessionDir` set only in a
      // subdirectory's own `.pi/settings.json` stays invisible; finding it
      // would require walking the worktree.
      const override = this.sessionDirOverride(cwd);
      if (override) {
        dirs.add(override);
      }
      const root = this.getSessionsRoot(cwd);
      const encoded = encodePiProjectDir(cwd);
      for (const name of namesIn(root)) {
        if (piProjectDirMatches(encoded, name)) {
          dirs.add(path.join(root, name));
        }
      }
    }
    return [...dirs];
  }

  /**
   * Directories to search for a session ID in `cwd`. The exact encoded
   * directory is checked first without the listing cache, so a record Pi just
   * created links on the watch event instead of waiting for a stale listing.
   */
  private candidateDirsForCwd(cwd: string): string[] {
    const dirs = [
      path.join(this.getSessionsRoot(cwd), encodePiProjectDir(cwd)),
    ];
    for (const dir of this.getSessionDirsForPaths([cwd])) {
      if (!dirs.includes(dir)) {
        dirs.push(dir);
      }
    }
    return dirs;
  }

  /** Directories to watch for the given working directories' sessions. */
  getSessionDirsForWatch(worktreePaths: string[]): string[] {
    return this.getSessionDirsForPaths(worktreePaths, true);
  }

  /** Parent directories where new session directories or files appear. */
  getWatchRoots(worktreePaths: string[]): string[] {
    const roots = new Set<string>();
    roots.add(this.getSessionsRoot());
    for (const cwd of worktreePaths) {
      roots.add(this.getSessionsRoot(cwd));
      const override = this.sessionDirOverride(cwd);
      if (override) {
        roots.add(override);
      }
    }
    return [...roots];
  }

  private readDirectoryNames(dir: string, force = false): string[] {
    const cached = this.directoryCache.get(dir);
    if (cached && !force && Date.now() - cached.at < DIRECTORY_CACHE_TTL_MS) {
      return cached.names;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      this.directoryCache.set(dir, { at: Date.now(), names: [] });
      return [];
    }

    const names: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (entry.isDirectory()) {
        names.push(entry.name);
        continue;
      }
      if (entry.isSymbolicLink()) {
        try {
          if (fs.statSync(path.join(dir, entry.name)).isDirectory()) {
            names.push(entry.name);
          }
        } catch {
          // A broken symlink is not a session directory.
        }
      }
    }
    this.directoryCache.set(dir, { at: Date.now(), names });
    return names;
  }

  private async getSessionsInDirs(dirs: string[]): Promise<PiSession[]> {
    const byId = new Map<string, PiSession>();
    for (const dir of dirs) {
      let files: string[];
      try {
        files = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const filePath = path.join(dir, file);
        const session = await this.parseSessionFileCached(filePath);
        if (!session) {
          continue;
        }
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
  async listSessionsForWorktree(
    worktreePath: string,
    force = false
  ): Promise<PiSession[]> {
    const sessions = await this.getSessionsInDirs(
      this.getSessionDirsForPaths([worktreePath], force)
    );
    return sessions.filter((session) => isWithin(session.cwd, worktreePath));
  }

  /** Sessions whose cwd is inside the repository root or any of its worktrees. */
  async listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<PiSession[]> {
    const roots = [repoRootPath, ...worktreePaths];
    const sessions = await this.getSessionsInDirs(
      this.getSessionDirsForPaths(roots)
    );
    return sessions.filter((session) =>
      roots.some((root) => isWithin(session.cwd, root))
    );
  }

  /**
   * Locate a session's record by ID. Pi names the file `<timestamp>_<id>.jsonl`,
   * so the ID is enough; a cached path that no longer exists is refreshed
   * before falling back to a scan.
   *
   * `missTtlMs` memoizes a miss so a caller polling for a record that does not
   * exist yet does not rescan every session directory on each pass.
   */
  getSessionFilePath(
    sessionId: string,
    cwd?: string,
    missTtlMs = 0
  ): string | null {
    const cached = this.sessionPathCatalog.get(sessionId);
    if (cached) {
      // The header was verified when this path was cached. A stat is enough
      // here: this lookup runs for every row on a tree render.
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

    const dirs = cwd
      ? this.candidateDirsForCwd(cwd)
      : this.getAllSessionDirs();
    let newest: { filePath: string; mtimeMs: number } | null = null;

    for (const dir of dirs) {
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.endsWith(`_${sessionId}.jsonl`)) {
          continue;
        }
        const filePath = path.join(dir, file);
        let stats: fs.Stats;
        try {
          stats = fs.statSync(filePath);
        } catch {
          continue;
        }
        if (
          stats.isFile() &&
          this.headerMatches(filePath, sessionId) &&
          (!newest || stats.mtimeMs > newest.mtimeMs)
        ) {
          newest = { filePath, mtimeMs: stats.mtimeMs };
        }
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

  private getAllSessionDirs(): string[] {
    const dirs = new Set<string>();
    const root = this.getSessionsRoot();
    for (const name of this.readDirectoryNames(root, true)) {
      dirs.add(path.join(root, name));
    }
    const override = this.sessionDirOverride(process.cwd());
    if (override) {
      dirs.add(override);
    }
    return [...dirs];
  }

  /**
   * Confirm the record's header names the session before trusting the name.
   * Reads only the first block, not the transcript body.
   */
  private headerMatches(filePath: string, sessionId: string): boolean {
    let fd: number | undefined;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(64 * 1024);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const first = buffer
        .subarray(0, bytesRead)
        .toString('utf8')
        .split('\n', 1)[0]
        ?.replace(/^\uFEFF/, '')
        .trim();
      if (!first) {
        return false;
      }
      const header = JSON.parse(first) as { type?: unknown; id?: unknown };
      return header.type === 'session' && header.id === sessionId;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
    }
  }

  async getSessionById(
    sessionId: string,
    cwd?: string
  ): Promise<PiSession | null> {
    const filePath = this.getSessionFilePath(sessionId, cwd);
    if (!filePath) {
      return null;
    }
    const session = await this.parseSessionFileCached(filePath);
    if (!session || session.sessionId !== sessionId) {
      return null;
    }
    if (cwd && !isWithin(session.cwd, cwd)) {
      return null;
    }
    return session;
  }

  /** Whether the record exists and can be opened with `--session <id>`. */
  async isSessionResumable(sessionId: string, cwd?: string): Promise<boolean> {
    return (await this.getSessionById(sessionId, cwd)) !== null;
  }

  /** A session's summary, for naming a newly linked chat. */
  async getSummary(
    sessionId: string,
    cwd?: string
  ): Promise<string | null> {
    return (await this.getSessionById(sessionId, cwd))?.summary ?? null;
  }

  /**
   * Turn state from a record tail, cached by mtime+size. The attention tick
   * reads the same records every few seconds; without this it would re-read
   * unchanged files.
   */
  async readTurnState(filePath: string): Promise<PiTurnReading | null> {
    return this.statCached(
      this.tailCache,
      filePath,
      () => readJsonlTail(filePath, scanTurnText),
      { cacheNull: false }
    );
  }

  private async parseSessionFileCached(
    filePath: string
  ): Promise<PiSession | null> {
    return this.statCached(this.sessionFileCache, filePath, (stats) =>
      parsePiSession(filePath, stats)
    );
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
      stats = await fs.promises.stat(filePath);
    } catch {
      return null;
    }
    const cached = cache.get(filePath);
    if (
      cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.size === stats.size
    ) {
      return cached.value;
    }
    const value = await compute(stats);
    if (value !== null || cacheNull) {
      cache.set(filePath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        value,
      });
    }
    return value;
  }
}

/** Map a parsed Pi session onto the shared session shape. */
export function toHarnessSession(session: PiSession): HarnessSession {
  return {
    harness: 'pi',
    sessionId: session.sessionId,
    cwd: session.cwd,
    summary: session.summary,
    gitBranch: null,
    lastUpdated: session.lastUpdated,
    lastActivity: session.lastActivity,
    messageCount: session.messageCount,
    turnState: session.turnState,
    turnEndedAt: session.turnEndedAt,
    model: session.model,
    tokens: session.tokens,
    cost: session.cost,
  };
}
