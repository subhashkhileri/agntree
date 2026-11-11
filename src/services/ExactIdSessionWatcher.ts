import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChatSession, HarnessId } from '../types';
import { StorageService } from './StorageService';
import { WorktreeCatalog } from './WorktreeCatalog';
import { HarnessSessionWatcher } from '../harnesses/types';
import {
  ChatNameUpdatedEvent,
  hasDefaultName,
  linkedSessionIds,
  renameChatFromSummary,
} from '../harnesses/sessionUtils';

const POLL_MS = 5_000;
const PENDING_TTL_MS = 5 * 60_000;

/**
 * What a harness adds to the shared exact-ID linkage loop.
 *
 * The loop is for harnesses where Agntree chooses the native session ID: the
 * session is resumable once a record with that ID appears. A record can appear
 * in a different directory from the one the launch predicted, so the source
 * decides which directories to watch and how to read an ID from a file name.
 */
export interface ExactIdSessionSource {
  /** Human-readable label for log lines, e.g. "ClaudeSessionWatcher". */
  readonly label: string;
  /** Parent directories whose children may become session directories. */
  watchRoots(worktreePaths: string[]): string[];
  /** Existing directories that directly contain session files. */
  watchDirs(worktreePaths: string[]): string[];
  /** The session ID a newly written file names, or null when it names none. */
  sessionIdForFile(filename: string): string | null;
  /** Whether the session can be resumed now. */
  isResumable(sessionId: string, worktreePath?: string): Promise<boolean>;
  /** The session's current summary, for naming a linked chat. */
  getSummary(sessionId: string, worktreePath?: string): Promise<string | null>;
}

/**
 * Links a chat's chosen pending session ID to the record the harness writes.
 *
 * There is no session-created event, so the record's first appearance is the
 * link signal. The ID is authoritative: there is no directory matching and no
 * catalog of existing sessions. fs.watch is the fast path; a poll bounded by
 * the number of pending chats is the fallback.
 *
 * Harnesses that assign their own IDs use `PendingSessionWatcher` instead.
 */
export abstract class ExactIdSessionWatcher implements HarnessSessionWatcher {
  readonly harness: HarnessId;

  private readonly rootWatchers = new Map<string, fs.FSWatcher>();
  private readonly dirWatchers = new Map<string, fs.FSWatcher>();
  /** Pending IDs already linked elsewhere; retrying cannot help. */
  private readonly ignoredPendingIds = new Set<string>();
  /**
   * Pending IDs from the last storage read, with the worktree each chat was
   * launched in. fs events outside this map are noise.
   */
  private readonly pendingIds = new Map<string, string | undefined>();
  /** When each pending chat's current registration window started. */
  private readonly pendingSince = new Map<string, number>();
  /** The worktree each pending chat was launched in, for a cwd-scoped lookup. */
  private readonly pendingWorktrees = new Map<string, string>();
  private readonly monitoringIntervals = new Map<string, NodeJS.Timeout>();
  /** The pending worktrees the current watchers were armed for. */
  private watchedWorktreePaths: string[] = [];
  private poller: NodeJS.Timeout | undefined;
  private checking = false;
  private recheckRequested = false;

  private readonly _onChatNameUpdated =
    new vscode.EventEmitter<ChatNameUpdatedEvent>();
  public readonly onChatNameUpdated = this._onChatNameUpdated.event;

  protected constructor(
    harness: HarnessId,
    protected readonly storageService: StorageService,
    private readonly source: ExactIdSessionSource,
    private readonly worktrees?: Pick<WorktreeCatalog, 'worktrees'>
  ) {
    this.harness = harness;
  }

  startWatching(): void {
    this.refreshWatchers();
    this.monitorLinkedChats();
    void this.checkPending();
  }

  /**
   * Register a chat as pending. Pending chats are derived from storage on each
   * check, so this only starts a fresh window for the chat, arms its
   * directories, and runs a check immediately.
   */
  registerPendingChat(chatId: string, worktreePath: string): void {
    this.pendingSince.set(chatId, Date.now());
    this.pendingWorktrees.set(chatId, worktreePath);
    this.refreshWatchersIfNeeded();
    void this.checkPending();
  }

