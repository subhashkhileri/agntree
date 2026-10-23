import * as fs from 'fs';
import { ChatSession, Worktree } from '../types';
import { HarnessAdapter, TurnState } from '../harnesses/types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { ATTENTION_FILE } from './attentionLog';
import { NotificationService } from './NotificationService';
import { StorageService } from './StorageService';
import { TerminalManager } from './TerminalManager';

const TICK_MS = 4_000;
const NEEDS_INPUT_COOLDOWN_MS = 60_000;
const MAX_LOG_BYTES = 1_000_000;

/** One line of the hook log (Claude Code's hook input). */
export interface AttentionEvent {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
}

/** Parse complete JSONL lines, skipping malformed ones. */
export function parseAttentionLines(text: string): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        events.push(parsed as AttentionEvent);
      }
    } catch {
      // Skip invalid lines; the hook writes whatever Claude sends us.
    }
  }
  return events;
}

interface WorktreeGroup {
  adapter: HarnessAdapter;
  path: string;
  chats: ChatSession[];
}

/**
 * Watches sessions with an open terminal and notifies when one stops working:
 * a finished turn (every harness) or a permission prompt (via Claude Code's
 * Notification hook).
 *
 * Harness behavior stays behind the adapter: this service only reads the
 * normalized `turnState` / `turnEndedAt` fields on `HarnessSession`.
 */
export class SessionAttentionService {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  /**
   * Last turn-end timestamp we acted on, per chat; null while working. Presence
   * also means the chat has been seen, so a new one is seeded silently.
   */
  private readonly lastTurn = new Map<string, number | null>();
  private readonly lastNeedsInputAt = new Map<string, number>();

  /**
   * Latest turn state per chat with an open terminal. The tree reads this to
   * choose between the animated working mark and the green dot; notification
   * bookkeeping stays separate so a redraw never re-arms an alert.
   */
  private readonly turnStates = new Map<string, TurnState>();

  private logOffset = 0;

