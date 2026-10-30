import { ChatSession, Worktree } from '../types';
import {
  HarnessAdapter,
  HarnessLiveState,
  TurnState,
} from '../harnesses/types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { NotificationService } from './NotificationService';
import { StorageService } from './StorageService';
import { TerminalManager } from './TerminalManager';

const TICK_MS = 4_000;
export const NEEDS_INPUT_COOLDOWN_MS = 60_000;

/**
 * A changed reason is news immediately; the same reason re-notifies at most
 * once per cooldown so a long wait is not repeated every tick.
 */
export function shouldNotifyNeedsInput(
  previous: string | undefined,
  waitingFor: string,
  lastNotifiedAt: number | undefined,
  now: number
): boolean {
  return (
    waitingFor !== previous ||
    now - (lastNotifiedAt ?? 0) >= NEEDS_INPUT_COOLDOWN_MS
  );
}

interface WorktreeGroup {
  adapter: HarnessAdapter;
  path: string;
  chats: ChatSession[];
}

/**
 * Watches sessions with an open terminal or native-UI tab and notifies when
 * one stops working: a finished turn (every harness) or a session waiting on
 * the user.
 *
 * Harness behavior stays behind the adapter. Harnesses with a cheap live-state
 * query (Claude) expose `getLiveStates`; the rest fall back to discovery.
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
  /** Last waiting reason per chat, so a repeat is not treated as new. */
  private readonly lastWaitingFor = new Map<string, string>();

  /**
   * Latest turn state per chat with an open terminal. The tree reads this to
   * choose between the animated working mark and the green dot; notification
   * bookkeeping stays separate so a redraw never re-arms an alert.
   */
  private readonly turnStates = new Map<string, TurnState>();

  constructor(
    private readonly storage: StorageService,
    private readonly terminalManager: TerminalManager,
    private readonly registry: HarnessRegistry,
    private readonly notifications: NotificationService,
    private readonly getWorktree: (id: string) => Worktree | undefined,
    /** Called after a tick changes any chat's turn state (redraw row icons). */
    private readonly onTurnStateChanged: () => void = () => {},
    /**
     * Whether a chat is open in a terminal or a native-UI tab. UI sessions
     * write the same transcripts, so they need the same turn-state polling.
     */
    private readonly isChatOpen: (chat: ChatSession) => boolean = (chat) =>
      terminalManager.isActive(chat.id)
  ) {}

  start(): void {
    if (this.timer) {
      return;
    }
    // Seed the baseline first so sessions that finished before the extension
    // started never produce a notification.
    void this.poll(true);
    this.timer = setInterval(() => void this.poll(), TICK_MS);
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

  /** Run one attention check immediately. */
  async poll(prime = false): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.checkTurns(prime);
    } catch (error) {
      console.error('[Agntree] Attention check failed:', error);
    } finally {
      this.ticking = false;
    }
  }

  private activeChats(): ChatSession[] {
    return this.storage.getChats().filter((chat) => this.isChatOpen(chat));
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
        this.lastWaitingFor.delete(chatId);
        if (this.turnStates.delete(chatId)) {
          turnStatesChanged = true;
        }
      }
    }

    // Worktrees are independent, so poll them concurrently; one slow or failing
    // harness must not delay the rest.
    const groups = [...this.groupByWorktree(chats).values()];
    const results = await Promise.all(
      groups.map(async (group) => ({
        group,
        states: await this.readLiveStates(group),
      }))
    );

    for (const { group, states } of results) {
      if (!states) {
        continue;
      }

      for (const chat of group.chats) {
        const live = chat.harnessSessionId
          ? states.get(chat.harnessSessionId)
          : undefined;
        if (!live) {
          continue;
        }

        const { turnState, turnEndedAt, waitingFor } = live;

        if (this.turnStates.get(chat.id) !== turnState) {
          this.turnStates.set(chat.id, turnState);
          turnStatesChanged = true;
        }

        this.updateNeedsInput(chat, waitingFor, prime);

        const done = turnState === 'done';
        const endedAt = done ? turnEndedAt ?? -1 : null;

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

        // Needs-you takes precedence: when the turn ended at a prompt, the
        // user already gets the more useful notification.
        if (!prime && !waitingFor) {
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

  /**
   * One shape for both sources: adapters with a cheap live-state query answer
   * directly, and discovery-based adapters convert their sessions here.
   */
  private async readLiveStates(
    group: WorktreeGroup
  ): Promise<Map<string, HarnessLiveState> | null> {
    try {
      if (group.adapter.getLiveStates) {
        const sessionIds = group.chats
          .map((chat) => chat.harnessSessionId)
          .filter((id): id is string => Boolean(id));
        return await group.adapter.getLiveStates(sessionIds);
      }

      const sessions = await group.adapter.listSessionsForWorktree(group.path);
      const states = new Map<string, HarnessLiveState>();
      for (const session of sessions) {
        if (!session.turnState) {
          continue;
        }
        states.set(session.sessionId, {
          turnState: session.turnState,
          turnEndedAt: session.turnEndedAt ?? null,
        });
      }
      return states;
    } catch (error) {
      console.error(
        `[Agntree] Could not read ${group.adapter.id} sessions in ${group.path}:`,
        error
      );
      return null;
    }
  }

  private updateNeedsInput(
    chat: ChatSession,
    waitingFor: string | undefined,
    prime: boolean
  ): void {
    if (!waitingFor) {
      // Re-arm the next wait.
      this.lastWaitingFor.delete(chat.id);
      return;
    }

    if (prime) {
      // The wait began before this extension host started; seed it so the
      // next tick does not replay it as news.
      this.lastWaitingFor.set(chat.id, waitingFor);
      this.lastNeedsInputAt.set(chat.id, Date.now());
      return;
    }

    const previous = this.lastWaitingFor.get(chat.id);
    const now = Date.now();
    const shouldNotify = shouldNotifyNeedsInput(
      previous,
      waitingFor,
      this.lastNeedsInputAt.get(chat.id),
      now
    );
    this.lastWaitingFor.set(chat.id, waitingFor);

    if (!shouldNotify) {
      return;
    }

    this.lastNeedsInputAt.set(chat.id, now);
    this.notifications.notify('needs-input', {
      chat,
      context: this.contextFor(chat),
      detail: waitingFor,
    });
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
}
