import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatSession, HarnessId } from '../types';
import { StorageService } from './StorageService';
import { ClaudeSessionService } from './ClaudeSessionService';
import { HarnessSessionWatcher } from '../harnesses/types';
import {
  ChatNameUpdatedEvent,
  linkedSessionIds,
  renameChatFromSummary,
} from '../harnesses/sessionUtils';

const POLL_MS = 5_000;
const PENDING_TTL_MS = 5 * 60_000;

/**
 * Links a chat's chosen pending session ID to the transcript Claude writes on
 * the first prompt.
 *
 * Claude has no session-created event, so the transcript's first appearance is
 * the link signal. The ID in the filename is authoritative: there is no
 * directory matching and no catalog of existing sessions. fs.watch is the fast
 * path; a poll bounded by the number of pending chats is the fallback.
 */
export class ClaudeSessionWatcher implements HarnessSessionWatcher {
  readonly harness: HarnessId = 'claude';

  private readonly projectWatchers = new Map<string, fs.FSWatcher>();
  /** Pending IDs already linked elsewhere; retrying cannot help. */
  private readonly ignoredPendingIds = new Set<string>();
  /** Pending IDs from the last storage read; fs events outside this set are noise. */
  private readonly pendingIds = new Set<string>();
  /** When each pending chat's current registration window started. */
  private readonly pendingSince = new Map<string, number>();
  private readonly monitoringIntervals = new Map<string, NodeJS.Timeout>();
  private rootWatcher: fs.FSWatcher | undefined;
  private poller: NodeJS.Timeout | undefined;
  private checking = false;

  /** Event emitter for when a chat name is updated */
  private _onChatNameUpdated =
    new vscode.EventEmitter<ChatNameUpdatedEvent>();
  public readonly onChatNameUpdated = this._onChatNameUpdated.event;

  constructor(
    private storageService: StorageService,
    private sessionService: ClaudeSessionService
  ) {}

  private isSessionFile(filename: string): boolean {
    return filename.endsWith('.jsonl') && !filename.startsWith('agent-');
  }

  startWatching(): void {
    this.watchProjectsDir();
    this.monitorLinkedChats();
    void this.checkPending();
  }

  /**
   * Register a chat as pending. Pending chats are derived from storage on each
   * check, so this only starts a fresh window for the chat, watches the project
   * dirs, and runs a check immediately.
   */
  registerPendingChat(chatId: string, _worktreePath: string): void {
    this.pendingSince.set(chatId, Date.now());
    this.watchProjectsDir();
    void this.checkPending();
  }

  /**
   * Chats whose chosen ID has not been linked yet. A pending chat whose
   * terminal is closed and whose ID never produced a transcript is abandoned;
   * it stops being polled after the TTL. An open terminal keeps waiting,
   * because the first prompt may still arrive.
   */
  private pendingChats(chats: ChatSession[]): ChatSession[] {
    const now = Date.now();
    const pending: ChatSession[] = [];

    for (const chat of chats) {
      if (
        chat.harness !== this.harness ||
        chat.harnessSessionId ||
        !chat.pendingHarnessSessionId ||
        this.ignoredPendingIds.has(chat.pendingHarnessSessionId)
      ) {
        continue;
      }

      const since = this.pendingSince.get(chat.id) ?? now;
      this.pendingSince.set(chat.id, since);
      if (chat.status !== 'active' && now - since >= PENDING_TTL_MS) {
        this.pendingSince.delete(chat.id);
        continue;
      }
      pending.push(chat);
    }

    // Rebuild the event gate so an append to an already-linked transcript does
    // no storage work.
    this.pendingIds.clear();
    for (const chat of pending) {
      this.pendingIds.add(chat.pendingHarnessSessionId as string);
    }

    const pendingChatIds = new Set(pending.map((chat) => chat.id));
    for (const chatId of this.pendingSince.keys()) {
      if (!pendingChatIds.has(chatId)) {
        this.pendingSince.delete(chatId);
      }
    }

    return pending;
  }

  private async checkPending(): Promise<void> {
    if (this.checking) {
      return;
    }

    const chats = this.storageService.getChats();
    const pending = this.pendingChats(chats);
    if (pending.length === 0) {
      this.stopPoller();
      return;
    }

    this.checking = true;
    let remaining = pending.length;
    try {
      const linked = linkedSessionIds(chats, this.harness);
      for (const chat of pending) {
        const sessionId = chat.pendingHarnessSessionId as string;
        // The transcript file may exist before the first prompt has written
        // anything worth resuming; keep the pending ID until it has messages.
        if (!(await this.sessionService.isSessionResumable(sessionId))) {
          continue;
        }
        this.linkSession(chat, sessionId, linked);
        remaining--;
      }
    } finally {
      this.checking = false;
      if (remaining === 0) {
        this.stopPoller();
      } else {
        this.ensurePoller();
      }
    }
  }

  private linkSession(
    chat: ChatSession,
    sessionId: string,
    linked: Set<string>
  ): void {
    // Never link one native session to two chats.
    if (linked.has(sessionId)) {
      this.ignoredPendingIds.add(sessionId);
      this.pendingIds.delete(sessionId);
      return;
    }

    this.storageService.updateChat(chat.id, {
      harnessSessionId: sessionId,
      pendingHarnessSessionId: null,
      forkedFromSessionId: null,
    });
    linked.add(sessionId);
    this.pendingIds.delete(sessionId);
    this.pendingSince.delete(chat.id);
    this.monitorSessionForName(chat.id, sessionId);

    console.log(
      `[ClaudeSessionWatcher] Linked session ${sessionId} to chat ${chat.id}`
    );
  }

