import * as vscode from 'vscode';
import { Repository, ChatSession, HARNESS_IDS, HarnessId, SessionSearchEngine, SessionSearchRecord, STORAGE_KEYS, generateId } from '../types';
import { harnessSessionKey } from '../harnesses/sessionUtils';

/** How long a user removal keeps a session out of auto-import. */
const REMOVED_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Bound for the tombstone list; the oldest entries are evicted first. */
const REMOVED_SESSION_LIMIT = 500;
/** Finished session searches kept; the oldest are dropped first. */
const SESSION_SEARCH_LIMIT = 10;

interface RemovedSessionRecord {
  key: string;
  removedAt: number;
}

/** Shape of chats written before multi-harness support. */
type LegacyChatSession = Omit<ChatSession, 'harness' | 'harnessSessionId'> & {
  harness?: HarnessId;
  harnessSessionId?: string | null;
  claudeSessionId?: string | null;
};

/** Optional fields a new chat can start with. */
export type NewChatFields = Partial<
  Pick<
    ChatSession,
    | 'harnessSessionId'
    | 'forkedFromSessionId'
    | 'pendingUiLaunch'
    | 'autoImported'
    | 'createdAt'
    | 'lastAccessedAt'
  >
>;

/**
 * Agntree's persisted state in VS Code `globalState`. Stored shapes are a
 * compatibility surface: old shapes are read, migrated, and written back here,
 * never in callers.
 */
export class StorageService {
  constructor(private context: vscode.ExtensionContext) {}

  private get<T>(key: string, fallback: T): T {
    return this.context.globalState.get<T>(key, fallback);
  }

  private set(key: string, value: unknown): Thenable<void> {
    return this.context.globalState.update(key, value);
  }

  // Repositories. The stored array order is the tree order.

  getRepositories(includeHidden = false): Repository[] {
    const all = this.get<Repository[]>(STORAGE_KEYS.REPOSITORIES, []);
    return includeHidden ? all : all.filter((r) => !r.hidden);
  }

  getRepository(id: string): Repository | undefined {
    return this.getRepositories(true).find((r) => r.id === id);
  }

  /** Add a root, or return the stored one (reviving a legacy hidden entry). */
  addRepository(name: string, rootPath: string): Repository {
    const repositories = this.getRepositories(true);
    const existing = repositories.find((r) => r.rootPath === rootPath);
    if (existing) {
      if (existing.hidden) {
        existing.hidden = false;
        void this.set(STORAGE_KEYS.REPOSITORIES, repositories);
      }
      return existing;
    }

    const repo: Repository = { id: generateId(), name, rootPath };
    void this.set(STORAGE_KEYS.REPOSITORIES, [...repositories, repo]);
    return repo;
  }

  /**
   * Swap a repository with its nearest visible neighbor. Returns false when
   * there is none in that direction.
   */
  moveRepository(id: string, direction: 'up' | 'down'): boolean {
    const repositories = this.getRepositories(true);
    const index = repositories.findIndex((r) => r.id === id);
    if (index === -1) {
      return false;
    }

    const step = direction === 'up' ? -1 : 1;
    let neighbor = index + step;
    while (repositories[neighbor]?.hidden) {
      neighbor += step;
    }
    if (!repositories[neighbor]) {
      return false;
    }

    [repositories[index], repositories[neighbor]] = [repositories[neighbor], repositories[index]];
    void this.set(STORAGE_KEYS.REPOSITORIES, repositories);
    return true;
  }

  /** Forget a root's record. Callers forget its worktrees' chats first (ADR 0013). */
  removeRepository(id: string): void {
    void this.set(
      STORAGE_KEYS.REPOSITORIES,
      this.getRepositories(true).filter((r) => r.id !== id)
    );
  }

  // Chats

