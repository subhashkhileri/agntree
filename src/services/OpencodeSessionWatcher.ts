import * as vscode from 'vscode';
import { StorageService } from './StorageService';
import { ChatSession, HarnessId } from '../types';
import { HarnessSession, HarnessSessionWatcher } from '../harnesses/types';
import { OpencodeHarness } from '../harnesses/OpencodeHarness';
import { truncateName } from '../utils/text';

interface PendingChat {
  chatId: string;
  worktreePath: string;
  /** Session created at/after this moment is considered a candidate. */
  since: number;
  /** Pre-existing sessions; null until the snapshot has been taken. */
  knownSessionIds: Set<string> | null;
  /** True while the prompt-based name fallback is in flight. */
  namingFromPrompt: boolean;
}

const POLL_INTERVAL_MS = 3_000;
const PENDING_TTL_MS = 5 * 60_000;
const CREATED_SLACK_MS = 2_000;
const PROMPT_FALLBACK_DELAY_MS = 30_000;

/**
 * Links newly launched opencode sessions to their Agntree chat.
 *
 * opencode owns its session IDs, so unlike Claude we cannot predict them. We
 * poll the session list while a chat is pending and claim the first top-level
 * session that appears in the worktree directory.
 */
export class OpencodeSessionWatcher implements HarnessSessionWatcher {
  readonly harness: HarnessId = 'opencode';

  private readonly pendingChats = new Map<string, PendingChat>();
  private pollTimer: NodeJS.Timeout | undefined;
  private ticking = false;

  private readonly _onChatNameUpdated = new vscode.EventEmitter<{
    chatId: string;
    name: string;
  }>();
  public readonly onChatNameUpdated = this._onChatNameUpdated.event;

  constructor(
    private readonly storageService: StorageService,
    private readonly adapter: OpencodeHarness
  ) {}

  startWatching(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, POLL_INTERVAL_MS);
  }

  registerPendingChat(chatId: string, worktreePath: string): void {
    this.pendingChats.set(chatId, {
      chatId,
      worktreePath,
      since: Date.now(),
      knownSessionIds: null,
      namingFromPrompt: false,
    });

    void this.primeKnownSessions(chatId);
    this.pruneExpired();
  }

  /**
   * Snapshot the sessions that already exist so a stale session can never be
   * mistaken for the one the user just launched.
   */
  private async primeKnownSessions(chatId: string): Promise<void> {
    const pending = this.pendingChats.get(chatId);
    if (!pending || pending.knownSessionIds) {
      return;
    }

    try {
      const sessions = await this.adapter.listSessionsForWorktree(
        pending.worktreePath,
        true
      );
      const current = this.pendingChats.get(chatId);
      if (current && !current.knownSessionIds) {
        current.knownSessionIds = new Set(
          sessions.map((session) => session.sessionId)
        );
      }
    } catch (error) {
      console.error(
        `[OpencodeSessionWatcher] Failed to list sessions for ${pending.worktreePath}:`,
        error
      );
    }
  }

  private async poll(): Promise<void> {
    if (this.ticking || this.pendingChats.size === 0) {
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

      for (const [worktreePath, chats] of byWorktree) {
        let sessions: HarnessSession[];
        try {
          sessions = await this.adapter.listSessionsForWorktree(worktreePath, true);
        } catch (error) {
          console.error(
            `[OpencodeSessionWatcher] Failed to poll ${worktreePath}:`,
            error
          );
          continue;
        }

        // Reuse this snapshot to retry registrations whose first snapshot
        // failed, instead of spawning another list per pending chat.
        for (const pending of chats) {
          if (!pending.knownSessionIds) {
            pending.knownSessionIds = new Set(
              sessions.map((session) => session.sessionId)
            );
          }
        }

        this.processWorktree(chats, sessions, chatsById);
      }
    } finally {
      this.ticking = false;
    }
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
    const sessionsById = new Map(
      sessions.map((session) => [session.sessionId, session])
    );

    for (const pending of chats) {
      if (!this.pendingChats.has(pending.chatId) || !pending.knownSessionIds) {
        continue;
      }

      const chat = chatsById.get(pending.chatId);
      if (!chat) {
        this.pendingChats.delete(pending.chatId);
        continue;
      }

      let linkedSessionId = chat.harnessSessionId;
      if (!linkedSessionId) {
        // The list is newest-first; claim the oldest unseen session so two
        // quickly-created sessions are linked in launch order.
        let match: HarnessSession | undefined;
        let matchCreated = 0;
        for (const session of sessions) {
          if (pending.knownSessionIds.has(session.sessionId)) {
            continue;
          }
          if (claimed.has(session.sessionId)) {
            continue;
          }
          const created = session.lastUpdated?.getTime() ?? 0;
          if (created < pending.since - CREATED_SLACK_MS) {
            continue;
          }
          if (!match || created < matchCreated) {
            match = session;
            matchCreated = created;
          }
        }

        if (!match) {
          continue;
        }

        linkedSessionId = match.sessionId;
        claimed.add(linkedSessionId);
        const updated = this.storageService.updateChat(pending.chatId, {
          harnessSessionId: linkedSessionId,
        });
        if (updated) {
          chatsById.set(pending.chatId, updated);
        }
        console.log(
          `[OpencodeSessionWatcher] Linked session ${linkedSessionId} to chat ${pending.chatId}`
        );
      }

      const summary = sessionsById.get(linkedSessionId)?.summary ?? null;
      this.tryNameChat(pending, chat, summary);
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

    const title = summary?.trim();
    if (title) {
      this.renameChat(pending.chatId, title);
      this.pendingChats.delete(pending.chatId);
      return;
    }

    // opencode may not title a session immediately. Fall back to the first
    // user prompt so the tree does not sit on "New Session" forever.
    if (
      chat.harnessSessionId &&
      !pending.namingFromPrompt &&
      Date.now() - pending.since >= PROMPT_FALLBACK_DELAY_MS
    ) {
      pending.namingFromPrompt = true;
      void this.nameFromPrompt(pending);
    }
  }

  private async nameFromPrompt(pending: PendingChat): Promise<void> {
    const chat = this.storageService.getChat(pending.chatId);
    if (!chat || !chat.harnessSessionId || !chat.name.startsWith('New Session')) {
      this.pendingChats.delete(pending.chatId);
      return;
    }

    try {
      const preview = await this.adapter.getPreview(chat.harnessSessionId, 1);
      const prompt = preview[0]?.text?.trim();
      if (prompt) {
        this.renameChat(pending.chatId, truncateName(prompt));
      }
    } catch (error) {
      console.error(
        `[OpencodeSessionWatcher] Failed to read preview for ${chat.harnessSessionId}:`,
        error
      );
    } finally {
      this.pendingChats.delete(pending.chatId);
    }
  }

  private renameChat(chatId: string, name: string): void {
    this.storageService.renameChat(chatId, name);
    this._onChatNameUpdated.fire({ chatId, name });
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

  dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.pendingChats.clear();
    this._onChatNameUpdated.dispose();
  }
}
