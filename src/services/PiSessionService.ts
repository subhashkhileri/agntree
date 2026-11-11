import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { HarnessSession, PreviewMessage, TurnState } from '../harnesses/types';
import {
  canonicalPath,
  encodePiProjectDir,
  isWithin,
  piProjectDirMatches,
} from '../utils/paths';
import { BoundedCache } from '../utils/boundedCache';
import { JsonlTailScan, parseJsonLine, readJsonlTail } from '../utils/jsonlTail';
import { JsonlAppendReader, JsonlFold } from '../utils/jsonlAppendReader';
import { RecordPathCatalog, StatCache } from '../utils/recordCache';
import { normalizeSpace, truncateName } from '../utils/text';

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
  /** Latest `/name`, else the first user prompt, truncated. */
  summary: string | null;
  /** The last user or assistant message, else the header time, else the mtime. */
  lastUpdated: Date;
  /** Every `message` entry, as Pi's own session stats count them. */
  messageCount: number;
  turnState: TurnState;
  /** When the last completed turn ended; null while working. */
  turnEndedAt: number | null;
  /** The last three user prompts, oldest first. */
  recentUserPrompts: PreviewMessage[];
  /** Most recent assistant text; tool-only turns are skipped. */
  lastReply: PreviewMessage | null;
  /** The model selected by the latest `model_change`. */
  model?: string;
}

export interface PiTurnReading {
  turnState: TurnState;
  turnEndedAt: number | null;
}

interface PiEntry {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  name?: unknown;
  provider?: unknown;
  modelId?: unknown;
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
}

/** The header fields that locate a record; Pi never rewrites them. */
interface PiHeader {
  id: string;
  cwd: string;
}

interface PiConversationEntry {
  role: string;
  stopReason: string | null;
  timestamp: number | null;
}

const CACHE_LIMIT = 500;
/**
 * Headers are small and never change, so this holds more than the parse cache:
 * a scan of a shared `sessionDir` reads every header to find the few records
 * it parses.
 */
const HEADER_CACHE_LIMIT = 5_000;
const MAX_PREVIEW_PROMPTS = 3;
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

/**
 * The user's typed prompt in a record entry, or null for every other entry.
 * System messages hold the prompt and tool loadout, assistant messages hold
 * replies and tool calls, and toolResult entries hold output; none is a
 * prompt. One rule serves naming, previews, and the session finder.
 */
