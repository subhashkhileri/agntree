import * as fs from 'fs';
import * as path from 'path';
import { truncateName } from '../utils/text';
import { isWithin } from '../utils/paths';

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
  /** Latest recap from away_summary entries (if available) */
  recap: string | null;
  /** Git branch (if available) */
  gitBranch: string | null;
  /** Timestamp of last message */
  lastUpdated: Date | null;
  /** Timestamp of the last user prompt, if any */
  lastPromptAt: number | null;
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
      recap: null,
      gitBranch: null,
      lastUpdated: stats.mtime,
      lastPromptAt: null,
      filePath,
      messageCount: 0,
    };

    // Read file content synchronously (simpler and more reliable)
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      let firstUserPrompt: string | null = null;
      let latestRecapTimestamp = 0;

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Get summary (prefer the last one as it's usually most descriptive)
          if (entry.type === 'summary' && entry.summary) {
            session.summary = entry.summary;
          }

          // Get recap from away_summary entries — keep the most recent by timestamp
          if (entry.type === 'system' && entry.subtype === 'away_summary' && entry.content) {
            const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;
            if (ts >= latestRecapTimestamp) {
              latestRecapTimestamp = ts;
              // Strip the trailing "(disable recaps in /config)" hint
              session.recap = entry.content.replace(/\s*\(disable recaps in \/config\)\s*$/, '').trim();
            }
          }

          // Get first usable user prompt as fallback for summary
          // Skip slash commands (/model, /config, etc.) and injected system content (<...>)
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

          // Track the latest user prompt timestamp for sorting/metadata
          if (entry.type === 'user' && entry.timestamp) {
            const ts = new Date(entry.timestamp).getTime();
            if (!isNaN(ts)) {
              session.lastPromptAt = ts;
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
        session.summary = truncateName(firstUserPrompt);
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
   * Claude stores each session under `<projects>/<encoded cwd>`. A worktree's
   * sessions live in its own project dir, and sessions started in a
   * subdirectory encode as `<worktree>-<subdir>`, so only those dirs need to
   * be parsed.
   *
   * The name match is deliberately a superset: the encoding is lossy
   * (`/x/repo-other` encodes like `/x/repo/other`), and callers still verify
   * the parsed `cwd`.
   */
  private getProjectDirsForPaths(paths: string[]): string[] {
    const encodedRoots = paths.map((worktreePath) =>
      this.encodeProjectPath(worktreePath)
    );

    return this.getProjectDirs().filter((dir) => {
      const name = path.basename(dir);
      return encodedRoots.some(
        (root) => name === root || name.startsWith(`${root}-`)
      );
    });
  }

  /**
   * Parse sessions from the given project dirs, most recently updated first.
   */
  private async getSessionsInDirs(dirs: string[]): Promise<ClaudeSession[]> {
    const sessions: ClaudeSession[] = [];
    for (const dir of dirs) {
      sessions.push(...(await this.getSessionsInDir(dir)));
    }

    sessions.sort((a, b) => {
      if (!a.lastUpdated) return 1;
      if (!b.lastUpdated) return -1;
      return b.lastUpdated.getTime() - a.lastUpdated.getTime();
    });

    return sessions;
  }

  /**
   * Find sessions matching a worktree path
   * Matches sessions where the session's cwd equals or is inside the worktree
   */
  async findSessionsForWorktree(worktreePath: string): Promise<ClaudeSession[]> {
    const sessions = await this.getSessionsInDirs(
      this.getProjectDirsForPaths([worktreePath])
    );

    // The directory match can over-include when encoding is ambiguous; keep
    // the exact cwd check as the source of truth.
    return sessions.filter((session) => isWithin(session.cwd, worktreePath));
  }

  /**
   * Find all sessions related to a repository (main worktree + all worktrees)
   * Matches sessions whose cwd equals or is inside any provided path
   */
  async findSessionsForRepository(repoRootPath: string, worktreePaths: string[]): Promise<ClaudeSession[]> {
    const roots = [repoRootPath, ...worktreePaths];
    const sessions = await this.getSessionsInDirs(
      this.getProjectDirsForPaths(roots)
    );

    return sessions.filter((session) =>
      roots.some((root) => isWithin(session.cwd, root))
    );
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
  getSessionPreview(sessionId: string, maxMessages: number = 3): { text: string; timestamp: number | null }[] {
    const projectDirs = this.getProjectDirs();

    for (const dir of projectDirs) {
      const filePath = path.join(dir, `${sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const userMessages: { text: string; timestamp: number | null }[] = [];

        for (const line of content.split('\n')) {
          if (!line.trim()) { continue; }
          try {
            const entry = JSON.parse(line);
            if (entry.type === 'user' && entry.message) {
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
                const truncated = trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed;
                const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
                userMessages.push({ text: truncated.replace(/\n/g, ' '), timestamp: isNaN(ts as number) ? null : ts });
              }
            }
          } catch {
            // Skip invalid lines
          }
        }

        return userMessages.slice(-maxMessages);
      } catch {
        return [];
      }
    }

    return [];
  }
}