  /**
   * Every stored chat. Chats written before multi-harness support only have
   * `claudeSessionId`; they are migrated here so the rest of the extension
   * treats every chat generically.
   */
  getChats(): ChatSession[] {
    const stored = this.get<LegacyChatSession[]>(STORAGE_KEYS.CHATS, []);
    const isMigrated = (chat: LegacyChatSession): chat is ChatSession =>
      chat.harness !== undefined && chat.harnessSessionId !== undefined;

    if (stored.every(isMigrated)) {
      return [...stored];
    }

    const chats = stored.map((chat): ChatSession => {
      if (isMigrated(chat)) {
        return chat;
      }
      const { claudeSessionId, ...rest } = chat;
      return {
        ...rest,
        harness: chat.harness ?? 'claude',
        harnessSessionId: chat.harnessSessionId ?? claudeSessionId ?? null,
      };
    });
    void this.set(STORAGE_KEYS.CHATS, chats);
    return chats;
  }

  getChatsByWorktree(worktreeId: string): ChatSession[] {
    return this.getChats().filter((c) => c.worktreeId === worktreeId);
  }

  getChat(id: string): ChatSession | undefined {
    return this.getChats().find((c) => c.id === id);
  }

  /** Create a chat in one write, already carrying whatever it starts with. */
  createChat(
    worktreeId: string,
    harness: HarnessId,
    name: string,
    fields: NewChatFields = {}
  ): ChatSession {
    const now = Date.now();
    const chat: ChatSession = {
      id: generateId(),
      worktreeId,
      name,
      harness,
      harnessSessionId: null,
      createdAt: now,
      lastAccessedAt: now,
      status: 'idle',
      ...withoutUndefined(fields),
    };
    void this.set(STORAGE_KEYS.CHATS, [...this.getChats(), chat]);
    return chat;
  }

  updateChat(id: string, updates: Partial<ChatSession>): ChatSession | undefined {
    const chats = this.getChats();
    const index = chats.findIndex((c) => c.id === id);
    if (index === -1) {
      return undefined;
    }
    chats[index] = { ...chats[index], ...updates };
    void this.set(STORAGE_KEYS.CHATS, chats);
    return chats[index];
  }

  touchChat(id: string): void {
    this.updateChat(id, { lastAccessedAt: Date.now() });
  }

  deleteChat(id: string, options: { rememberSession?: boolean } = {}): void {
    this.deleteChats([id], options);
  }

  /**
   * Delete chats in one write and return the ids that existed. A user removal
   * leaves a tombstone so auto-import does not bring the session straight
   * back; other callers pass `rememberSession: false`.
   */
  deleteChats(ids: Iterable<string>, options: { rememberSession?: boolean } = {}): string[] {
    const idSet = new Set(ids);
    if (idSet.size === 0) {
      return [];
    }

    const chats = this.getChats();
    const removed = chats.filter((chat) => idSet.has(chat.id));
    if (options.rememberSession !== false) {
      for (const chat of removed) {
        if (chat.harnessSessionId) {
          this.rememberRemovedSession(chat.harness, chat.harnessSessionId);
        }
      }
    }
    void this.set(STORAGE_KEYS.CHATS, chats.filter((chat) => !idSet.has(chat.id)));
    // Forget every requested id: a pid record can outlive its chat.
    this.forgetTerminalPids(idSet);
    return removed.map((chat) => chat.id);
  }

  deleteChatsByWorktree(worktreeId: string, options: { rememberSession?: boolean } = {}): string[] {
    return this.deleteChats(this.getChatsByWorktree(worktreeId).map((chat) => chat.id), options);
  }

  // Removal tombstones: auto-import skips these sessions for the TTL.

  getRemovedSessionKeys(): Set<string> {
    return new Set(this.getRemovedSessionRecords().map((record) => record.key));
  }

  rememberRemovedSession(harness: HarnessId, sessionId: string): void {
    const key = harnessSessionKey(harness, sessionId);
    void this.set(
      STORAGE_KEYS.REMOVED_SESSIONS,
      [...this.removedRecordsWithout(key), { key, removedAt: Date.now() }].slice(-REMOVED_SESSION_LIMIT)
    );
  }

  /** A manual import is the user undoing a removal, so let future scans see it. */
  forgetRemovedSession(harness: HarnessId, sessionId: string): void {
    void this.set(
      STORAGE_KEYS.REMOVED_SESSIONS,
      this.removedRecordsWithout(harnessSessionKey(harness, sessionId))
    );
  }

  private removedRecordsWithout(key: string): RemovedSessionRecord[] {
    return this.getRemovedSessionRecords().filter((record) => record.key !== key);
  }

