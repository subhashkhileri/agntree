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
      const lines = content.split('\n').slice(0, 100); // Read first 100 lines max

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Get summary (prefer the last one as it's usually most descriptive)
          if (entry.type === 'summary' && entry.summary) {
            session.summary = entry.summary;
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
}
