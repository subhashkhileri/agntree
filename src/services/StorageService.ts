import * as vscode from 'vscode';
import { Repository, ChatSession, STORAGE_KEYS, generateId } from '../types';

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
   * Remove a repository permanently (hard delete)
   */
  removeRepository(id: string): void {
    const repositories = this.getRepositories(true).filter((r) => r.id !== id);
    this.context.globalState.update(STORAGE_KEYS.REPOSITORIES, repositories);

    // Note: Chat sessions are preserved - they can be re-imported if repo is re-added
  }

  // ============ Chat Operations ============

  /**
   * Get all stored chat sessions
   */
  getChats(): ChatSession[] {
    return this.context.globalState.get<ChatSession[]>(STORAGE_KEYS.CHATS, []);
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
  createChat(worktreeId: string, name: string, baseCommit: string | null = null): ChatSession {
    const chats = this.getChats();

    const chat: ChatSession = {
      id: generateId(),
      worktreeId,
      name,
      claudeSessionId: null,
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
