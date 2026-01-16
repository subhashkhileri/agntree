import * as vscode from 'vscode';
import { ChatSession, Worktree } from '../types';
import { StorageService } from './StorageService';

/**
 * Manages VS Code terminal instances for Claude Code chat sessions
 */
export class TerminalManager {
  /** Map of chat ID to terminal instance */
  private terminals: Map<string, vscode.Terminal> = new Map();

  /** Map of terminal to chat ID (for reverse lookup on close) */
  private terminalToChatId: Map<vscode.Terminal, string> = new Map();

  /** Event emitter for terminal state changes */
  private _onTerminalStateChange = new vscode.EventEmitter<{
    chatId: string;
    state: 'opened' | 'closed';
  }>();
  public readonly onTerminalStateChange = this._onTerminalStateChange.event;

  constructor(private storageService: StorageService) {
    // Listen for terminal close events
    vscode.window.onDidCloseTerminal((terminal) => {
      const chatId = this.terminalToChatId.get(terminal);
      if (chatId) {
        this.handleTerminalClosed(chatId, terminal);
      }
    });
  }

  /**
   * Open a chat in a terminal (creates new or focuses existing)
   */
  openChat(chat: ChatSession, worktree: Worktree): vscode.Terminal {
    // Check if terminal already exists
    const existingTerminal = this.terminals.get(chat.id);
    if (existingTerminal) {
      existingTerminal.show();
      return existingTerminal;
    }

    // Build the command arguments
    const args: string[] = [];

    // If we have a Claude session ID, resume it
    if (chat.claudeSessionId) {
      args.push('--resume', chat.claudeSessionId);
    }

    // Create new terminal in the editor area (not the bottom panel)
    const terminal = vscode.window.createTerminal({
      name: `Claude: ${chat.name}`,
      cwd: worktree.path,
      iconPath: new vscode.ThemeIcon('comment-discussion'),
      location: vscode.TerminalLocation.Editor,
    });

    // Store mappings
    this.terminals.set(chat.id, terminal);
    this.terminalToChatId.set(terminal, chat.id);

    // Send the claude command
    const command = args.length > 0 ? `claude ${args.join(' ')}` : 'claude';
    terminal.sendText(command);
    terminal.show();

    // Update chat status
    this.storageService.updateChat(chat.id, {
      status: 'active',
      lastAccessedAt: Date.now(),
    });

    this._onTerminalStateChange.fire({ chatId: chat.id, state: 'opened' });

    return terminal;
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
    return this.terminals.has(chatId);
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

    // Update chat status
    this.storageService.updateChat(chatId, {
      status: 'closed',
    });

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
    // We can't reliably detect which existing terminals are Claude sessions
    // so we just mark all stored chats as 'idle' on activation
    const chats = this.storageService.getChats();
    for (const chat of chats) {
      if (chat.status === 'active') {
        this.storageService.updateChat(chat.id, { status: 'idle' });
      }
    }
  }
}
