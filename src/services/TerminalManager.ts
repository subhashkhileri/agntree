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
  private static getTerminalName(chat: ChatSession): string {
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
   * @param forkFromSessionId - If provided, forks from this session in the harness
   */
  async openChat(
    chat: ChatSession,
    worktree: Worktree,
    forkFromSessionId?: string
  ): Promise<vscode.Terminal | undefined> {
    // Check if terminal already exists and is still valid
    const existingTerminal = this.terminals.get(chat.id);
    if (existingTerminal) {
      // Verify terminal is still in VS Code's list of terminals
      const isStillAlive = vscode.window.terminals.includes(existingTerminal);
      if (isStillAlive) {
        existingTerminal.show();
        return existingTerminal;
      } else {
        // Terminal was closed but we missed the event - clean up
        this.terminals.delete(chat.id);
        this.terminalToChatId.delete(existingTerminal);
      }
    }

    // Also check if there's an existing terminal by name that we can reuse
    // Use the unique terminal name that includes chat.id to avoid collisions
    const terminalName = TerminalManager.getTerminalName(chat);
    const existingByName = vscode.window.terminals.find(t => t.name === terminalName);
    if (existingByName) {
      // Re-register this terminal
      this.terminals.set(chat.id, existingByName);
      this.terminalToChatId.set(existingByName, chat.id);
      existingByName.show();
      return existingByName;
    }

    const adapter = this.harnessRegistry.get(chat.harness);
    // A fork terminal starts from the source session; otherwise resume the
    // chat's own session, if it has one.
    const resumeId = forkFromSessionId
      ? undefined
      : chat.harnessSessionId ?? undefined;

    // Verify the session still exists before trying to resume it.
    if (resumeId && !(await this.isResumable(adapter, resumeId, worktree.path))) {
      this.showMissingSessionWarning(chat, adapter);
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

    terminal.sendText(
      adapter.buildLaunchCommand({
        worktreePath: worktree.path,
        sessionId: resumeId,
        forkFromSessionId,
      })
    );
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
    cwd: string
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
        `Session not found or has no conversation in ${adapter.displayName}. This can happen if a forked session was closed without interaction.`,
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
    // Verify terminal is still alive
    const isStillAlive = vscode.window.terminals.includes(terminal);
    if (!isStillAlive) {
      // Clean up stale reference
      this.terminals.delete(chatId);
      this.terminalToChatId.delete(terminal);
      return false;
    }
    return true;
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

    if (chat && !chat.harnessSessionId) {
      // Session was closed without any conversation - delete it
      this.storageService.deleteChat(chatId);
      vscode.commands.executeCommand('agntree.refreshWorkspaces');
    } else {
      // Update chat status
      this.storageService.updateChat(chatId, {
        status: 'closed',
      });
    }

    this._onTerminalStateChange.fire({ chatId, state: 'closed' });
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

        if (chat) {
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