  /**
   * Chats whose chosen ID has not been linked yet. A pending chat whose
   * terminal is closed and whose ID never produced a record is abandoned; it
   * stops being polled after the TTL. An open terminal keeps waiting, because
   * the first prompt may still arrive.
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
        this.pendingWorktrees.delete(chat.id);
        continue;
      }
      pending.push(chat);
    }

    // Rebuild the event gate so an append to an already-linked record does no
    // storage work. The worktree rides along for the event path's lookup.
    this.pendingIds.clear();
    for (const chat of pending) {
      this.pendingIds.set(
        chat.pendingHarnessSessionId as string,
        this.pendingWorktrees.get(chat.id)
      );
    }

    const pendingChatIds = new Set(pending.map((chat) => chat.id));
    for (const chatId of this.pendingSince.keys()) {
      if (!pendingChatIds.has(chatId)) {
        this.pendingSince.delete(chatId);
        this.pendingWorktrees.delete(chatId);
      }
    }

    return pending;
  }

  private pendingWorktreePaths(): string[] {
    const paths = new Set<string>();
    for (const chatId of this.pendingSince.keys()) {
      const worktreePath = this.pendingWorktrees.get(chatId);
      if (worktreePath) {
        paths.add(worktreePath);
      }
    }
    return [...paths].sort();
  }

  private async checkPending(): Promise<void> {
    if (this.checking) {
      // A registration or event arrived mid-pass. Run once more when the pass
      // ends so a chat added during an await is not dropped with its snapshot.
      this.recheckRequested = true;
      return;
    }

    const chats = this.storageService.getChats();
    const pending = this.pendingChats(chats);
    this.refreshWatchersIfNeeded();
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
        // The record may exist before it is worth resuming; keep the pending
        // ID until the harness says it is ready.
        if (
          !(await this.source.isResumable(
            sessionId,
            this.pendingWorktrees.get(chat.id)
          ))
        ) {
          continue;
        }
        this.linkSession(
          chat,
          sessionId,
          linked,
          this.pendingWorktrees.get(chat.id)
        );
        remaining--;
      }
    } finally {
      this.checking = false;
      if (this.recheckRequested) {
        this.recheckRequested = false;
        void this.checkPending();
      } else if (remaining === 0) {
        this.stopPoller();
      } else {
        this.ensurePoller();
      }
    }
  }

  private linkSession(
    chat: ChatSession,
    sessionId: string,
    linked: Set<string>,
    worktreePath?: string
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
    this.pendingWorktrees.delete(chat.id);
    this.monitorSessionForName(chat.id, sessionId, worktreePath);

    console.log(
      `[${this.source.label}] Linked session ${sessionId} to chat ${chat.id}`
    );
  }

  /** Arm watches for the roots and directories the source currently needs. */
  private refreshWatchers(): void {
    const worktrees = this.pendingWorktreePaths();
    this.watchedWorktreePaths = worktrees;

    const roots = new Set(this.source.watchRoots(worktrees));
    for (const [root, watcher] of this.rootWatchers) {
      if (!roots.has(root)) {
        watcher.close();
        this.rootWatchers.delete(root);
      }
    }
    for (const root of roots) {
      if (!this.rootWatchers.has(root)) {
        this.watchRoot(root);
      }
    }

    const dirs = new Set(this.source.watchDirs(worktrees));
    for (const [dir, watcher] of this.dirWatchers) {
      if (!dirs.has(dir) || this.rootWatchers.has(dir)) {
        watcher.close();
        this.dirWatchers.delete(dir);
      }
    }
    for (const dir of dirs) {
      if (!this.rootWatchers.has(dir) && !this.dirWatchers.has(dir)) {
        this.watchDir(dir);
      }
    }
  }

  /**
   * Re-arm watches only when the pending worktrees changed. A new session
   * directory is a root event and re-arms them itself; a poll is the fallback
   * for linking, not for rebuilding the watch set.
   */
  private refreshWatchersIfNeeded(): void {
    const worktrees = this.pendingWorktreePaths();
    if (
      worktrees.length === this.watchedWorktreePaths.length &&
      worktrees.every(
        (worktree, index) => worktree === this.watchedWorktreePaths[index]
      )
    ) {
      return;
    }
    this.refreshWatchers();
  }

