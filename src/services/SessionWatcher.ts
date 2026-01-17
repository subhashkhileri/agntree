import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StorageService } from './StorageService';
import { Worktree } from '../types';

interface PendingChat {
  chatId: string;
  worktreePath: string;
  createdAt: number;
}

/**
 * Watches for new Claude Code sessions and auto-links them to pending chats.
 * Monitors .jsonl files directly since sessions-index.json may not update immediately.
 */
export class SessionWatcher {
  private projectsDir: string;
  private projectWatchers: Map<string, fs.FSWatcher> = new Map();
  private pendingChats: PendingChat[] = [];
  private monitoringIntervals: Map<string, NodeJS.Timeout> = new Map();
  private knownSessions: Set<string> = new Set();

  /** Event emitter for when a chat name is updated */
  private _onChatNameUpdated = new vscode.EventEmitter<{ chatId: string; name: string }>();
  public readonly onChatNameUpdated = this._onChatNameUpdated.event;

  constructor(private storageService: StorageService) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.projectsDir = path.join(homeDir, '.claude', 'projects');
  }

  /**
   * Start watching for new Claude sessions
   */
  startWatching(): void {
    if (!fs.existsSync(this.projectsDir)) {
      console.log('Claude projects directory does not exist yet');
      return;
    }

    // Catalog all existing sessions so we know what's new
    this.catalogExistingSessions();
    this.watchExistingProjectDirs();
  }

  /**
   * Build a set of all existing session IDs
   */
  private catalogExistingSessions(): void {
    try {
      const dirs = fs.readdirSync(this.projectsDir)
        .filter(name => !name.startsWith('.'))
        .map(name => path.join(this.projectsDir, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });

      for (const dir of dirs) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.endsWith('.jsonl') && !file.startsWith('agent-')) {
              const sessionId = file.replace('.jsonl', '');
              this.knownSessions.add(sessionId);
            }
          }
        } catch {
          // Skip directories we can't read
        }
      }
      console.log(`Cataloged ${this.knownSessions.size} existing sessions`);
    } catch (error) {
      console.error('Failed to catalog existing sessions:', error);
    }
  }

  /**
   * Watch all existing project directories for new session files
   */
  private watchExistingProjectDirs(): void {
    try {
      const dirs = fs.readdirSync(this.projectsDir)
        .filter(name => !name.startsWith('.'))
        .map(name => path.join(this.projectsDir, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });

      for (const dir of dirs) {
        this.watchProjectDir(dir);
      }
    } catch (error) {
      console.error('Failed to watch existing project dirs:', error);
    }
  }

  /**
   * Watch a project directory for new session files
   */
  private watchProjectDir(dirPath: string): void {
    if (this.projectWatchers.has(dirPath)) {
      return; // Already watching
    }

    try {
      const watcher = fs.watch(dirPath, { persistent: false }, (_eventType, filename) => {
        if (filename && filename.endsWith('.jsonl') && !filename.startsWith('agent-')) {
          const sessionId = filename.replace('.jsonl', '');

          // Only process sessions we haven't seen before
          if (!this.knownSessions.has(sessionId)) {
            this.knownSessions.add(sessionId);
            const filePath = path.join(dirPath, filename);
            this.handleNewSession(filePath, sessionId, dirPath);
          }
        }
      });

      this.projectWatchers.set(dirPath, watcher);
    } catch (error) {
      console.error(`Failed to watch project dir ${dirPath}:`, error);
    }
  }

  /**
   * Handle a newly created session file
   */
  private handleNewSession(filePath: string, sessionId: string, projectDir: string): void {
    if (this.pendingChats.length === 0) {
      return;
    }

    // Use the project directory name to match pending chats
    // This is more reliable than parsing cwd from the session file, which may only have snapshot entries
    const projectDirName = path.basename(projectDir);
    this.linkSessionToChatByProjectDir(filePath, sessionId, projectDirName);
  }

  /**
   * Try to link a session to a pending chat using project directory name
   * This matches the encoded worktree path to the project directory name
   */
  private linkSessionToChatByProjectDir(filePath: string, sessionId: string, projectDirName: string): void {
    // Find a matching pending chat by comparing encoded paths
    for (let i = this.pendingChats.length - 1; i >= 0; i--) {
      const pending = this.pendingChats[i];
      const encodedWorktreePath = this.encodeProjectPath(pending.worktreePath);

      // Check if the encoded worktree path matches the project directory name
      if (encodedWorktreePath === projectDirName) {
        // Found a match! Link the session to the chat
        const chat = this.storageService.getChat(pending.chatId);
        if (chat && !chat.claudeSessionId) {
          this.storageService.updateChat(pending.chatId, {
            claudeSessionId: sessionId,
          });

          // Remove from pending
          this.pendingChats.splice(i, 1);

          // Start monitoring for name updates
          this.monitorSessionForName(pending.chatId, filePath);

          console.log(`[SessionWatcher] Linked session ${sessionId} to chat ${pending.chatId}`);
          return;
        }
      }
    }
  }

  /**
   * Register a chat as pending for session linkage
   */
  registerPendingChat(chatId: string, worktree: Worktree): void {
    // Remove any existing pending entry for this chat
    this.pendingChats = this.pendingChats.filter(p => p.chatId !== chatId);

    this.pendingChats.push({
      chatId,
      worktreePath: worktree.path,
      createdAt: Date.now(),
    });

    // Ensure we're watching the correct project directory
    const encodedPath = this.encodeProjectPath(worktree.path);
    const projectDir = path.join(this.projectsDir, encodedPath);
    if (fs.existsSync(projectDir)) {
      this.watchProjectDir(projectDir);
    }

    // Clean up old pending chats (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    this.pendingChats = this.pendingChats.filter(p => p.createdAt > fiveMinutesAgo);
  }

  /**
   * Encode a path to match Claude's project directory naming
   * Claude replaces forward slashes, backslashes, and dots with dashes
   */
  private encodeProjectPath(projectPath: string): string {
    const normalizedPath = path.resolve(projectPath);
    return normalizedPath.replace(/[/\\.]/g, '-');
  }

  /**
   * Monitor a session file for name updates (first prompt or summary)
   */
  private monitorSessionForName(chatId: string, sessionFilePath: string): void {
    // Clear any existing interval for this chat
    const existingInterval = this.monitoringIntervals.get(chatId);
    if (existingInterval) {
      clearInterval(existingInterval);
    }

    let checkCount = 0;
    const maxChecks = 60; // Check for up to ~60 seconds

    const checkInterval = setInterval(() => {
      checkCount++;

      const chat = this.storageService.getChat(chatId);
      if (!chat || !chat.name.startsWith('New Chat')) {
        clearInterval(checkInterval);
        this.monitoringIntervals.delete(chatId);
        return;
      }

      const nameFromFile = this.extractNameFromSessionFile(sessionFilePath);
      if (nameFromFile) {
        this.storageService.renameChat(chatId, nameFromFile);
        this._onChatNameUpdated.fire({ chatId, name: nameFromFile });
        clearInterval(checkInterval);
        this.monitoringIntervals.delete(chatId);
        return;
      }

      if (checkCount >= maxChecks) {
        clearInterval(checkInterval);
        this.monitoringIntervals.delete(chatId);
      }
    }, 1000);

    this.monitoringIntervals.set(chatId, checkInterval);
  }

  /**
   * Extract name from session file (looks for summary or first user message)
   */
  private extractNameFromSessionFile(filePath: string): string | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let summary: string | null = null;
      let firstUserPrompt: string | null = null;

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Check for summary (prefer the latest one)
          if (entry.type === 'summary' && entry.summary) {
            summary = entry.summary;
          }

          // Get first user prompt
          if (!firstUserPrompt && entry.type === 'user' && entry.message) {
            let text = '';
            if (typeof entry.message === 'string') {
              text = entry.message;
            } else if (entry.message.content) {
              if (Array.isArray(entry.message.content)) {
                for (const block of entry.message.content) {
                  if (block.type === 'text' && block.text) {
                    text = block.text;
                    break;
                  }
                }
              } else if (typeof entry.message.content === 'string') {
                text = entry.message.content;
              }
            }
            if (text) {
              firstUserPrompt = text;
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }

      // Return summary if available, otherwise first prompt
      if (summary) {
        return this.truncateName(summary);
      }

      if (firstUserPrompt) {
        return this.truncateName(firstUserPrompt);
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Truncate a name to a reasonable length for display
   */
  private truncateName(text: string): string {
    // Clean up the text
    const cleaned = text
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Truncate to ~50 chars, respecting word boundaries
    if (cleaned.length <= 50) {
      return cleaned;
    }

    const truncated = cleaned.substring(0, 50);
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 30) {
      return truncated.substring(0, lastSpace) + '...';
    }
    return truncated + '...';
  }

  /**
   * Stop watching and clean up
   */
  dispose(): void {
    for (const watcher of this.projectWatchers.values()) {
      watcher.close();
    }
    this.projectWatchers.clear();

    for (const interval of this.monitoringIntervals.values()) {
      clearInterval(interval);
    }
    this.monitoringIntervals.clear();

    this._onChatNameUpdated.dispose();
  }
}
