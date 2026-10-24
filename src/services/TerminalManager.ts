import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { StorageService } from './StorageService';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessAdapter } from '../harnesses/types';

/**
 * Manages VS Code terminal instances for chat sessions across harnesses.
 */
export class TerminalManager {
  /** Map of chat ID to terminal instance */
  private terminals: Map<string, vscode.Terminal> = new Map();

  /** Map of terminal to chat ID (for reverse lookup on close) */
  private terminalToChatId: Map<vscode.Terminal, string> = new Map();

  /** Disposable for terminal close listener */
  private onCloseTerminalDisposable: vscode.Disposable;

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
   * Parse the chat ID from a terminal name
   * Returns the short ID if found, null otherwise
   */
  static parseChatIdFromTerminalName(terminalName: string): string | null {
    if (!terminalName.startsWith(TerminalManager.TERMINAL_PREFIX)) {
      return null;
    }
    // Match the [shortId] at the end of the name
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
   * output), so presence alone does not mean the session is open. Treating an
   * exited terminal as live leaves the row marked running while `show()`
   * focuses a dead tab.
   */
  private static isLiveTerminal(terminal: vscode.Terminal): boolean {
    return (
      vscode.window.terminals.includes(terminal) &&
      terminal.exitStatus === undefined
    );
  }

  constructor(
    private storageService: StorageService,
    private harnessRegistry: HarnessRegistry
  ) {
    // Listen for terminal close events
    this.onCloseTerminalDisposable = vscode.window.onDidCloseTerminal((terminal) => {
      const chatId = this.terminalToChatId.get(terminal);
      if (chatId) {
        this.handleTerminalClosed(chatId, terminal);
      }
    });
  }

  /**
   * Open a chat in a terminal (creates new or focuses existing)
   */
  async openChat(
    chat: ChatSession,
    worktree: Worktree
  ): Promise<vscode.Terminal | undefined> {
    // Check if terminal already exists and is still valid
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

    // Also check if there's an existing terminal by name that we can reuse
    // Use the unique terminal name that includes chat.id to avoid collisions
    const terminalName = TerminalManager.getTerminalName(chat);
    // An exited terminal with this name cannot be resumed in place.
    for (const terminal of vscode.window.terminals) {
      if (
        terminal.name === terminalName &&
        terminal.exitStatus !== undefined
      ) {
        terminal.dispose();
      }
    }
    const existingByName = vscode.window.terminals.find(
      (terminal) =>
        terminal.name === terminalName && terminal.exitStatus === undefined
    );
    if (existingByName) {
      // Re-register this terminal
      this.terminals.set(chat.id, existingByName);
      this.terminalToChatId.set(existingByName, chat.id);
      existingByName.show();
      return existingByName;
    }

    const adapter = this.harnessRegistry.get(chat.harness);
    const pendingId = chat.pendingHarnessSessionId ?? undefined;
    // A terminal fork that has not linked yet keeps its source on the chat, so
    // reopening it from any path repeats the fork rather than starting fresh.
    const forkSource = !chat.harnessSessionId
      ? chat.forkedFromSessionId ?? undefined
      : undefined;

    let sessionId: string | undefined;
    let newSessionId: string | undefined;
    let forkFrom: string | undefined;

    // A pending ID whose transcript already exists means the watcher has not
    // caught up (or failed to); resume it instead of forking/launching again.
    if (pendingId && (await this.isResumable(adapter, pendingId, worktree.path))) {
      sessionId = pendingId;
    } else if (forkSource) {
      // A terminal fork starts from the source and writes under the chosen ID.
      forkFrom = forkSource;
      newSessionId = pendingId;
    } else if (chat.harnessSessionId) {
      if (
        !(await this.isResumable(adapter, chat.harnessSessionId, worktree.path))
      ) {
        this.showMissingSessionWarning(chat, adapter);
        return undefined;
      }
      sessionId = chat.harnessSessionId;
    } else {
      newSessionId = pendingId;
    }

    let launchCommand: string;
    try {
      launchCommand = adapter.buildLaunchCommand({
        worktreePath: worktree.path,
        sessionId,
        newSessionId,
        forkFromSessionId: forkFrom,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(
        `Could not open the ${adapter.displayName} session: ${message}`
      );
      return undefined;
    }

    // Create new terminal in the editor area (not the bottom panel)
    const terminal = vscode.window.createTerminal({
      name: terminalName,
      cwd: worktree.path,
      iconPath: new vscode.ThemeIcon(adapter.icon),
      location: vscode.TerminalLocation.Editor,
    });

    // Store mappings
    this.terminals.set(chat.id, terminal);
    this.terminalToChatId.set(terminal, chat.id);

    terminal.sendText(launchCommand);
    terminal.show();

    // Update chat status
    this.storageService.updateChat(chat.id, {
      status: 'active',
      lastAccessedAt: Date.now(),
    });

    this._onTerminalStateChange.fire({ chatId: chat.id, state: 'opened' });

    return terminal;
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
    // process exited while its tab stayed listed.
    this.terminals.delete(chatId);
    this.terminalToChatId.delete(terminal);
    return false;
  }

  /**
   * Whether `openChat` would reuse a terminal for this chat, through the stored
   * map or the deterministic terminal name. Callers use it to avoid preparing a
   * launch that will not create a native session.
   */
  hasTerminal(chat: ChatSession): boolean {
    const terminal = this.terminals.get(chat.id);
    if (terminal && TerminalManager.isLiveTerminal(terminal)) {
      return true;
    }

    const name = TerminalManager.getTerminalName(chat);
    return vscode.window.terminals.some(
      (candidate) =>
        candidate.name === name && candidate.exitStatus === undefined
    );
  }

  /**
   * Get the terminal for a chat
   */
  getTerminal(chatId: string): vscode.Terminal | undefined {
    return this.terminals.get(chatId);
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
      // Update chat status
      this.storageService.updateChat(chatId, {
        status: 'closed',
      });
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
    this.onCloseTerminalDisposable.dispose();
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
    this.terminalToChatId.clear();
    this._onTerminalStateChange.dispose();
  }

  /**
   * Sync terminals with existing VS Code terminals on activation
   * (Handles case where extension is reloaded but terminals are still open)
   */
  syncWithExistingTerminals(): void {
    const chats = this.storageService.getChats();
    const existingTerminals = vscode.window.terminals;

    // Build a map of short chat ID -> chat for quick lookup
    const chatsByShortId = new Map<string, typeof chats[0]>();
    for (const chat of chats) {
      const shortId = chat.id.substring(0, 6);
      chatsByShortId.set(shortId, chat);
    }

    // Check each existing terminal
    for (const terminal of existingTerminals) {
      // Parse the chat ID from the terminal name
      const shortId = TerminalManager.parseChatIdFromTerminalName(terminal.name);

      if (shortId) {
        const chat = chatsByShortId.get(shortId);

        // An exited terminal cannot resume a session; leave it for VS Code and
        // let the chat start closed below.
        if (chat && terminal.exitStatus === undefined) {
          // Re-register this terminal
          this.terminals.set(chat.id, terminal);
          this.terminalToChatId.set(terminal, chat.id);

          // Update chat status to active
          this.storageService.updateChat(chat.id, { status: 'active' });

          this._onTerminalStateChange.fire({ chatId: chat.id, state: 'opened' });
        }
      }
    }

    // Mark chats without terminals as idle (if they were previously active)
    for (const chat of chats) {
      if (chat.status === 'active' && !this.terminals.has(chat.id)) {
        this.storageService.updateChat(chat.id, { status: 'idle' });
      }
    }
  }
}