  private watchRoot(root: string): void {
    if (!fs.existsSync(root)) {
      return;
    }

    try {
      this.rootWatchers.set(
        root,
        fs.watch(root, { persistent: false }, (_eventType, filename) => {
          const name = filename ? String(filename) : undefined;
          if (name) {
            this.linkFromEvent(name);
            if (this.source.sessionIdForFile(name) !== null) {
              // A session file changed. It cannot add or drop a directory, and
              // linkFromEvent already handled a pending ID, so nothing else
              // needs the storage read a check would do.
              return;
            }
          }
          this.refreshWatchers();
          void this.checkPending();
        })
      );
    } catch (error) {
      // Polling still links the record if a watch cannot be created.
      console.error(
        `[${this.source.label}] Failed to watch ${root}:`,
        error
      );
    }
  }

  private watchDir(dir: string): void {
    try {
      this.dirWatchers.set(
        dir,
        fs.watch(dir, { persistent: false }, (_eventType, filename) => {
          if (filename) {
            this.linkFromEvent(String(filename));
          } else {
            void this.checkPending();
          }
        })
      );
    } catch (error) {
      console.error(
        `[${this.source.label}] Failed to watch ${dir}:`,
        error
      );
    }
  }

  /**
   * The watch event names the record, so a pending record links without
   * scanning directories. Every append fires this event, so the in-memory
   * pending set filters out already-linked records before any storage read. A
   * coalesced or delayed event falls back to the poller.
   */
  private linkFromEvent(filename: string): void {
    const sessionId = this.source.sessionIdForFile(filename);
    if (!sessionId || !this.pendingIds.has(sessionId)) {
      return;
    }

    void this.linkPendingTranscript(sessionId).catch((error) => {
      console.error(
        `[${this.source.label}] Failed to link session ${sessionId}:`,
        error
      );
    });
  }

  private async linkPendingTranscript(sessionId: string): Promise<void> {
    // An append fires this event, so reject a record that is not ready before
    // paying for a storage read. The worktree comes from the gate rebuilt by
    // the last storage read.
    if (
      !(await this.source.isResumable(
        sessionId,
        this.pendingIds.get(sessionId)
      ))
    ) {
      return;
    }

    const chats = this.storageService.getChats();
    const chat = this.pendingChats(chats).find(
      (candidate) => candidate.pendingHarnessSessionId === sessionId
    );
    if (!chat) {
      return;
    }

    this.linkSession(
      chat,
      sessionId,
      linkedSessionIds(chats, this.harness),
      this.pendingWorktrees.get(chat.id)
    );
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
    let worktreePaths: Map<string, string> | undefined;
    for (const chat of this.storageService.getChats()) {
      if (
        chat.harness !== this.harness ||
        !chat.harnessSessionId ||
        !hasDefaultName(chat) ||
        this.monitoringIntervals.has(chat.id)
      ) {
        continue;
      }
      if (!worktreePaths && this.worktrees) {
        worktreePaths = new Map(
          this.worktrees.worktrees().map((worktree) => [
            worktree.id,
            worktree.path,
          ])
        );
      }
      this.monitorSessionForName(
        chat.id,
        chat.harnessSessionId,
        worktreePaths?.get(chat.worktreeId)
      );
    }
  }

  /** Poll the record until the harness gives the chat a summary. */
  private monitorSessionForName(
    chatId: string,
    sessionId: string,
    worktreePath?: string
  ): void {
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
        if (!chat || !hasDefaultName(chat)) {
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

        const summary = await this.source.getSummary(
          sessionId,
          worktreePath
        );
        if (
          renameChatFromSummary(
            this.storageService,
            this._onChatNameUpdated,
            chatId,
            summary
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
          `[${this.source.label}] Failed to name chat ${chatId}:`,
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
    for (const watcher of this.rootWatchers.values()) {
      watcher.close();
    }
    this.rootWatchers.clear();

    for (const watcher of this.dirWatchers.values()) {
      watcher.close();
    }
    this.dirWatchers.clear();

    this.stopPoller();

    for (const interval of this.monitoringIntervals.values()) {
      clearInterval(interval);
    }
    this.monitoringIntervals.clear();

    this.ignoredPendingIds.clear();
    this.pendingIds.clear();
    this.pendingSince.clear();
    this.pendingWorktrees.clear();
    this.watchedWorktreePaths = [];
    this._onChatNameUpdated.dispose();
  }
}