  constructor(
    private readonly storage: StorageService,
    private readonly terminalManager: TerminalManager,
    private readonly registry: HarnessRegistry,
    private readonly notifications: NotificationService,
    private readonly getWorktree: (id: string) => Worktree | undefined,
    /** Called after a tick changes any chat's turn state (redraw row icons). */
    private readonly onTurnStateChanged: () => void = () => {},
    private readonly logPath: string = ATTENTION_FILE
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    // Seed the baseline first so sessions that finished before the extension
    // started never produce a notification.
    void this.tick(true);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Turn state reported by the harness, or undefined when it cannot tell. */
  getTurnState(chatId: string): TurnState | undefined {
    return this.turnStates.get(chatId);
  }

  private async tick(prime = false): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      this.processHookLog(prime);
      await this.checkTurns(prime);
    } catch (error) {
      console.error('[Agntree] Attention check failed:', error);
    } finally {
      this.ticking = false;
    }
  }

  private activeChats(): ChatSession[] {
    return this.storage
      .getChats()
      .filter((chat) => this.terminalManager.isActive(chat.id));
  }

  private async checkTurns(prime: boolean): Promise<void> {
    const chats = this.activeChats();
    const activeIds = new Set(chats.map((chat) => chat.id));
    let turnStatesChanged = false;

    // Forget chats whose terminal is gone; if one comes back it is seeded
    // again instead of notifying about history.
    for (const chatId of this.lastTurn.keys()) {
      if (!activeIds.has(chatId)) {
        this.lastTurn.delete(chatId);
        this.lastNeedsInputAt.delete(chatId);
        if (this.turnStates.delete(chatId)) {
          turnStatesChanged = true;
        }
      }
    }

    // Worktrees are independent, so poll them concurrently; one slow or failing
    // harness must not delay the rest.
    const groups = [...this.groupByWorktree(chats).values()];
    const results = await Promise.all(
      groups.map(async (group) => {
        try {
          return {
            group,
            sessions: await group.adapter.listSessionsForWorktree(group.path),
          };
        } catch (error) {
          console.error(
            `[Agntree] Could not read ${group.adapter.id} sessions in ${group.path}:`,
            error
          );
          return { group, sessions: null };
        }
      })
    );

    for (const { group, sessions } of results) {
      if (!sessions) {
        continue;
      }
      const byId = new Map(
        sessions.map((session) => [session.sessionId, session])
      );
      for (const chat of group.chats) {
        const session = chat.harnessSessionId
          ? byId.get(chat.harnessSessionId)
          : undefined;
        if (!session) {
          continue;
        }

        if (
          session.turnState &&
          this.turnStates.get(chat.id) !== session.turnState
        ) {
          this.turnStates.set(chat.id, session.turnState);
          turnStatesChanged = true;
        }

        const done = session.turnState === 'done';
        const endedAt = done ? session.turnEndedAt ?? -1 : null;

        if (!this.lastTurn.has(chat.id)) {
          this.lastTurn.set(chat.id, endedAt);
          continue;
        }

        if (!done) {
          // A new turn started (or is still running); the next turn end is a
          // fresh notification.
          this.lastTurn.set(chat.id, null);
          continue;
        }

        if (this.lastTurn.get(chat.id) === endedAt) {
          continue;
        }
        this.lastTurn.set(chat.id, endedAt);

        if (!prime) {
          this.notifications.notify('finished', {
            chat,
            context: this.contextFor(chat),
          });
        }
      }
    }

    if (turnStatesChanged) {
      this.onTurnStateChanged();
    }
  }

  private groupByWorktree(chats: ChatSession[]): Map<string, WorktreeGroup> {
    const groups = new Map<string, WorktreeGroup>();

    for (const chat of chats) {
      if (!chat.harnessSessionId) {
        continue;
      }
      const worktree = this.getWorktree(chat.worktreeId);
      if (!worktree) {
        continue;
      }

      const key = `${chat.harness}\u0000${worktree.path}`;
      const existing = groups.get(key);
      if (existing) {
        existing.chats.push(chat);
        continue;
      }

      try {
        groups.set(key, {
          adapter: this.registry.get(chat.harness),
          path: worktree.path,
          chats: [chat],
        });
      } catch {
        // Unknown harness; nothing to poll.
      }
    }

    return groups;
  }

  private contextFor(chat: ChatSession): string {
    const worktree = this.getWorktree(chat.worktreeId);
    if (!worktree) {
      return '';
    }
    const repo = this.storage.getRepository(worktree.repoId);
    return [repo?.name, worktree.name].filter(Boolean).join(' · ');
  }

  /**
   * Tail the hook log. `prime` advances past existing history without acting
   * on it, so a permission prompt from a previous run is not replayed.
   */
  private processHookLog(prime: boolean): void {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(this.logPath);
    } catch {
      return;
    }

    if (stats.size > MAX_LOG_BYTES) {
      // Our own append-only log; start over rather than grow forever.
      try {
        fs.truncateSync(this.logPath, 0);
      } catch {
        return;
      }
      this.logOffset = 0;
      return;
    }

    if (stats.size < this.logOffset) {
      this.logOffset = 0;
    }
    if (stats.size === this.logOffset) {
      return;
    }

    const length = stats.size - this.logOffset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(this.logPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, this.logOffset);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString('utf-8');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline === -1) {
      // Incomplete line; wait for the rest (the hook then reports nothing).
      return;
    }

    const complete = text.slice(0, lastNewline + 1);
    // Advance by the consumed bytes so a multi-byte character split across
    // reads is retried instead of mangled.
    this.logOffset += Buffer.byteLength(complete, 'utf-8');

    if (prime) {
      return;
    }

    for (const event of parseAttentionLines(complete)) {
      this.handleHookEvent(event);
    }
  }

  private handleHookEvent(event: AttentionEvent): void {
    if (event.hook_event_name !== 'Notification' || !event.session_id) {
      return;
    }

    const sessionId = event.session_id;
    const chat = this.storage
      .getChats()
      .find((candidate) => candidate.harnessSessionId === sessionId);

    if (!chat || !this.terminalManager.isActive(chat.id)) {
      return;
    }

    const now = Date.now();
    if (now - (this.lastNeedsInputAt.get(chat.id) ?? 0) < NEEDS_INPUT_COOLDOWN_MS) {
      return;
    }
    this.lastNeedsInputAt.set(chat.id, now);

    this.notifications.notify('needs-input', {
      chat,
      context: this.contextFor(chat),
      detail: typeof event.message === 'string' ? event.message : undefined,
    });
  }
}
