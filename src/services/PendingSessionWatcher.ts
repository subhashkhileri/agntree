import * as vscode from 'vscode';
import { StorageService } from './StorageService';
import { ChatSession, HarnessId } from '../types';
import {
  HarnessAdapter,
  HarnessSession,
  HarnessSessionWatcher,
} from '../harnesses/types';
import {
  ChatNameUpdatedEvent,
  findClaimableSession,
  linkedSessionIds,
  renameChatFromSummary,
  snapshotSessionIds,
} from '../harnesses/sessionUtils';

export interface PendingChat {
  chatId: string;
  worktreePath: string;
  /** Sessions created at/after this moment are candidates. */
  since: number;
  /** Pre-existing sessions; null until the snapshot has been taken. */
  knownSessionIds: Set<string> | null;
}

export interface PendingSessionWatcherOptions {
  pollIntervalMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const PENDING_TTL_MS = 5 * 60_000;

/**
 * Links newly launched native sessions to their Agntree chat.
 *
 * Harnesses that assign session IDs in a separate process cannot create a
 * resumable chat up front. The chat launches the TUI in a terminal, and this
 * poller snapshots the sessions that already exist, then claims the oldest
 * unseen session created after the chat was registered. Subclasses supply the
 * harness and any naming fallback; the claim, TTL, and rename rules live here
 * once.
 */
export abstract class PendingSessionWatcher implements HarnessSessionWatcher {
  readonly harness: HarnessId;

  protected readonly pendingChats = new Map<string, PendingChat>();
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | undefined;
  private ticking = false;

  private readonly _onChatNameUpdated =
    new vscode.EventEmitter<ChatNameUpdatedEvent>();
  public readonly onChatNameUpdated = this._onChatNameUpdated.event;

  protected constructor(
    harness: HarnessId,
    protected readonly storageService: StorageService,
    protected readonly adapter: HarnessAdapter,
    options: PendingSessionWatcherOptions = {}
  ) {
    this.harness = harness;
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  startWatching(): void {
    // The poller starts with the first pending chat and stops when none remain.
  }

  async registerPendingChat(chatId: string, worktreePath: string): Promise<void> {
    // Re-registration while the baseline is still fresh must not move the
    // snapshot forward: the launched session may already be in it, and
    // resetting it would make that session unclaimable. Only a stale entry (or
    // one for another worktree) starts a new window.
    const existing = this.pendingChats.get(chatId);
    const stale =
      existing !== undefined &&
      Date.now() - existing.since >= PENDING_TTL_MS;
    if (!existing || stale || existing.worktreePath !== worktreePath) {
      this.pendingChats.set(chatId, {
        chatId,
        worktreePath,
        since: Date.now(),
        knownSessionIds: null,
      });
    }

    this.ensurePoller();

    await this.primeKnownSessions(chatId);
    this.pruneExpired();
  }

  /**
   * Snapshot existing sessions first so an old session in the same worktree is
   * never mistaken for the one the user just launched.
   */
  private async primeKnownSessions(chatId: string): Promise<void> {
    const pending = this.pendingChats.get(chatId);
    if (!pending || pending.knownSessionIds) {
      return;
    }

    try {
      const sessions = await this.snapshot(pending.worktreePath);
      const current = this.pendingChats.get(chatId);
      if (current && !current.knownSessionIds) {
        current.knownSessionIds = new Set(snapshotSessionIds(sessions));
      }
    } catch (error) {
      console.error(
        `[${this.logLabel}] Failed to list sessions for ${pending.worktreePath}:`,
        error
      );
    }
  }

  private async poll(): Promise<void> {
    if (this.ticking) {
      return;
    }
    if (this.pendingChats.size === 0) {
      this.stopPoller();
      return;
    }
    this.ticking = true;

    try {
      // One storage read per tick; updateChat keeps this map current.
      const chatsById = this.loadChats();
      this.pruneExpired(chatsById);
      if (this.pendingChats.size === 0) {
        return;
      }

      const byWorktree = new Map<string, PendingChat[]>();
      for (const pending of this.pendingChats.values()) {
        const group = byWorktree.get(pending.worktreePath) ?? [];
        group.push(pending);
        byWorktree.set(pending.worktreePath, group);
      }

      // Fetch worktrees together so single-flight adapters share one list.
      const snapshots = await Promise.all(
        Array.from(byWorktree, async ([worktreePath, chats]) => {
          try {
            return { chats, sessions: await this.snapshot(worktreePath) };
          } catch (error) {
            console.error(
              `[${this.logLabel}] Failed to poll ${worktreePath}:`,
              error
            );
            return undefined;
          }
        })
      );

      for (const snapshot of snapshots) {
        if (!snapshot) {
          continue;
        }

        // Retry registrations whose first snapshot failed, reusing this one
        // instead of spawning another list per pending chat.
        for (const pending of snapshot.chats) {
          if (!pending.knownSessionIds) {
            pending.knownSessionIds = new Set(
              snapshotSessionIds(snapshot.sessions)
            );
          }
        }

        this.processWorktree(
          snapshot.chats,
          snapshot.sessions,
          chatsById
        );
      }
    } finally {
      this.ticking = false;
      if (this.pendingChats.size === 0) {
        this.stopPoller();
      }
    }
  }

  private ensurePoller(): void {
    if (this.pollTimer || this.pendingChats.size === 0) {
      return;
    }
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs);
  }

