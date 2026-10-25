import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { StorageService } from './StorageService';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessWatcherRegistry } from './HarnessWatcherRegistry';
import { HarnessAdapter } from '../harnesses/types';
import { quoteShellArgument } from '../harnesses/commandUtils';

/** How long to wait for a terminal's pty before giving up on its PID. */
const PROCESS_ID_TIMEOUT_MS = 2000;

/** How long to let `show()` settle before renaming the active terminal. */
const ACTIVE_TERMINAL_TIMEOUT_MS = 1000;

/** How long to wait for the launch command to start before applying the title. */
const COMMAND_START_TIMEOUT_MS = 2000;

/**
 * How long to wait for a restored tab's shell. A restored tab resumes in the
 * background, where a slow shell start (prompt frameworks, version managers)
 * is worth waiting out, and nothing blocks the user.
 */
const RESTORED_SHELL_TIMEOUT_MS = 10000;

/** A revived tab and the waits its background launch is observed through. */
interface RevivedTerminal {
  terminal: vscode.Terminal;
  integrated: Promise<boolean>;
  started: Promise<boolean>;
}

/** The two phases of terminal restore, split by what activation may await. */
export interface RestoreSync {
  /**
   * Terminals whose pty survived a reload are adopted once this resolves.
   * Bounded (PID reads and storage only), so activation waits for it.
   */
  adopted: Promise<void>;
  /**
   * Revived tabs are resumed and chat statuses are reconciled. Runs in the
   * background because a harness resumability check can outlast startup.
   */
  complete: Promise<void>;
}

/**
 * Manages VS Code terminal instances for chat sessions across harnesses.
 *
 * A terminal that maps to a chat always carries the chat's custom title. That
 * title is the restore identity: a window reload keeps the pty (match by PID),
 * while a quit revives the tab as a new shell under the stored title (match by
 * the short ID in it).
 */
export class TerminalManager {
  /** Map of chat ID to terminal instance */
  private terminals: Map<string, vscode.Terminal> = new Map();

  /** Map of terminal to chat ID (for reverse lookup on close) */
  private terminalToChatId: Map<vscode.Terminal, string> = new Map();

  /** Disposable for terminal close listener */
  private onCloseTerminalDisposable: vscode.Disposable;

  /** Disposable for terminals that appear after activation */
  private onOpenTerminalDisposable: vscode.Disposable;

  /** Disposable for the active-terminal listener that re-applies titles */
  private onActiveTerminalDisposable: vscode.Disposable;

  /** Disposable for shell-integration changes that re-apply titles */
  private onShellIntegrationDisposable: vscode.Disposable;

  /** Whether `dispose()` ran, so background title work can stop. */
  private isDisposed = false;

  /**
   * Serializes title writes. The rename command targets whichever terminal is
   * active when it executes, so two overlapping writes can rename each other's
   * tab; the chain makes the last focus win.
   */
  private titleWrites: Promise<void> = Promise.resolve();

  /**
   * Resolves a worktree for a restored chat. Set by the restore pass so a
   * terminal that appears later can register its chat with the harness watcher.
   */
  private getWorktreeById?: (worktreeId: string) => Worktree | undefined;

  /**
   * Chats whose restored tab is being resumed. The harness resumability check
   * can take seconds; until it finishes, the tab is still this chat's terminal
   * even though it is not in the map yet.
   */
  private restoringChats: Map<string, vscode.Terminal> = new Map();

  /**
   * A terminal TerminalManager activated to re-apply a title. Background
   * retitling must not look like a user focus change to the tree.
   */
  private backgroundActivation?: vscode.Terminal;

  /** Terminal name prefix */
  private static readonly TERMINAL_PREFIX = 'Agntree: ';

  /**
   * Generate a unique terminal name that includes the chat ID
   * Format: "Agntree: {chatName} [{shortId}]"
   */
  static getTerminalName(chat: ChatSession): string {
    const shortId = chat.id.substring(0, 6);
    return `${TerminalManager.TERMINAL_PREFIX}${chat.name} [${shortId}]`;
  }

  /**
   * Parse the chat's short ID from a restored Agntree title. The title is the
   * machine key that survives a quit, so a terminal Agntree does not own never
   * matches.
   */
  static parseTerminalShortId(terminalName: string): string | null {
    if (!terminalName.startsWith(TerminalManager.TERMINAL_PREFIX)) {
      return null;
    }
    const match = terminalName.match(/\[([a-f0-9]{6})\]$/);
    return match ? match[1] : null;
  }

