import * as vscode from 'vscode';
import { Repository, ChatSession, HarnessId, STORAGE_KEYS, generateId } from '../types';

/** Shape of chats written before multi-harness support. */
type LegacyChatSession = Omit<ChatSession, 'harness' | 'harnessSessionId'> & {
  harness?: HarnessId;
  harnessSessionId?: string | null;
  claudeSessionId?: string | null;
};

/**
 * Service for persisting data using VS Code's globalState
 */
export class StorageService {
  constructor(private context: vscode.ExtensionContext) {}

  // ============ Repository Operations ============

  /**
   * Get all stored repositories (excluding hidden by default)
   */
  getRepositories(includeHidden: boolean = false): Repository[] {
    const all = this.context.globalState.get<Repository[]>(STORAGE_KEYS.REPOSITORIES, []);
    if (includeHidden) {
      return all;
    }
    return all.filter((r) => !r.hidden);
  }

  /**
   * Get hidden repositories only
   */
  getHiddenRepositories(): Repository[] {
    const all = this.context.globalState.get<Repository[]>(STORAGE_KEYS.REPOSITORIES, []);
    return all.filter((r) => r.hidden);
  }

  /**
   * Get a repository by ID
   */
  getRepository(id: string): Repository | undefined {
    return this.getRepositories(true).find((r) => r.id === id);
  }

  /**
   * Add a new repository
   */
  addRepository(name: string, rootPath: string): Repository {
    const repositories = this.getRepositories(true);

    // Check if already exists (including hidden)
    const existing = repositories.find((r) => r.rootPath === rootPath);
    if (existing) {
      // If it was hidden, unhide it
      if (existing.hidden) {
        this.unhideRepository(existing.id);
        existing.hidden = false;
      }
      return existing;
    }

    const repo: Repository = {
      id: generateId(),
      name,
      rootPath,
      hidden: false,
    };

    repositories.push(repo);
    this.context.globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);