  private stopPoller(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private snapshot(worktreePath: string): Promise<HarnessSession[]> {
    return this.adapter.listSessionsForWorktree(worktreePath, true);
  }

  private loadChats(): Map<string, ChatSession> {
    return new Map(
      this.storageService.getChats().map((chat) => [chat.id, chat])
    );
  }

  private processWorktree(
    chats: PendingChat[],
    sessions: HarnessSession[],
    chatsById: Map<string, ChatSession>
  ): void {
    const claimed = new Set<string>();
    const linked = linkedSessionIds(chatsById.values(), this.harness);
    const sessionsById = new Map(
      sessions.map((session) => [session.sessionId, session])
    );

    for (const pending of chats) {
      if (!this.pendingChats.has(pending.chatId) || !pending.knownSessionIds) {
        continue;
      }

      let chat = chatsById.get(pending.chatId);
      if (!chat) {
        this.pendingChats.delete(pending.chatId);
        continue;
      }

      let linkedSessionId = chat.harnessSessionId;
      if (!linkedSessionId) {
        // Claim the oldest unseen session so two chats started together are
        // linked in launch order.
        const knownSessionIds = pending.knownSessionIds;
        const match = findClaimableSession(
          sessions,
          pending.since,
          (sessionId) =>
            knownSessionIds.has(sessionId) ||
            claimed.has(sessionId) ||
            linked.has(sessionId)
        );

        if (!match) {
          continue;
        }

        linkedSessionId = match.sessionId;
        claimed.add(linkedSessionId);
        const updated = this.storageService.updateChat(pending.chatId, {
          harnessSessionId: linkedSessionId,
        });
        if (!updated) {
          this.pendingChats.delete(pending.chatId);
          continue;
        }
        chat = updated;
        chatsById.set(pending.chatId, updated);
        linked.add(linkedSessionId);
        console.log(
          `[${this.logLabel}] Linked session ${linkedSessionId} to chat ${pending.chatId}`
        );
      }

      const session = sessionsById.get(linkedSessionId);
      this.tryNameChat(pending, chat, session?.summary ?? null);
    }
  }

  private tryNameChat(
    pending: PendingChat,
    chat: ChatSession,
    summary: string | null
  ): void {
    if (!chat.name.startsWith('New Session')) {
      this.pendingChats.delete(pending.chatId);
      return;
    }

    const name = summary?.trim();
    if (name) {
      this.renameChat(pending.chatId, name);
      this.pendingChats.delete(pending.chatId);
      return;
    }

    this.handleUnnamed(pending, chat);
  }

  /**
   * Hook for harnesses that can name a session without a summary. The default
   * leaves the chat pending until the TTL or a later summary.
   */
  protected handleUnnamed(_pending: PendingChat, _chat: ChatSession): void {}

  protected renameChat(chatId: string, name: string): void {
    renameChatFromSummary(
      this.storageService,
      this._onChatNameUpdated,
      chatId,
      name
    );
  }

  private pruneExpired(
    chatsById: Map<string, ChatSession> = this.loadChats()
  ): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [chatId, pending] of this.pendingChats) {
      if (pending.since < cutoff || !chatsById.has(chatId)) {
        this.pendingChats.delete(chatId);
      }
    }
  }

  private get logLabel(): string {
    return `${this.harness[0].toUpperCase()}${this.harness.slice(1)}SessionWatcher`;
  }

  dispose(): void {
    this.stopPoller();
    this.pendingChats.clear();
    this._onChatNameUpdated.dispose();
  }
}