  private watchProjectsDir(): void {
    const projectsDir = this.sessionService.getProjectsDirectory();
    if (!fs.existsSync(projectsDir)) {
      return;
    }

    if (!this.rootWatcher) {
      try {
        this.rootWatcher = fs.watch(
          projectsDir,
          { persistent: false },
          () => {
            this.watchProjectDirs();
            void this.checkPending();
          }
        );
      } catch (error) {
        console.error(
          `Failed to watch Claude projects dir ${projectsDir}:`,
          error
        );
      }
    }

    this.watchProjectDirs();
  }

  private watchProjectDirs(): void {
    for (const dir of this.sessionService.getProjectDirs()) {
      if (this.projectWatchers.has(dir)) {
        continue;
      }

      try {
        const watcher = fs.watch(
          dir,
          { persistent: false },
          (_eventType, filename) => {
            if (!filename) {
              void this.checkPending();
              return;
            }
            if (this.isSessionFile(filename)) {
              this.linkFromEvent(dir, filename);
            }
          }
        );
        this.projectWatchers.set(dir, watcher);
      } catch (error) {
        // Polling still links the transcript if a watch cannot be created.
        console.error(`Failed to watch Claude project dir ${dir}:`, error);
      }
    }
  }

  /**
   * The watch event names the transcript, so a pending transcript links without
   * scanning project directories. Every append fires this event, so the
   * in-memory pending set filters out already-linked transcripts before any
   * storage read. A coalesced or delayed event falls back to the poller.
   */
  private linkFromEvent(dir: string, filename: string): void {
    const sessionId = filename.slice(0, -'.jsonl'.length);
    if (!this.pendingIds.has(sessionId)) {
      return;
    }
    if (!fs.existsSync(path.join(dir, filename))) {
      return;
    }

    void this.linkPendingTranscript(sessionId).catch((error) => {
      console.error(
        `[ClaudeSessionWatcher] Failed to link transcript ${sessionId}:`,
        error
      );
    });
  }

  private async linkPendingTranscript(sessionId: string): Promise<void> {
    // The file appears at launch; it becomes resumable only after the first
    // prompt. Linking before that would strand the chat without a pending ID.
    if (!(await this.sessionService.isSessionResumable(sessionId))) {
      return;
    }

    const chats = this.storageService.getChats();
    const chat = this.pendingChats(chats).find(
      (candidate) => candidate.pendingHarnessSessionId === sessionId
    );
    if (!chat) {
      return;
    }

    this.linkSession(chat, sessionId, linkedSessionIds(chats, this.harness));
  }

  private ensurePoller(): void {
    if (this.poller) {
      return;
    }

    this.poller = setInterval(() => {
      void this.checkPending();
    }, POLL_MS);
  }

  private stopPoller(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  /** Name linked chats that were restored with the default name. */
  private monitorLinkedChats(): void {
    for (const chat of this.storageService.getChats()) {
      if (
        chat.harness === this.harness &&
        chat.harnessSessionId &&
        chat.name.startsWith('New Session') &&
        !this.monitoringIntervals.has(chat.id)
      ) {
        this.monitorSessionForName(chat.id, chat.harnessSessionId);
      }
    }
  }

  /** Poll the transcript until Claude gives the chat a summary or first prompt. */
  private monitorSessionForName(chatId: string, sessionId: string): void {
    this.stopMonitoring(chatId);

    const startedAt = Date.now();
    let checking = false;
    const check = async (): Promise<void> => {
      if (checking) {
        return;
      }
      checking = true;
      try {
        const chat = this.storageService.getChat(chatId);

        // Stop if the chat was deleted or already renamed. A closed terminal
        // gets a grace period before an abandoned chat stops polling, but an
        // open one waits for the summary however long it takes.
        if (!chat || !chat.name.startsWith('New Session')) {
          this.stopMonitoring(chatId);
          return;
        }
        if (
          chat.status !== 'active' &&
          Date.now() - startedAt >= PENDING_TTL_MS
        ) {
          this.stopMonitoring(chatId);
          return;
        }

        const session = await this.sessionService.getSessionById(sessionId);
        if (
          renameChatFromSummary(
            this.storageService,
            this._onChatNameUpdated,
            chatId,
            session?.summary
          )
        ) {
          this.stopMonitoring(chatId);
        }
      } finally {
        checking = false;
      }
    };

    const run = (): void => {
      void check().catch((error) => {
        console.error(
          `[ClaudeSessionWatcher] Failed to name chat ${chatId}:`,
          error
        );
      });
    };

    run();
    this.monitoringIntervals.set(chatId, setInterval(run, POLL_MS));
  }

  private stopMonitoring(chatId: string): void {
    const interval = this.monitoringIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.monitoringIntervals.delete(chatId);
    }
  }

  dispose(): void {
    this.rootWatcher?.close();
    this.rootWatcher = undefined;

    for (const watcher of this.projectWatchers.values()) {
      watcher.close();
    }
    this.projectWatchers.clear();

    this.stopPoller();

    for (const interval of this.monitoringIntervals.values()) {
      clearInterval(interval);
    }
    this.monitoringIntervals.clear();

    this.ignoredPendingIds.clear();
    this.pendingIds.clear();
    this.pendingSince.clear();
    this._onChatNameUpdated.dispose();
  }
}