  /** Event emitter for terminal state changes */
  private _onTerminalStateChange = new vscode.EventEmitter<{
    chatId: string;
    state: 'opened' | 'closed';
  }>();
  public readonly onTerminalStateChange = this._onTerminalStateChange.event;

  /**
   * Whether a terminal still owns a running process. VS Code keeps a terminal
   * in `window.terminals` after its process exits (the tab keeps its last
   * output), so presence alone does not mean the session is open.
   */
  private static isLiveTerminal(terminal: vscode.Terminal): boolean {
    return (
      vscode.window.terminals.includes(terminal) &&
      terminal.exitStatus === undefined
    );
  }

  /** Settle on a promise or a timeout, whichever comes first. */
  private static withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    onTimeout: T
  ): Promise<T> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(onTimeout), timeoutMs);
      promise.then(finish, () => finish(onTimeout));
    });
  }

  /**
   * Resolve a terminal's pty PID. Bounded so activation cannot hang on a
   * terminal whose process never reports one.
   */
  private static readProcessId(
    terminal: vscode.Terminal
  ): Promise<number | undefined> {
    return TerminalManager.withTimeout(
      Promise.resolve(terminal.processId),
      PROCESS_ID_TIMEOUT_MS,
      undefined
    );
  }

  /**
   * Settle on the first matching event or the timeout, and always release the
   * listener and timer.
   */
  private static waitForEvent<T>(
    timeoutMs: number,
    onTimeout: T,
    subscribe: (done: (value: T) => void) => vscode.Disposable
  ): Promise<T> {
    return new Promise((resolve) => {
      let settled = false;
      let disposable: vscode.Disposable | undefined;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        disposable?.dispose();
        resolve(value);
      };
      const timer = setTimeout(() => finish(onTimeout), timeoutMs);
      disposable = subscribe(finish);
      if (settled) {
        disposable.dispose();
      }
    });
  }

  /**
   * Wait until the command sent into a new terminal has started. Shell
   * integration reports the shell's working directory when the shell starts
   * and again as a command starts, and each report re-tags the terminal title
   * as a config title in VS Code. A quit then restores that tag, lets the
   * revived shell overwrite the name, and loses the chat identity. Renaming
   * after the command is running leaves Agntree's title as the one VS Code
   * persists. Resolves false when the command never starts (no integration),
   * which is also when the title never needs re-applying.
   */
  private static waitForCommandStart(
    terminal: vscode.Terminal,
    timeoutMs = COMMAND_START_TIMEOUT_MS
  ): Promise<boolean> {
    return TerminalManager.waitForEvent<boolean>(
      timeoutMs,
      false,
      (done) =>
        vscode.window.onDidStartTerminalShellExecution((event) => {
          if (event.terminal === terminal) {
            done(true);
          }
        })
    );
  }

  /**
   * Wait until a terminal's shell reports integration, or give up. Integration
   * is what makes VS Code re-tag the title from a cwd report; a shell without
   * it never does, so its stored title already survives a quit unchanged.
   */
  private static waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs: number
  ): Promise<boolean> {
    const enabled = vscode.workspace
      .getConfiguration('terminal.integrated')
      .get<boolean>('shellIntegration.enabled', true);
    if (!enabled) {
      return Promise.resolve(false);
    }
    if (terminal.shellIntegration) {
      return Promise.resolve(true);
    }
    return TerminalManager.waitForEvent(
      timeoutMs,
      false,
      (done) =>
        vscode.window.onDidChangeTerminalShellIntegration((event) => {
          if (event.terminal === terminal) {
            done(true);
          }
        })
    );
  }

  /**
   * Wait for a terminal that was just shown to become the active terminal.
   * The rename command targets the active tab, and `show()` crosses process
   * boundaries asynchronously.
   */
  private static waitForActive(terminal: vscode.Terminal): Promise<void> {
    if (vscode.window.activeTerminal === terminal) {
      return Promise.resolve();
    }
    return TerminalManager.waitForEvent<void>(
      ACTIVE_TERMINAL_TIMEOUT_MS,
      undefined,
      (done) =>
        vscode.window.onDidChangeActiveTerminal((active) => {
          if (active === terminal) {
            done(undefined);
          }
        })
    );
  }

  /**
   * A revived tab's shell starts in the workspace root, while the harness
   * commands operate in the process's working directory. Change directory and
   * launch as one shell line, so the command-start event covers the launch and
   * a failed `cd` cannot start an agent in the wrong worktree.
   */
  private static commandInDirectory(
    directory: string,
    command: string
  ): string {
    return `cd ${quoteShellArgument(directory)} && ${command}`;
  }

  constructor(
    private storageService: StorageService,
    private harnessRegistry: HarnessRegistry,
    private harnessWatcherRegistry: HarnessWatcherRegistry
  ) {
    this.onCloseTerminalDisposable = vscode.window.onDidCloseTerminal((terminal) => {
      const chatId = this.terminalToChatId.get(terminal);
      if (chatId) {
        this.handleTerminalClosed(chatId, terminal);
      }
    });

    // A restored terminal can appear after activation; adopt it if its pty is
    // one Agntree recorded.
    this.onOpenTerminalDisposable = vscode.window.onDidOpenTerminal((terminal) => {
      void this.adoptRestoredTerminal(
        terminal,
        this.storageService.getTerminalPids(),
        undefined,
        this.getWorktreeById
      ).catch((error) => {
        console.error('Agntree: could not adopt a restored terminal', error);
      });
    });

    // A mapped terminal always shows Agntree's title. Re-applying on focus
    // covers a title VS Code lost during a restore and a hand-renamed tab.
    this.onActiveTerminalDisposable = vscode.window.onDidChangeActiveTerminal(
      (terminal) => {
        if (!terminal) {
          return;
        }
        if (
          this.backgroundActivation &&
          terminal !== this.backgroundActivation
        ) {
          // Someone else took the active tab; a later focus of the expected
          // tab is the user's and must not be swallowed by the marker.
          this.backgroundActivation = undefined;
        }
        void this.applyTitle(terminal);
      }
    );

    // VS Code re-tags a terminal's title as a config title whenever the shell
    // reports its working directory, which lets the shell's own title win.
    // Re-applying after each report covers a slow shell that started after the
    // initial title was applied.
    this.onShellIntegrationDisposable =
      vscode.window.onDidChangeTerminalShellIntegration((event) => {
        void this.applyTitle(event.terminal);
      });
  }

  /**
   * Open a chat in a terminal (creates new or focuses existing)
   */
  async openChat(
    chat: ChatSession,
    worktree: Worktree
  ): Promise<vscode.Terminal | undefined> {
    // Only a terminal still in the in-memory map is this chat's session. A
    // same-named terminal is not: after a quit it is a revived shell.
    const existingTerminal = this.terminals.get(chat.id);
    if (existingTerminal) {
      if (TerminalManager.isLiveTerminal(existingTerminal)) {
        existingTerminal.show();
        return existingTerminal;
      }
      // The process exited or VS Code dropped the terminal; its tab may
      // linger. Forget it and launch a fresh one below.
      this.terminals.delete(chat.id);
      this.terminalToChatId.delete(existingTerminal);
      existingTerminal.dispose();
    }

    // A restored tab is this chat's terminal even before its resume command
    // is sent. Its resumability check can still be running; treating it as
    // unowned would let this click launch a second agent.
    const restoring = this.restoringChats.get(chat.id);
    if (restoring) {
      if (TerminalManager.isLiveTerminal(restoring)) {
        restoring.show();
        return restoring;
      }
      this.restoringChats.delete(chat.id);
    }

    const launch = await this.prepareLaunch(chat, worktree.path, true);
    if (!launch) {
      return undefined;
    }

    // Create new terminal in the editor area (not the bottom panel)
    const terminal = vscode.window.createTerminal({
      name: TerminalManager.getTerminalName(chat),
      cwd: worktree.path,
      iconPath: new vscode.ThemeIcon(launch.icon),
      location: vscode.TerminalLocation.Editor,
    });

    const { integrated, started } = this.startTerminal(
      chat,
      terminal,
      launch.command,
      COMMAND_START_TIMEOUT_MS,
      true
    );
    terminal.show();

    // A rename is only persisted by VS Code after the shell has reported its
    // cwd for the running command. A shell without integration reports no
    // command start and no cwd re-tag, so there is nothing to wait for; the
    // setting check makes that case return immediately.
    await this.recordTerminalPid(chat.id, terminal);
    if (await integrated) {
      await started;
      await TerminalManager.waitForActive(terminal);
      await this.applyTitle(terminal);
    }

    return terminal;
  }

  /**
   * Map a terminal to its chat, send the launch command, and announce the
   * session. Callers must create any event waits before calling this, because
   * the command can start as soon as it is sent.
   */
  private startTerminal(
    chat: ChatSession,
    terminal: vscode.Terminal,
    command: string,
    commandStartTimeout: number,
    observeIntegration = false
  ): { integrated?: Promise<boolean>; started: Promise<boolean> } {
    const integrated = observeIntegration
      ? TerminalManager.waitForShellIntegration(terminal, commandStartTimeout)
      : undefined;
    const started = TerminalManager.waitForCommandStart(
      terminal,
      commandStartTimeout
    );

    this.terminals.set(chat.id, terminal);
    this.terminalToChatId.set(terminal, chat.id);
    terminal.sendText(command);
    this.storageService.updateChat(chat.id, {
      status: 'active',
      lastAccessedAt: Date.now(),
    });
    this._onTerminalStateChange.fire({ chatId: chat.id, state: 'opened' });

    return { integrated, started };
  }

  /**
   * Resolve the command that launches or resumes a chat. Shared by opening a
   * chat on demand and resuming restored tabs in the background; only the
   * former announces a missing session to the user.
   */
  private async prepareLaunch(
    chat: ChatSession,
    worktreePath: string,
    announce: boolean
  ): Promise<{ command: string; icon: string } | undefined> {
    const adapter = this.harnessRegistry.get(chat.harness);
    const pendingId = chat.pendingHarnessSessionId ?? undefined;
    // A terminal fork that has not linked yet keeps its source on the chat, so
    // reopening it repeats the fork rather than starting fresh.
    const forkSource = !chat.harnessSessionId
      ? chat.forkedFromSessionId ?? undefined
      : undefined;

    let sessionId: string | undefined;
    let newSessionId: string | undefined;
    let forkFrom: string | undefined;

    // A pending ID whose transcript already exists means the watcher has not
    // caught up (or failed to); resume it instead of forking/launching again.
    if (pendingId && (await this.isResumable(adapter, pendingId, worktreePath))) {
      sessionId = pendingId;
    } else if (forkSource) {
      // A terminal fork starts from the source and writes under the chosen ID.
      forkFrom = forkSource;
      newSessionId = pendingId;
    } else if (chat.harnessSessionId) {
      if (
        !(await this.isResumable(adapter, chat.harnessSessionId, worktreePath))
      ) {
        if (announce) {
          this.showMissingSessionWarning(chat, adapter);
        }
        return undefined;
      }
      sessionId = chat.harnessSessionId;
    } else {
      newSessionId = pendingId;
    }

    try {
      return {
        command: adapter.buildLaunchCommand({
          worktreePath,
          sessionId,
          newSessionId,
          forkFromSessionId: forkFrom,
        }),
        icon: adapter.icon,
      };
    } catch (error) {
      if (announce) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(
          `Could not open the ${adapter.displayName} session: ${message}`
        );
      }
      return undefined;
    }
  }

  private async isResumable(
    adapter: HarnessAdapter,
    sessionId: string,
    cwd?: string
  ): Promise<boolean> {
    try {
      return await adapter.isSessionResumable(sessionId, cwd);
    } catch {
      return false;
    }
  }

  /**
   * A chat without a native session is linked by its harness watcher once the
   * session appears. Opening a chat registers it before launch; a restored tab
   * has no such call, so the restore paths register it here.
   */
  private registerPendingChat(chat: ChatSession, worktreePath: string): void {
    if (chat.harnessSessionId) {
      return;
    }
    this.harnessWatcherRegistry.registerPendingChat(
      chat.harness,
      chat.id,
      worktreePath
    );
  }

  /**
   * Record the pty behind a mapped terminal so a reload can find it again.
   * Callers that already read the PID pass it in to avoid a second bounded
   * read during activation.
   */
  private async recordTerminalPid(
    chatId: string,
    terminal: vscode.Terminal,
    knownPid?: number
  ): Promise<void> {
    const pid = knownPid ?? (await TerminalManager.readProcessId(terminal));
    // The tab may have closed while the PID was pending.
    if (pid === undefined || this.terminals.get(chatId) !== terminal) {
      return;
    }
    await this.storageService.rememberTerminalPid(chatId, pid);
  }

  /**
   * Give a mapped terminal Agntree's title. The rename command targets the
   * active terminal, so the caller must make this terminal active first. Writes
   * are serialized: each one re-checks the active tab when it runs, so a focus
   * change between queueing and execution cannot swap two tabs' titles.
   */
  private applyTitle(terminal: vscode.Terminal): Promise<void> {
    return this.queueTitleWork(() => this.writeTitle(terminal));
  }

  /**
   * Run one rename, or a show-rename-restore sequence, after every title write
   * already queued. Keeping title work serial means a background retitle cannot
   * activate its tab in the middle of another retitle's show window.
   */
  private queueTitleWork(work: () => Promise<void>): Promise<void> {
    const run = this.titleWrites.then(work);
    this.titleWrites = run.then(undefined, () => undefined);
    return this.titleWrites;
  }

  private async writeTitle(terminal: vscode.Terminal): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    const chatId = this.terminalToChatId.get(terminal);
    const chat = chatId ? this.storageService.getChat(chatId) : undefined;
    if (!chat || vscode.window.activeTerminal !== terminal) {
      return;
    }
    await vscode.commands
      .executeCommand('workbench.action.terminal.renameWithArg', {
        name: TerminalManager.getTerminalName(chat),
      })
      .then(undefined, () => undefined);
  }

  /**
   * Whether TerminalManager activated this terminal to re-apply its title,
   * rather than the user focusing it. Consumes the marker, so a later real
   * focus is handled normally. The tree uses this to ignore selection changes
   * caused by the background retitle pass.
   */
  consumeBackgroundActivation(terminal: vscode.Terminal): boolean {
    if (this.backgroundActivation !== terminal) {
      return false;
    }
    this.backgroundActivation = undefined;
    return true;
  }

  /**
   * Activate a tab long enough to rename it, without reporting the activation
   * as a user focus change.
   */
  private async showForRetitle(terminal: vscode.Terminal): Promise<void> {
    this.backgroundActivation = terminal;
    terminal.show(true);
    await TerminalManager.waitForActive(terminal);
    if (this.backgroundActivation === terminal) {
      this.backgroundActivation = undefined;
    }
  }

  /**
   * The session is gone from the harness. Offer to drop the stale chat.
   */
  private showMissingSessionWarning(chat: ChatSession, adapter: HarnessAdapter): void {
    vscode.window
      .showWarningMessage(
        `Session not found in ${adapter.displayName}. It is no longer available, so this chat cannot be reopened.`,
        'Delete Chat',
        'Cancel'
      )
      .then((choice) => {
        if (choice === 'Delete Chat') {
          this.storageService.deleteChat(chat.id);
          vscode.commands.executeCommand('agntree.refreshWorkspaces');
        }
      });
  }

  /**
   * Close a chat's terminal
   */
  closeChat(chatId: string): void {
    const terminal = this.terminals.get(chatId);
    if (terminal) {
      terminal.dispose();
      // Cleanup will happen in handleTerminalClosed via the event
    }
  }

  /**
   * Check if a chat has an active terminal
   */
  isActive(chatId: string): boolean {
    const terminal = this.terminals.get(chatId);
    if (!terminal) {
      return false;
    }
    if (TerminalManager.isLiveTerminal(terminal)) {
      return true;
    }
    // Clean up a stale reference; the close event never reached us or the
    // process exited while its tab stayed listed. Dispose it so a dead tab
    // cannot stand in for the chat.
    this.terminals.delete(chatId);
    this.terminalToChatId.delete(terminal);
    terminal.dispose();
    return false;
  }

  /**
   * Get the terminal for a chat
   */
  getTerminal(chatId: string): vscode.Terminal | undefined {
    return this.terminals.get(chatId);
  }

  /**
   * Get the chat a terminal is mapped to, if any
   */
  getChatIdForTerminal(terminal: vscode.Terminal): string | undefined {
    return this.terminalToChatId.get(terminal);
  }

  /**
   * Focus a chat's terminal if it exists
   */
  focusChat(chatId: string): boolean {
    const terminal = this.terminals.get(chatId);
    if (terminal) {
      terminal.show();
      return true;
    }
    return false;
  }

  /**
   * Handle terminal closed event
   */
  private handleTerminalClosed(chatId: string, terminal: vscode.Terminal): void {
    this.terminals.delete(chatId);
    this.terminalToChatId.delete(terminal);

    // Get the chat to check if it has a harness session
    const chat = this.storageService.getChat(chatId);

    if (chat && !chat.harnessSessionId && !chat.pendingHarnessSessionId) {
      // A harness that assigns its own ID never linked this chat before the
      // terminal closed, so there is nothing to resume.
      this.dropChat(chatId);
    } else {
      if (chat && !chat.harnessSessionId && chat.forkedFromSessionId) {
        // A fork that never wrote a transcript has no session to resume, and
        // reopening it would fork from the source's current state. Drop the
        // row instead, unless the first prompt already produced a transcript.
        void this.dropUnusedFork(chat);
      }
      // The pty is gone; keep the recorded PID as proof for the next
      // activation, but do not adopt this terminal again.
      this.storageService.updateChat(chatId, { status: 'closed' });
    }

    this._onTerminalStateChange.fire({ chatId, state: 'closed' });
  }

  private dropChat(chatId: string): void {
    this.storageService.deleteChat(chatId);
    vscode.commands.executeCommand('agntree.refreshWorkspaces');
  }

  /**
   * Drop a terminal fork that never produced a transcript. The fork exists
   * only inside the closed process, so keeping the chat would offer a fork of
   * wherever the source has moved to since.
   */
  private async dropUnusedFork(chat: ChatSession): Promise<void> {
    const adapter = this.harnessRegistry.get(chat.harness);
    const pendingId = chat.pendingHarnessSessionId;
    if (pendingId && (await this.isResumable(adapter, pendingId))) {
      return;
    }
    // The watcher may have linked the chat while we checked.
    const current = this.storageService.getChat(chat.id);
    if (!current || current.harnessSessionId) {
      return;
    }
    this.dropChat(chat.id);
  }

  /**
   * Get all active chat IDs
   */
  getActiveChatIds(): string[] {
    return Array.from(this.terminals.keys());
  }

  /**
   * Dispose all terminals (for extension deactivation)
   */
  dispose(): void {
    this.isDisposed = true;
    this.onCloseTerminalDisposable.dispose();
    this.onOpenTerminalDisposable.dispose();
    this.onActiveTerminalDisposable.dispose();
    this.onShellIntegrationDisposable.dispose();
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
    this.terminalToChatId.clear();
    this.restoringChats.clear();
    this._onTerminalStateChange.dispose();
  }

  /**
   * Reconcile terminals that survived an extension-host restart.
   *
   * A window reload keeps every pty, so adoption is silent: the terminal with
   * a chat's recorded PID is that chat's live agent. Adoption reads only PIDs
   * and storage, so activation can wait for it without putting harness I/O in
   * front of the tree. A quit revives each tab as a new shell, and resuming one
   * asks the harness whether its session still exists; that native check can
   * outlast startup, so it runs after the views and commands exist. Until it
   * finishes, `openChat` treats a candidate tab as the chat's terminal, so a
   * click cannot launch a second agent.
   */
  beginRestoreSync(
    getWorktree: (worktreeId: string) => Worktree | undefined
  ): RestoreSync {
    this.getWorktreeById = getWorktree;
    const chats = this.storageService.getChats();
    const recordedPids = this.storageService.getTerminalPids();
    const terminals = vscode.window.terminals;
    const pids = new Map<vscode.Terminal, number | undefined>();

    const adopted = (async () => {
      // Only terminals that can be adopted or resumed need their PID.
      // Unrelated user terminals must not add their read timeout to startup.
      const canAdopt = Object.keys(recordedPids).length > 0;
      await Promise.all(
        terminals.map(async (terminal) => {
          if (terminal.exitStatus !== undefined) {
            return;
          }
          if (
            !canAdopt &&
            !TerminalManager.parseTerminalShortId(terminal.name)
          ) {
            return;
          }
          pids.set(terminal, await TerminalManager.readProcessId(terminal));
        })
      );

      // Resolve each worktree once. The provider caches what it lists, so a
      // cold lookup loads each repository at most once.
      const worktrees = new Map<string, Worktree | undefined>();
      const resolveWorktree = (
        worktreeId: string
      ): Worktree | undefined => {
        if (!worktrees.has(worktreeId)) {
          worktrees.set(worktreeId, getWorktree(worktreeId));
        }
        return worktrees.get(worktreeId);
      };

      if (canAdopt) {
        for (const terminal of terminals) {
          await this.adoptRestoredTerminal(
            terminal,
            recordedPids,
            pids.get(terminal),
            resolveWorktree
          );
        }
      }
      return resolveWorktree;
    })();

    const complete = adopted.then(async (resolveWorktree) => {
      try {
        await this.resumeRevivedTerminals(
          chats,
          recordedPids,
          pids,
          resolveWorktree
        );

        // Reconcile only chats this workspace launched; leave chats it never
        // opened alone.
        const mine = new Set(Object.keys(recordedPids));
        for (const chat of chats) {
          if (
            mine.has(chat.id) &&
            chat.status === 'active' &&
            !this.isActive(chat.id)
          ) {
            this.storageService.updateChat(chat.id, { status: 'idle' });
          }
        }
      } finally {
        this.restoringChats.clear();
      }
    });

    return { adopted: adopted.then(() => undefined), complete };
  }

  /**
   * Adopt a restored terminal whose pty is the one recorded for a chat. Never
   * type into an adopted terminal: the pty is the running agent.
   */
  private async adoptRestoredTerminal(
    terminal: vscode.Terminal,
    recordedPids: Record<string, number>,
    knownPid?: number,
    getWorktree?: (worktreeId: string) => Worktree | undefined
  ): Promise<void> {
    if (
      terminal.exitStatus !== undefined ||
      this.terminalToChatId.has(terminal)
    ) {
      return;
    }
    const pid = knownPid ?? (await TerminalManager.readProcessId(terminal));
    if (pid === undefined) {
      return;
    }

    const chatId = Object.keys(recordedPids).find(
      (id) => recordedPids[id] === pid && !this.terminals.has(id)
    );
    if (!chatId) {
      return;
    }

    this.terminals.set(chatId, terminal);
    this.terminalToChatId.set(terminal, chatId);

    const chat = this.storageService.getChat(chatId);
    if (chat && chat.status !== 'active') {
      this.storageService.updateChat(chatId, { status: 'active' });
    }
    if (chat && !chat.harnessSessionId && getWorktree) {
      const worktree = getWorktree(chat.worktreeId);
      if (worktree) {
        this.registerPendingChat(chat, worktree.path);
      }
    }
    await this.storageService.rememberTerminalPid(chatId, pid);
    await this.applyTitle(terminal);
    this._onTerminalStateChange.fire({ chatId, state: 'opened' });
  }

  /**
   * Resume every restored tab that VS Code revived as a new shell. A chat is
   * only resumed into its own tab: the workspace must have recorded a PID for
   * it and that PID must differ from the restored shell's, which proves this
   * is not a live agent. Only one tab per chat is resumed; a duplicate title
   * leaves the first tab as the chat's terminal and the rest unmanaged.
   */
  private async resumeRevivedTerminals(
    chats: ChatSession[],
    recordedPids: Record<string, number>,
    pids: Map<vscode.Terminal, number | undefined>,
    getWorktree: (worktreeId: string) => Worktree | undefined
  ): Promise<void> {
    const chatsByShortId = new Map<string, ChatSession>();
    const ambiguous = new Set<string>();
    for (const chat of chats) {
      const shortId = chat.id.substring(0, 6);
      if (chatsByShortId.has(shortId)) {
        ambiguous.add(shortId);
      } else {
        chatsByShortId.set(shortId, chat);
      }
    }

    const candidates: Array<{ chat: ChatSession; terminal: vscode.Terminal }> =
      [];
    const claimedChats = new Set<string>();
    for (const terminal of vscode.window.terminals) {
      if (
        terminal.exitStatus !== undefined ||
        this.terminalToChatId.has(terminal)
      ) {
        continue;
      }

      const shortId = TerminalManager.parseTerminalShortId(terminal.name);
      if (!shortId || ambiguous.has(shortId)) {
        continue;
      }
      const chat = chatsByShortId.get(shortId);
      if (!chat || this.terminals.has(chat.id) || claimedChats.has(chat.id)) {
        continue;
      }

      // Only a chat this workspace launched may be typed into, and only when
      // the current pty is not the one it recorded.
      const recordedPid = recordedPids[chat.id];
      if (recordedPid === undefined) {
        continue;
      }
      const pid = pids.get(terminal);
      if (pid === undefined || pid === recordedPid) {
        continue;
      }

      // An unlinked fork exists only inside the process that closed;
      // repeating the fork would start from the source's current state.
      if (!chat.harnessSessionId && chat.forkedFromSessionId) {
        continue;
      }

      claimedChats.add(chat.id);
      candidates.push({ chat, terminal });
    }

    // The harness checks below read the harness's own store and can be slow.
    // Hold the tab for each chat so a click during the check focuses it instead
    // of launching a second agent.
    for (const { chat, terminal } of candidates) {
      this.restoringChats.set(chat.id, terminal);
    }

    // Resumability checks read the harness's own store, so overlap them. The
    // sends and their storage writes stay ordered to avoid lost updates.
    const prepared = await Promise.all(
      candidates.map(async ({ chat, terminal }) => {
        if (this.isDisposed) {
          return undefined;
        }
        // The chat may have changed since the restore candidates were
        // collected (for example, a click minted a pending session id).
        const latest = this.storageService.getChat(chat.id) ?? chat;
        const worktree = getWorktree(latest.worktreeId);
        if (!worktree) {
          this.restoringChats.delete(chat.id);
          return undefined;
        }
        const launch = await this.prepareLaunch(latest, worktree.path, false);
        if (!launch) {
          this.restoringChats.delete(chat.id);
          return undefined;
        }
        // The watcher that would have linked this chat died with the previous
        // extension host; register it again before the new session appears.
        this.registerPendingChat(latest, worktree.path);
        return { chat: latest, terminal, launch, worktreePath: worktree.path };
      })
    );

    const revived: RevivedTerminal[] = [];
    for (const item of prepared) {
      if (!item || this.isDisposed) {
        continue;
      }
      const { chat, terminal, launch, worktreePath } = item;
      if (!TerminalManager.isLiveTerminal(terminal)) {
        this.restoringChats.delete(chat.id);
        continue;
      }
      // A revived shell starts in the workspace root, not the chat's worktree.
      const command = TerminalManager.commandInDirectory(
        worktreePath,
        launch.command
      );
      this.restoringChats.delete(chat.id);
      const { integrated, started } = this.startTerminal(
        chat,
        terminal,
        command,
        RESTORED_SHELL_TIMEOUT_MS,
        true
      );
      await this.recordTerminalPid(chat.id, terminal, pids.get(terminal));
      revived.push({ terminal, integrated: integrated!, started });
    }

    this.retitleRevivedTerminals(revived);
  }

  /**
   * Re-apply Agntree's title to tabs that VS Code restored as new shells.
   *
   * An editor terminal is serialized with an empty cwd, so every revival makes
   * the shell report a cwd change and VS Code re-tags the title as a config
   * title. With that tag the revived shell's own title wins, and the next quit
   * restores a tab named after the shell instead of the chat. Only the active
   * tab can be renamed, so each tab is activated without taking focus and the
   * previously active tab is restored afterwards.
   *
   * Runs in the background so a slow shell start does not delay activation,
   * and stops as soon as the user takes over the active tab.
   */
  private retitleRevivedTerminals(revived: RevivedTerminal[]): void {
    if (revived.length === 0) {
      return;
    }
    const previous = vscode.window.activeTerminal;
    void (async () => {
      let expected = previous;
      for (const { terminal, integrated, started } of revived) {
        if (this.isDisposed || vscode.window.activeTerminal !== expected) {
          return;
        }
        // A shell without integration never re-tags the title, so its stored
        // title is already correct and there is nothing to re-apply.
        if (!(await integrated)) {
          continue;
        }
        await started;
        if (
          this.isDisposed ||
          vscode.window.activeTerminal !== expected ||
          !vscode.window.terminals.includes(terminal)
        ) {
          return;
        }
        let shown = false;
        await this.queueTitleWork(async () => {
          if (
            this.isDisposed ||
            vscode.window.activeTerminal !== expected ||
            !vscode.window.terminals.includes(terminal)
          ) {
            return;
          }
          await this.showForRetitle(terminal);
          await this.writeTitle(terminal);
          shown = true;
        });
        if (!shown) {
          return;
        }
        expected = terminal;
      }
      await this.queueTitleWork(async () => {
        if (
          !this.isDisposed &&
          previous &&
          vscode.window.terminals.includes(previous)
        ) {
          await this.showForRetitle(previous);
        }
      });
    })().catch(() => undefined);
  }
}
