import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { StorageService } from './StorageService';
import { HarnessId } from '../types';
import { HarnessSessionWatcher } from '../harnesses/types';
import { truncateName } from '../utils/text';

interface PendingChat {
  chatId: string;
  worktreePath: string;
  createdAt: number;
}

/**
 * Watches for new Claude Code sessions and auto-links them to pending chats.
 * Monitors .jsonl files directly since sessions-index.json may not update immediately.
 */
export class ClaudeSessionWatcher implements HarnessSessionWatcher {
  readonly harness: HarnessId = 'claude';

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

  private isSessionFile(filename: string): boolean {
    return filename.endsWith('.jsonl') && !filename.startsWith('agent-');
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
            if (this.isSessionFile(file)) {
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
        if (filename && this.isSessionFile(filename)) {
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
        // Never link one native session to two chats. Without this, a new
        // pending chat could claim a session that was just linked to another.
        if (this.isSessionLinkedToAnotherChat(sessionId, pending.chatId)) {
          continue;
        }

        // Found a match! Link the session to the chat
        const chat = this.storageService.getChat(pending.chatId);
        if (chat && !chat.harnessSessionId) {
          this.storageService.updateChat(pending.chatId, {
            harnessSessionId: sessionId,
          });

          // Remove from pending
          this.pendingChats.splice(i, 1);

          // Start monitoring for name updates
          this.monitorSessionForName(pending.chatId, filePath);

          console.log(`[ClaudeSessionWatcher] Linked session ${sessionId} to chat ${pending.chatId}`);
          return;
        }
      }
    }
  }

  /**
   * A native session belongs to exactly one chat. This prevents a newly
   * pending chat from claiming a session that was already linked (for example
   * when two new sessions are started in the same worktree in quick
   * succession).
   */
  private isSessionLinkedToAnotherChat(
    sessionId: string,
    chatId: string
  ): boolean {
    return this.storageService
      .getChats()
      .some(
        (chat) =>
          chat.id !== chatId &&
          chat.harness === 'claude' &&
          chat.harnessSessionId === sessionId
      );
  }

  /**
   * Register a chat as pending for session linkage
   */
  registerPendingChat(chatId: string, worktreePath: string): void {
    // Remove any existing pending entry for this chat
    this.pendingChats = this.pendingChats.filter(p => p.chatId !== chatId);

    this.pendingChats.push({
      chatId,
      worktreePath,
      createdAt: Date.now(),
    });

    // Ensure we're watching the correct project directory
    const encodedPath = this.encodeProjectPath(worktreePath);
    const projectDir = path.join(this.projectsDir, encodedPath);
    if (fs.existsSync(projectDir)) {
      this.watchProjectDir(projectDir);
      this.scanForUnlinkedSessions(projectDir);
    } else {
      // Directory doesn't exist yet — retry until it appears or chat is no longer active
      const retryInterval = setInterval(() => {
        const chat = this.storageService.getChat(chatId);
        if (!chat || chat.status !== 'active') {
          clearInterval(retryInterval);
          return;
        }
        if (fs.existsSync(projectDir)) {
          clearInterval(retryInterval);
          this.watchProjectDir(projectDir);
          this.scanForUnlinkedSessions(projectDir);
        }
      }, 5000);
      this.monitoringIntervals.set(`dir-${chatId}`, retryInterval);
    }

    this.ensurePendingChatPoller(projectDir);

    // Clean up old pending chats (older than 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    this.pendingChats = this.pendingChats.filter(p => p.createdAt > fiveMinutesAgo);
  }

  /** Scan for recent session files that weren't caught by fs.watch. */
  private scanForUnlinkedSessions(dirPath: string): void {
    if (this.pendingChats.length === 0) {
      return;
    }

    try {
      const files = fs.readdirSync(dirPath);
      const projectDirName = path.basename(dirPath);
      // Only consider files created in the last 2 minutes
      const cutoff = Date.now() - 2 * 60 * 1000;

      for (const file of files) {
        if (!this.isSessionFile(file)) {
          continue;
        }
        const filePath = path.join(dirPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.birthtimeMs < cutoff) {
            continue;
          }
        } catch {
          continue;
        }
        const sessionId = file.replace('.jsonl', '');
        this.knownSessions.add(sessionId);
        this.linkSessionToChatByProjectDir(filePath, sessionId, projectDirName);
      }
    } catch {
      // Directory may not be readable yet
    }
  }

  /**
   * Polling fallback — fs.watch on macOS can miss or coalesce events.
   */
  private ensurePendingChatPoller(projectDir: string): void {
    const pollerKey = `poller-${projectDir}`;
    if (this.monitoringIntervals.has(pollerKey)) {
      return;
    }

    const projectDirName = path.basename(projectDir);
    const poller = setInterval(() => {
      const hasPendingForDir = this.pendingChats.some(
        p => this.encodeProjectPath(p.worktreePath) === projectDirName
      );
      if (!hasPendingForDir) {
        clearInterval(poller);
        this.monitoringIntervals.delete(pollerKey);
        return;
      }

      this.scanForUnlinkedSessions(projectDir);
    }, 5000);

    this.monitoringIntervals.set(pollerKey, poller);
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

    const checkInterval = setInterval(() => {
      const chat = this.storageService.getChat(chatId);

      // Stop if chat was deleted, already renamed, or session is no longer running
      if (!chat || !chat.name.startsWith('New Session') || chat.status !== 'active') {
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
      }
    }, 5000);

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

          // Get first usable user prompt — skip slash commands and injected system content
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
            const trimmed = text.trimStart();
            if (trimmed && !trimmed.startsWith('/') && !trimmed.startsWith('<')) {
              firstUserPrompt = trimmed;
            }
          }
        } catch {
          // Skip invalid JSON
        }
      }

      // Return summary if available, otherwise first prompt
      if (summary) {
        return truncateName(summary);
      }

      if (firstUserPrompt) {
        return truncateName(firstUserPrompt);
      }

      return null;
    } catch {
      return null;
    }
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