export function piUserPrompt(
  value: unknown
): { text: string; timestamp: number | null } | null {
  const entry = value as PiEntry | null;
  if (entry?.type !== 'message') {
    return null;
  }
  const message = (entry.message ?? {}) as PiMessage;
  if (message.role !== 'user') {
    return null;
  }
  const text = textFromContent(message.content);
  return text ? { text, timestamp: entryTime(entry) } : null;
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

/** What has been folded from a record so far; see `piRecordFold`. */
interface PiRecordState {
  /** Set by the first entry; null until then. */
  header: { id: string; cwd: string; time: number } | null;
  /** The first entry was not a session header, so this is not a Pi record. */
  invalid: boolean;
  name?: string;
  /** The first user prompt, already truncated for use as a name. */
  firstPrompt?: string;
  messageCount: number;
  /** The latest timestamp on a user or assistant message. */
  lastStampedActivity: number | null;
  /** A user or assistant message had no timestamp of its own. */
  unstampedActivity: boolean;
  lastConversation: PiConversationEntry | null;
  lastReply: PreviewMessage | null;
  latestModelChange?: string;
  latestAssistantModel?: string;
  /** The last few user prompts, oldest first. */
  prompts: PreviewMessage[];
}

function applyPiEntry(value: unknown, state: PiRecordState): void {
  if (state.invalid) {
    return;
  }
  const entry =
    value && typeof value === 'object' ? (value as PiEntry) : null;

  if (!state.header) {
    // Like Pi's own loader, the first decoded entry must be the header.
    const id =
      entry?.type === 'session' && typeof entry.id === 'string' ? entry.id : '';
    const cwd = typeof entry?.cwd === 'string' ? entry.cwd : '';
    if (!entry || !id || !cwd) {
      state.invalid = true;
      return;
    }
    state.header = {
      id,
      cwd,
      time:
        typeof entry.timestamp === 'string'
          ? new Date(entry.timestamp).getTime()
          : NaN,
    };
    return;
  }
  if (!entry) {
    return;
  }

  if (entry.type === 'session_info') {
    state.name =
      typeof entry.name === 'string' && entry.name.trim()
        ? entry.name.trim()
        : undefined;
    return;
  }

  if (entry.type === 'model_change') {
    state.latestModelChange = modelFromEntry(entry) ?? state.latestModelChange;
    return;
  }

  if (
    entry.type === 'usage' ||
    entry.type === 'compaction' ||
    entry.type === 'branch_summary'
  ) {
    // Token and cost totals are deliberately not kept.
    return;
  }

  if (entry.type !== 'message') {
    return;
  }

  state.messageCount++;
  const message = (entry.message ?? {}) as PiMessage;
  const role = typeof message.role === 'string' ? message.role : '';
  const timestamp = entryTime(entry);

  if (role === 'user' || role === 'assistant') {
    if (timestamp === null) {
      state.unstampedActivity = true;
    } else {
      state.lastStampedActivity = Math.max(
        state.lastStampedActivity ?? 0,
        timestamp
      );
    }
  }

  const prompt = piUserPrompt(entry);
  if (prompt) {
    state.firstPrompt ??= truncateName(prompt.text);
    state.prompts.push({ text: prompt.text, timestamp: prompt.timestamp });
    if (state.prompts.length > MAX_PREVIEW_PROMPTS) {
      state.prompts.shift();
    }
  } else if (role === 'assistant') {
    const text = textFromContent(message.content);
    if (text) {
      state.lastReply = { text, timestamp };
    }
    state.latestAssistantModel =
      modelFromMessage(message) ?? state.latestAssistantModel;
  }
  const conversation = conversationEntry(message, timestamp);
  if (conversation) {
    state.lastConversation = conversation;
  }
}

/** The session folded so far; null until a valid header has been read. */
function piSessionFromState(
  state: PiRecordState,
  stats: fs.Stats
): PiSession | null {
  const header = state.header;
  if (state.invalid || !header) {
    return null;
  }

  // A message without its own timestamp counts at the header time, else at
  // the file's mtime.
  const fallback = Number.isNaN(header.time)
    ? stats.mtime.getTime()
    : header.time;
  const lastActivity = state.unstampedActivity
    ? Math.max(state.lastStampedActivity ?? 0, fallback)
    : state.lastStampedActivity;
  const reading = readingFor(state.lastConversation);

  return {
    sessionId: header.id,
    cwd: header.cwd,
    summary: state.name ?? state.firstPrompt ?? null,
    lastUpdated: new Date(lastActivity ?? fallback),
    messageCount: state.messageCount,
    turnState: reading.turnState,
    turnEndedAt: reading.turnEndedAt,
    // Copies: the state keeps changing as later reads fold appended entries.
    recentUserPrompts: [...state.prompts],
    lastReply: state.lastReply,
    model: state.latestModelChange ?? state.latestAssistantModel,
  };
}

/**
 * Pi records are read incrementally. Pi appends every entry; it rewrites a
 * record in place only when it migrates an older format version on load,
 * which rewrites the header line (checked against pi-coding-agent 1.5.2,
 * `SessionManager._rewriteFile`). A changed first line therefore means start
 * over. An entry is skipped when it is not JSON, as Pi's loader does; a
 * trailing line without its newline is a write in progress and waits for it.
 */
const piRecordFold: JsonlFold<PiRecordState, PiSession | null> = {
  initial: () => ({
    header: null,
    invalid: false,
    messageCount: 0,
    lastStampedActivity: null,
    unstampedActivity: false,
    lastConversation: null,
    lastReply: null,
    prompts: [],
  }),
  apply: applyPiEntry,
  result: piSessionFromState,
  verifyFirstLine: true,
};

function scanTurnEntries(entries: unknown[]): JsonlTailScan<PiTurnReading> {
  let last: PiConversationEntry | null = null;
  for (const value of entries) {
    const entry = value as PiEntry | null;
    if (entry?.type !== 'message') {
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
  /** Parsed sessions keyed by file path, folded from appended bytes only. */
  private readonly records = new JsonlAppendReader(piRecordFold, CACHE_LIMIT);
  /** Record headers keyed by file path; a record never rewrites its header. */
  private readonly headerCache = new BoundedCache<string, PiHeader>(
    HEADER_CACHE_LIMIT
  );
  /** Session ID to record path, refreshed when a cached path disappears. */
  private readonly sessionPaths = new RecordPathCatalog(CACHE_LIMIT);
  /** Tail readings keyed by file path, invalidated by mtime+size. */
  private readonly tailCache = new StatCache<PiTurnReading | null>(
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

    return (
      this.readSettingsSessionDir(
        path.join(canonicalPath(cwd), '.pi', 'settings.json'),
        cwd
      ) ??
      this.readSettingsSessionDir(
        path.join(this.getAgentDirectory(cwd), 'settings.json'),
        cwd
      )
    );
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

  /**
   * Roots the session finder may read: the profile's sessions directory and
   * a flat `sessionDir` override, when one is configured. Grep/Glob recurse
   * through the per-cwd subdirectories, so listing them is unnecessary.
   */
  searchDirectories(): string[] {
    const dirs = new Set<string>();
    dirs.add(this.getSessionsRoot());
    const override = this.sessionDirOverride(process.cwd());
    if (override) {
      dirs.add(override);
    }
    return [...dirs];
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

  /**
   * Sessions in `dirs` whose cwd is one of `roots` or inside one, most
   * recently updated first. The directory match is a superset (a shared
   * `sessionDir` holds every project's records), so the header decides
   * before the record is parsed.
   */
  private async getSessionsInDirs(
    dirs: string[],
    roots: string[]
  ): Promise<PiSession[]> {
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
        const header = this.readHeader(filePath);
        if (!header || !roots.some((root) => isWithin(header.cwd, root))) {
          continue;
        }
        const session = await this.parseSessionFileCached(filePath);
        if (!session) {
          continue;
        }
        const existing = byId.get(session.sessionId);
        if (!existing || session.lastUpdated > existing.lastUpdated) {
          byId.set(session.sessionId, session);
        }
      }
    }

    return [...byId.values()].sort(
      (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime()
    );
  }

  /** Sessions whose cwd is the worktree or inside it. */
  async listSessionsForWorktree(
    worktreePath: string,
    force = false
  ): Promise<PiSession[]> {
    return this.getSessionsInDirs(
      this.getSessionDirsForPaths([worktreePath], force),
      [worktreePath]
    );
  }

  /** Sessions whose cwd is inside the repository root or any of its worktrees. */
  async listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<PiSession[]> {
    const roots = [repoRootPath, ...worktreePaths];
    return this.getSessionsInDirs(this.getSessionDirsForPaths(roots), roots);
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
    return this.sessionPaths.find(
      sessionId,
      () => this.scanForSessionFile(sessionId, cwd),
      missTtlMs
    );
  }

  private scanForSessionFile(sessionId: string, cwd?: string): string | null {
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
          this.readHeader(filePath)?.id === sessionId &&
          (!newest || stats.mtimeMs > newest.mtimeMs)
        ) {
          newest = { filePath, mtimeMs: stats.mtimeMs };
        }
      }
    }
    return newest?.filePath ?? null;
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
   * The record's session header, read from the first block rather than the
   * whole record. A file name is not trusted until its header confirms it.
   * Only a valid header is cached: a record whose header is not written yet
   * is read again on the next call.
   */
  private readHeader(filePath: string): PiHeader | null {
    const cached = this.headerCache.get(filePath);
    if (cached) {
      return cached;
    }
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
        return null;
      }
      const entry = JSON.parse(first) as PiEntry;
      if (
        entry.type !== 'session' ||
        typeof entry.id !== 'string' ||
        !entry.id ||
        typeof entry.cwd !== 'string' ||
        !entry.cwd
      ) {
        return null;
      }
      const header = { id: entry.id, cwd: entry.cwd };
      this.headerCache.set(filePath, header);
      return header;
    } catch {
      return null;
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

  /**
   * A session and the earliest prompt the user typed in it that begins with
   * `opening`, ignoring case and whitespace. The record is scanned for the
   * quote and then read through the shared parse cache; a record the tree
   * already parsed costs no second read.
   */
  async findSessionPrompt(
    sessionId: string,
    opening: string,
    cwd?: string
  ): Promise<{ session: PiSession; prompt?: PreviewMessage } | null> {
    const filePath = this.getSessionFilePath(sessionId, cwd);
    if (!filePath) {
      return null;
    }
    const needle = normalizeSpace(opening);
    let prompt: PreviewMessage | undefined;
    if (needle) {
      let stream: fs.ReadStream | undefined;
      try {
        stream = fs.createReadStream(filePath, 'utf-8');
        const lines = readline.createInterface({
          input: stream,
          crlfDelay: Infinity,
        });
        try {
          for await (const line of lines) {
            const entry = parseJsonLine(line);
            const user = piUserPrompt(entry);
            if (user && normalizeSpace(user.text).startsWith(needle)) {
              prompt = { text: user.text, timestamp: user.timestamp };
              break;
            }
          }
        } finally {
          lines.close();
        }
      } catch {
        // An unreadable record confirms nothing.
        return null;
      } finally {
        // Closing the reader leaves the file open; an early break must close it.
        stream?.destroy();
      }
    }

    const session = await this.getSessionById(sessionId, cwd);
    return session ? { session, prompt } : null;
  }

  /**
   * Turn state from a record tail, cached by mtime+size. The attention tick
   * reads the same records every few seconds; without this it would re-read
   * unchanged files.
   */
  async readTurnState(filePath: string): Promise<PiTurnReading | null> {
    // A null reading is a transient read failure; caching it would pin a
    // stale turn state until the record next changes.
    return this.tailCache.get(
      filePath,
      () => readJsonlTail(filePath, scanTurnEntries),
      { cacheNull: false }
    );
  }

  private parseSessionFileCached(filePath: string): Promise<PiSession | null> {
    return this.records.read(filePath);
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
    lastActivity: session.lastUpdated.getTime(),
    messageCount: session.messageCount,
    turnState: session.turnState,
    turnEndedAt: session.turnEndedAt,
    model: session.model,
  };
}