  /** Valid, unexpired tombstones; expired or malformed ones are pruned. */
  private getRemovedSessionRecords(): RemovedSessionRecord[] {
    const stored = this.get<RemovedSessionRecord[]>(STORAGE_KEYS.REMOVED_SESSIONS, []);
    const cutoff = Date.now() - REMOVED_SESSION_TTL_MS;
    const records = stored
      .filter(
        (record) =>
          typeof record?.key === 'string' &&
          typeof record.removedAt === 'number' &&
          record.removedAt >= cutoff
      )
      .slice(-REMOVED_SESSION_LIMIT);
    if (records.length !== stored.length) {
      void this.set(STORAGE_KEYS.REMOVED_SESSIONS, records);
    }
    return records;
  }

  // Selection, PR checkouts, stars

  getActiveChatId(): string | undefined {
    return this.get<string | undefined>(STORAGE_KEYS.ACTIVE_CHAT, undefined);
  }

  setActiveChatId(chatId: string | undefined): void {
    void this.set(STORAGE_KEYS.ACTIVE_CHAT, chatId);
  }

  /** The PR a worktree was checked out from, by worktree id. */
  getPRWorktree(worktreeId: string): number | undefined {
    return this.get<Record<string, number>>(STORAGE_KEYS.PR_WORKTREES, {})[worktreeId];
  }

  setPRWorktree(worktreeId: string, prNumber: number): void {
    this.updatePRWorktrees((map) => {
      map[worktreeId] = prNumber;
    });
  }

  removePRWorktree(worktreeId: string): void {
    this.updatePRWorktrees((map) => {
      delete map[worktreeId];
    });
  }

  private updatePRWorktrees(change: (map: Record<string, number>) => void): void {
    const map = { ...this.get<Record<string, number>>(STORAGE_KEYS.PR_WORKTREES, {}) };
    change(map);
    void this.set(STORAGE_KEYS.PR_WORKTREES, map);
  }

  getStarredChatIds(): Set<string> {
    return new Set(this.get<string[]>(STORAGE_KEYS.STARRED_CHATS, []));
  }

  isStarred(chatId: string): boolean {
    return this.getStarredChatIds().has(chatId);
  }

  /** Returns whether the chat is starred afterwards. */
  toggleStar(chatId: string): boolean {
    const starred = this.getStarredChatIds();
    const nowStarred = !starred.delete(chatId);
    if (nowStarred) {
      starred.add(chatId);
    }
    void this.set(STORAGE_KEYS.STARRED_CHATS, Array.from(starred));
    return nowStarred;
  }

  getStarredChats(): ChatSession[] {
    const starredIds = this.getStarredChatIds();
    return this.getChats().filter((c) => starredIds.has(c.id));
  }

  // Session searches

  /** Finished searches, newest first. A malformed record is skipped. */
  getSessionSearches(): SessionSearchRecord[] {
    const stored = this.get<unknown>(STORAGE_KEYS.SESSION_SEARCHES, []);
    if (!Array.isArray(stored)) {
      return [];
    }
    // A newer build may have stored a harness this one does not know; its
    // sessions cannot be shown or resumed here, so they are left out.
    return stored.filter(isSessionSearchRecord).map((search) => {
      const matches = search.matches.filter((match) => isHarnessId(match.harness));
      return matches.length === search.matches.length ? search : { ...search, matches };
    });
  }

  /** Keep a finished search ahead of the others, within the limit. */
  saveSessionSearch(search: SessionSearchRecord): Thenable<void> {
    const others = this.getSessionSearches().filter((stored) => stored.id !== search.id);
    return this.set(STORAGE_KEYS.SESSION_SEARCHES, [search, ...others].slice(0, SESSION_SEARCH_LIMIT));
  }

  removeSessionSearches(ids: Iterable<string>): Thenable<void> {
    const removed = new Set(ids);
    return this.set(
      STORAGE_KEYS.SESSION_SEARCHES,
      this.getSessionSearches().filter((search) => !removed.has(search.id))
    );
  }