    return repo;
  }

  /**
   * Hide a repository (soft remove - keeps data)
   */
  hideRepository(id: string): void {
    const repositories = this.getRepositories(true);
    const index = repositories.findIndex((r) => r.id === id);
    if (index !== -1) {
      repositories[index].hidden = true;
      this.context.globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);
    }
  }

  /**
   * Unhide a repository
   */
  unhideRepository(id: string): void {
    const repositories = this.getRepositories(true);
    const index = repositories.findIndex((r) => r.id === id);
    if (index !== -1) {
      repositories[index].hidden = false;
      this.context.globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);
    }
  }

  /**
   * Move a repository one visible position up or down. The stored array order
   * is the tree order, so this only swaps the entry with its nearest visible
   * neighbor; hidden repositories are skipped.
   *
   * Returns false when there is no visible neighbor in that direction.
   */
  moveRepository(id: string, direction: 'up' | 'down'): boolean {
    const repositories = [...this.getRepositories(true)];
    const index = repositories.findIndex((r) => r.id === id);
    if (index === -1) {
      return false;
    }

    const step = direction === 'up' ? -1 : 1;
    let neighbor = index + step;
    while (neighbor >= 0 && neighbor < repositories.length && repositories[neighbor].hidden) {
      neighbor += step;
    }
    if (neighbor < 0 || neighbor >= repositories.length) {
      return false;
    }

    [repositories[index], repositories[neighbor]] = [repositories[neighbor], repositories[index]];
    this.context.globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);
    return true;
  }

  /**
   * Remove a repository permanently (hard delete)
   */
  removeRepository(id: string): void {
    const repositories = this.getRepositories(true).filter((r) => r.id !== id);
    this.context.globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);

    // Note: Chat sessions are preserved - they can be re-imported if repo is re-added
  }

  // ============ Chat Operations ============

  /**
   * Get all stored chat sessions.
   *
   * Chats written by older versions only have `claudeSessionId`; migrate them
   * on read so the rest of the extension can treat every chat generically.
   */
  getChats(): ChatSession[] {
    const stored = this.context.globalState.get<LegacyChatSession[]>(STORAGE_KEYS.CHATS, []);
    const isMigrated = (chat: LegacyChatSession): chat is ChatSession =>
      chat.harness !== undefined && chat.harnessSessionId !== undefined;

    if (stored.every(isMigrated)) {
      return [...stored];
    }

    const chats: ChatSession[] = stored.map((chat) => {
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

    void this.context.globalState.update(STORAGE_KEYS.CHATS, chats);
    return chats;
  }

  /**
   * Get chats for a specific worktree
   */
  getChatsByWorktree(worktreeId: string): ChatSession[] {
    return this.getChats().filter((c) => c.worktreeId === worktreeId);
  }

  /**
   * Get a chat by ID
   */
  getChat(id: string): ChatSession | undefined {
    return this.getChats().find((c) => c.id === id);
  }

  /**
   * Create a new chat session
   */
  createChat(
    worktreeId: string,
    name: string,
    baseCommit: string | null = null,
    harness: HarnessId = 'claude'
  ): ChatSession {
    const chats = this.getChats();

    const chat: ChatSession = {
      id: generateId(),
      worktreeId,
      name,
      harness,
      harnessSessionId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      status: 'idle',
      baseCommit,
    };

    chats.push(chat);
    this.context.globalState.update(STORAGE_KEYS.CHATS, chats);

    return chat;
  }

  /**
   * Update an existing chat session
   */
  updateChat(id: string, updates: Partial<ChatSession>): ChatSession | undefined {
    const chats = this.getChats();
    const index = chats.findIndex((c) => c.id === id);

    if (index === -1) {
      return undefined;
    }

    chats[index] = { ...chats[index], ...updates };
    this.context.globalState.update(STORAGE_KEYS.CHATS, chats);

    return chats[index];
  }

  /**
   * Delete a chat session
   */
  deleteChat(id: string): void {
    const chats = this.getChats().filter((c) => c.id !== id);
    this.context.globalState.update(STORAGE_KEYS.CHATS, chats);
    this.forgetTerminalPids([id]);
  }

  /**
   * Delete all chat sessions for a worktree
   * Returns the IDs of deleted chats
   */
  deleteChatsByWorktree(worktreeId: string): string[] {
    const chats = this.getChats();
    const deletedIds = chats.filter((c) => c.worktreeId === worktreeId).map((c) => c.id);
    const remainingChats = chats.filter((c) => c.worktreeId !== worktreeId);
    this.context.globalState.update(STORAGE_KEYS.CHATS, remainingChats);
    this.forgetTerminalPids(deletedIds);
    return deletedIds;
  }

  /**
   * Rename a chat session
   */
  renameChat(id: string, newName: string): ChatSession | undefined {
    return this.updateChat(id, { name: newName });
  }

  /**
   * Mark chat as accessed (updates lastAccessedAt)
   */
  touchChat(id: string): void {
    this.updateChat(id, { lastAccessedAt: Date.now() });
  }

  // ============ Active Chat ============

  /**
   * Get the currently active chat ID
   */
  getActiveChatId(): string | undefined {
    return this.context.globalState.get<string>(STORAGE_KEYS.ACTIVE_CHAT);
  }

  /**
   * Set the currently active chat
   */
  setActiveChatId(chatId: string | undefined): void {
    this.context.globalState.update(STORAGE_KEYS.ACTIVE_CHAT, chatId);
  }

  /**
   * Get the currently active worktree ID
   */
  getActiveWorktreeId(): string | undefined {
    return this.context.globalState.get<string>(STORAGE_KEYS.ACTIVE_WORKTREE_ID);
  }

  /**
   * Set the currently active worktree ID
   */
  setActiveWorktreeId(worktreeId: string | undefined): void {
    this.context.globalState.update(STORAGE_KEYS.ACTIVE_WORKTREE_ID, worktreeId);
  }

  // ============ PR Worktrees ============

  /**
   * Get PR number for a worktree (if it was checked out via PR checkout)
   */
  getPRWorktree(worktreeId: string): number | undefined {
    const map = this.context.globalState.get<Record<string, number>>(STORAGE_KEYS.PR_WORKTREES, {});
    return map[worktreeId];
  }

  /**
   * Mark a worktree as checked out from a PR
   */
  setPRWorktree(worktreeId: string, prNumber: number): void {
    const map = this.context.globalState.get<Record<string, number>>(STORAGE_KEYS.PR_WORKTREES, {});
    map[worktreeId] = prNumber;
    this.context.globalState.update(STORAGE_KEYS.PR_WORKTREES, map);
  }

  /**
   * Remove PR association for a worktree
   */
  removePRWorktree(worktreeId: string): void {
    const map = this.context.globalState.get<Record<string, number>>(STORAGE_KEYS.PR_WORKTREES, {});
    delete map[worktreeId];
    this.context.globalState.update(STORAGE_KEYS.PR_WORKTREES, map);
  }

  // ============ Starred Sessions ============

  getStarredChatIds(): Set<string> {
    const ids = this.context.globalState.get<string[]>(STORAGE_KEYS.STARRED_CHATS, []);
    return new Set(ids);
  }

  isStarred(chatId: string): boolean {
    return this.getStarredChatIds().has(chatId);
  }

  toggleStar(chatId: string): boolean {
    const starred = this.getStarredChatIds();
    const nowStarred = !starred.has(chatId);
    if (nowStarred) {
      starred.add(chatId);
    } else {
      starred.delete(chatId);
    }
    this.context.globalState.update(STORAGE_KEYS.STARRED_CHATS, Array.from(starred));
    return nowStarred;
  }

  getStarredChats(): ChatSession[] {
    const starredIds = this.getStarredChatIds();
    return this.getChats().filter((c) => starredIds.has(c.id));
  }

  // ============ Restored Terminals ============

  /**
   * The workspace folder whose terminals this window owns. Agntree keeps one
   * workspace folder per window (`autoSwitchWorkspaceFolder` replaces the
   * folder list), so the first folder identifies the workspace.
   */
  private workspaceKey(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  }

  /**
   * All recorded terminal PIDs, scoped by workspace folder.
   *
   * This lives in `globalState`, not `workspaceState`: switching the workspace
   * folder gives VS Code a fresh workspace store, and Agntree's own
   * `autoSwitchWorkspaceFolder` would otherwise erase the identity of the
   * terminals it left running. The record still describes one workspace's
   * terminal, so lookups are filtered by the folder this window has open.
   */
  private getTerminalPidRecords(): Record<string, Record<string, number>> {
    return this.context.globalState.get<Record<string, Record<string, number>>>(
      STORAGE_KEYS.TERMINAL_PIDS,
      {}
    );
  }

  /**
   * PIDs this workspace last saw for chats it launched, keyed by chat ID.
   * The presence of an entry proves the workspace owned the terminal, and its
   * PID distinguishes a live agent from a shell VS Code revived after a quit.
   */
  getTerminalPids(): Record<string, number> {
    const key = this.workspaceKey();
    const records = this.getTerminalPidRecords();
    if (records[key]) {
      return records[key];
    }

    // One-time migration from the workspace-scoped shape used by earlier
    // development builds. Without it the first reload after upgrading would
    // forget every running terminal and could launch a second agent.
    const legacy = this.context.workspaceState.get<Record<string, number>>(
      STORAGE_KEYS.TERMINAL_PIDS,
      {}
    );
    if (Object.keys(legacy).length === 0) {
      return {};
    }
    records[key] = legacy;
    void this.context.globalState.update(STORAGE_KEYS.TERMINAL_PIDS, records);
    void this.context.workspaceState.update(STORAGE_KEYS.TERMINAL_PIDS, undefined);
    return legacy;
  }

  /**
   * Record the PID this workspace saw for a chat. Kept on terminal close,
   * because VS Code fires close events on quit and the next activation needs
   * the old PID as proof that a revived shell is not the live agent.
   */
  async rememberTerminalPid(chatId: string, pid: number): Promise<void> {
    const key = this.workspaceKey();
    const pids = this.getTerminalPids();
    if (pids[chatId] === pid) {
      return;
    }
    const records = this.getTerminalPidRecords();
    records[key] = { ...pids, [chatId]: pid };
    await this.context.globalState.update(STORAGE_KEYS.TERMINAL_PIDS, records);
  }

  /**
   * Drop terminal identity for chats that no longer exist, in every workspace
   * that recorded one.
   */
  private forgetTerminalPids(chatIds: string[]): void {
    const records = this.getTerminalPidRecords();
    let changed = false;
    for (const pids of Object.values(records)) {
      for (const chatId of chatIds) {
        if (chatId in pids) {
          delete pids[chatId];
          changed = true;
        }
      }
    }
    if (changed) {
      void this.context.globalState.update(STORAGE_KEYS.TERMINAL_PIDS, records);
    }
  }

  // ============ Cleanup ============

  /**
   * Remove orphaned chats (chats whose worktrees no longer exist)
   */
  cleanupOrphanedChats(validWorktreeIds: string[]): number {
    const chats = this.getChats();
    const validChats = chats.filter((c) => validWorktreeIds.includes(c.worktreeId));
    const removed = chats.length - validChats.length;

    if (removed > 0) {
      this.context.globalState.update(STORAGE_KEYS.CHATS, validChats);
    }

    return removed;
  }
}
