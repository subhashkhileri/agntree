import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

/**
 * Represents an existing Claude Code session discovered from ~/.claude/projects
 */
export interface ClaudeSession {
  /** Session UUID (filename without .jsonl) */
  sessionId: string;
  /** Working directory where session was created */
  cwd: string;
  /** Session summary/description (if available) */
  summary: string | null;
  /** Git branch (if available) */
  gitBranch: string | null;
  /** Timestamp of last message */
  lastUpdated: Date | null;
  /** Path to the session file */
  filePath: string;
  /** Number of messages in session */
  messageCount: number;
}

/**
 * Service for discovering existing Claude Code sessions
 */
export class ClaudeSessionService {
  private claudeDir: string;
  private projectsDir: string;

  constructor() {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    this.claudeDir = path.join(homeDir, '.claude');
    this.projectsDir = path.join(this.claudeDir, 'projects');
  }

  /**
   * Check if Claude Code is installed (has a .claude directory)
   */
  isClaudeInstalled(): boolean {
    return fs.existsSync(this.claudeDir);
  }

  /**
   * Get all project directories
   */
  getProjectDirs(): string[] {
    if (!fs.existsSync(this.projectsDir)) {
      return [];
    }

    try {
      return fs.readdirSync(this.projectsDir)
        .filter(name => !name.startsWith('.'))
        .map(name => path.join(this.projectsDir, name))
        .filter(p => {
          try {
            return fs.statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  /**
   * Get all sessions in a project directory
   */
  private async getSessionsInDir(projectDir: string): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];

    let files: string[];
    try {
      files = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
    } catch {
      return [];
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');

      try {
        const session = await this.parseSessionFile(filePath, sessionId);
        if (session) {
          sessions.push(session);
        }
      } catch (err) {
        // Skip files that can't be parsed
        console.error(`Failed to parse session ${file}:`, err);
      }
    }

    return sessions;
  }

  /**
   * Parse a session file to extract metadata
   */
  private async parseSessionFile(filePath: string, sessionId: string): Promise<ClaudeSession | null> {
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      return null;
    }

    // Skip empty files
    if (stats.size === 0) {
      return null;
    }

    const session: ClaudeSession = {
      sessionId,
      cwd: '',
      summary: null,
      gitBranch: null,
      lastUpdated: stats.mtime,
      filePath,
      messageCount: 0,
    };

    // Read file content synchronously (simpler and more reliable)
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let firstUserPrompt: string | null = null;

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Get summary (prefer the last one as it's usually most descriptive)
          if (entry.type === 'summary' && entry.summary) {
            session.summary = entry.summary;
          }

          // Get first user prompt as fallback for summary
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

          // Get cwd and branch from user/assistant messages
          if (entry.cwd && !session.cwd) {
            session.cwd = entry.cwd;
          }

          if (entry.gitBranch && !session.gitBranch) {
            session.gitBranch = entry.gitBranch;
          }

          // Count messages
          if (entry.type === 'user' || entry.type === 'assistant') {
            session.messageCount++;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      // Use first user prompt as fallback if no summary
      if (!session.summary && firstUserPrompt) {
        session.summary = this.truncateName(firstUserPrompt);
      }
    } catch {
      return null;
    }

    // Skip sessions without a working directory
    if (!session.cwd) {
      return null;
    }

    return session;
  }

  /**
   * Get all sessions across all projects
   */
  async getAllSessionsFlat(): Promise<ClaudeSession[]> {
    const allSessions: ClaudeSession[] = [];
    const projectDirs = this.getProjectDirs();

    for (const dir of projectDirs) {
      const sessions = await this.getSessionsInDir(dir);
      allSessions.push(...sessions);
    }

    // Sort by last updated, most recent first
    allSessions.sort((a, b) => {
      if (!a.lastUpdated) return 1;
      if (!b.lastUpdated) return -1;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });

    return allSessions;
  }

  /**
   * Find sessions matching a worktree path
   * Matches sessions where the session's cwd equals or starts with the worktree path
   */
  async findSessionsForWorktree(worktreePath: string): Promise<ClaudeSession[]> {
    const normalizedPath = path.resolve(worktreePath);
    const allSessions = await this.getAllSessionsFlat();

    // Filter sessions that match this worktree
    const matching = allSessions.filter(session => {
      const sessionCwd = path.resolve(session.cwd);
      // Exact match or session is in a subdirectory of worktree
      return sessionCwd === normalizedPath || sessionCwd.startsWith(normalizedPath + '/');
    });

    return matching;
  }

  /**
   * Find all sessions related to a repository (main worktree + all worktrees)
   * Matches sessions whose cwd equals or is a subdirectory of any provided path
   */
  async findSessionsForRepository(repoRootPath: string, worktreePaths: string[]): Promise<ClaudeSession[]> {
    // Collect all paths to check: repo root + all worktree paths (deduplicated)
    const normalizedPaths = new Set<string>();
    normalizedPaths.add(path.resolve(repoRootPath));
    for (const wtPath of worktreePaths) {
      normalizedPaths.add(path.resolve(wtPath));
    }

    const allSessions = await this.getAllSessionsFlat();

    return allSessions.filter(session => {
      const sessionCwd = path.resolve(session.cwd);
      for (const normalizedPath of normalizedPaths) {
        if (sessionCwd === normalizedPath || sessionCwd.startsWith(normalizedPath + '/')) {
          return true;
        }
      }
      return false;
    });
  }

  /**
   * Get sessions grouped by their cwd
   */
  async getSessionsGroupedByCwd(): Promise<Map<string, ClaudeSession[]>> {
    const allSessions = await this.getAllSessionsFlat();
    const grouped = new Map<string, ClaudeSession[]>();

    for (const session of allSessions) {
      const cwd = session.cwd;
      if (!grouped.has(cwd)) {
        grouped.set(cwd, []);
      }
      grouped.get(cwd)!.push(session);
    }

    return grouped;
  }

  /**
   * Get session info by session ID
   */
  async getSessionById(sessionId: string): Promise<ClaudeSession | null> {
    const projectDirs = this.getProjectDirs();

    for (const dir of projectDirs) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(filePath)) {
        return this.parseSessionFile(filePath, sessionId);
      }
    }

    return null;
  }

  /**
   * Quick check if a session is resumable (has actual conversation content)
   * This is faster than full parsing - just checks for user/assistant messages
   */
  isSessionResumable(sessionId: string): boolean {
    const projectDirs = this.getProjectDirs();

    for (const dir of projectDirs) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            // A session is resumable if it has user or assistant messages
            if (entry.type === 'user' || entry.type === 'assistant') {
              return true;
            }
          } catch {
            // Skip invalid JSON
          }
        }
        // File exists but no conversation content
        return false;
      } catch {
        return false;
      }
    }

    // Session file not found
    return false;
  }

  /**
   * Encode a worktree path to Claude's project directory format
   * Claude replaces all path separators and dots with dashes
   * (Based on CCManager's pathToClaudeProjectName implementation)
   */
  encodeProjectPath(worktreePath: string): string {
    const normalizedPath = path.resolve(worktreePath);
    // Replace all forward slashes, backslashes, and dots with dashes
    return normalizedPath.replace(/[/\\.]/g, '-');
  }

  /**
   * Get the Claude project directory for a worktree path
   */
  getProjectDir(worktreePath: string): string {
    const encoded = this.encodeProjectPath(worktreePath);
    return path.join(this.projectsDir, encoded);
  }

  /**
   * Copy all session data from one worktree's project folder to another
   * This enables forking sessions across worktrees
   * (Based on CCManager's copyClaudeSessionData implementation)
   */
  copySessionToWorktree(sessionId: string, sourceWorktreePath: string, destWorktreePath: string): boolean {
    try {
      const sourceProjectDir = this.getProjectDir(sourceWorktreePath);
      const destProjectDir = this.getProjectDir(destWorktreePath);

      if (!fs.existsSync(sourceProjectDir)) {
        console.error(`Source project directory not found: ${sourceProjectDir}`);
        return false;
      }

      // Copy the entire project directory recursively
      // This preserves all session files and context
      fs.cpSync(sourceProjectDir, destProjectDir, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
      });

      return true;
    } catch (error) {
      console.error('Failed to copy session data:', error);
      return false;
    }
  }

  /**
   * Get the last few user messages from a session (for preview)
   */
  getSessionPreview(sessionId: string, maxMessages: number = 3): string[] {
    const projectDirs = this.getProjectDirs();
    const messages: string[] = [];

    for (const dir of projectDirs) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        // Collect user messages
        const userMessages: string[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message) {
              // Get the text content from the message
              let text = '';
              if (typeof entry.message === 'string') {
                text = entry.message;
              } else if (entry.message.content) {
                // Handle array of content blocks
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
                // Truncate long messages
                const truncated = text.length > 100 ? text.substring(0, 100) + '...' : text;
                userMessages.push(truncated.replace(/\n/g, ' '));
              }
            }
          } catch {
            // Skip invalid lines
          }
        }

        // Return last N messages
        return userMessages.slice(-maxMessages);
      } catch {
        return [];
      }
    }

    return messages;
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
}