  /** The harness a saved model/effort choice belongs to. */
  getSessionSearchEngineChoice(): SessionSearchEngine | undefined {
    const stored = this.get<unknown>(STORAGE_KEYS.SESSION_SEARCH_ENGINE_CHOICE, undefined);
    return isSessionSearchEngine(stored) ? stored : undefined;
  }

  saveSessionSearchEngineChoice(engine: SessionSearchEngine): Thenable<void> {
    return this.set(STORAGE_KEYS.SESSION_SEARCH_ENGINE_CHOICE, engine);
  }

  // Restored terminals (ADR 0009)

  /**
   * The workspace folder whose terminals this window owns. Agntree keeps one
   * workspace folder per window (`autoSwitchWorkspaceFolder` replaces the
   * folder list), so the first folder identifies the workspace.
   */
  private workspaceKey(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  /**
   * Recorded terminal PIDs by workspace folder. Kept in `globalState`, not
   * `workspaceState`: switching the workspace folder gives VS Code a fresh
   * workspace store, which would erase the identity of the terminals Agntree
   * left running.
   */
  private getTerminalPidRecords(): Record<string, Record<string, number>> {
    return this.get<Record<string, Record<string, number>>>(STORAGE_KEYS.TERMINAL_PIDS, {});
  }

  /**
   * PIDs this workspace last saw for chats it launched, by chat ID. An entry
   * proves the workspace owned the terminal; its PID tells a live agent from
   * a shell VS Code revived after a quit.
   */
  getTerminalPids(): Record<string, number> {
    const key = this.workspaceKey();
    const records = this.getTerminalPidRecords();
    if (records[key]) {
      return records[key];
    }

    // One-time migration from the workspace-scoped shape of earlier builds.
    // Without it the first reload after upgrading would forget every running
    // terminal and could launch a second agent.
    const legacy = this.context.workspaceState.get<Record<string, number>>(STORAGE_KEYS.TERMINAL_PIDS, {});
    if (Object.keys(legacy).length === 0) {
      return {};
    }
    void this.set(STORAGE_KEYS.TERMINAL_PIDS, { ...records, [key]: legacy });
    void this.context.workspaceState.update(STORAGE_KEYS.TERMINAL_PIDS, undefined);
    return legacy;
  }

  /**
   * Record the PID this workspace saw for a chat. Kept on terminal close,
   * because VS Code fires close events on quit and the next activation needs
   * the old PID as proof that a revived shell is not the live agent.
   */
  async rememberTerminalPid(chatId: string, pid: number): Promise<void> {
    const pids = this.getTerminalPids();
    if (pids[chatId] === pid) {
      return;
    }
    await this.set(STORAGE_KEYS.TERMINAL_PIDS, {
      ...this.getTerminalPidRecords(),
      [this.workspaceKey()]: { ...pids, [chatId]: pid },
    });
  }

  /** Drop terminal identity for deleted chats, in every workspace. */
  private forgetTerminalPids(chatIds: Set<string>): void {
    const records = this.getTerminalPidRecords();
    let changed = false;
    const pruned = Object.fromEntries(
      Object.entries(records).map(([workspace, pids]) => {
        const kept = Object.fromEntries(Object.entries(pids).filter(([chatId]) => !chatIds.has(chatId)));
        changed ||= Object.keys(kept).length !== Object.keys(pids).length;
        return [workspace, kept];
      })
    );
    if (changed) {
      void this.set(STORAGE_KEYS.TERMINAL_PIDS, pruned);
    }
  }
}

function withoutUndefined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function isSessionSearchRecord(value: unknown): value is SessionSearchRecord {
  const record = value as Partial<SessionSearchRecord> | null;
  return (
    typeof record?.id === 'string' &&
    typeof record.query === 'string' &&
    isHarnessId(record.engine?.harness) &&
    Array.isArray(record.matches) &&
    Array.isArray(record.activity)
  );
}

function isSessionSearchEngine(value: unknown): value is SessionSearchEngine {
  const engine = value as Partial<SessionSearchEngine> | null;
  return (
    isHarnessId(engine?.harness) &&
    typeof engine.model === 'string' &&
    typeof engine.effort === 'string'
  );
}

function isHarnessId(value: unknown): value is HarnessId {
  return (HARNESS_IDS as readonly unknown[]).includes(value);
}
