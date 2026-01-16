import { execSync } from 'child_process';
import * as path from 'path';
import { Worktree, FileChange, generateId } from '../types';

/**
 * Service for git operations including worktree management and change tracking
 */
export class GitService {
  /**
   * Check if a directory is a git repository
   */
  isGitRepository(dirPath: string): boolean {
    try {
      execSync('git rev-parse --git-dir', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the root path of the git repository
   */
  getRepoRoot(dirPath: string): string | null {
    try {
      const result = execSync('git rev-parse --show-toplevel', {
        cwd: dirPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * List all worktrees for a repository
   */
  listWorktrees(repoPath: string, repoId: string): Worktree[] {
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const worktrees: Worktree[] = [];
      const entries = output.trim().split('\n\n');

      for (const entry of entries) {
        if (!entry.trim()) continue;

        const lines = entry.split('\n');
        let worktreePath = '';
        let branch = '';
        let isMain = false;

        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            worktreePath = line.substring(9);
          } else if (line.startsWith('branch ')) {
            // refs/heads/main -> main
            branch = line.substring(7).replace('refs/heads/', '');
          } else if (line === 'bare') {
            // Skip bare repositories
            continue;
          }
        }

        // Determine if this is the main worktree (same as repo root)
        isMain = path.resolve(worktreePath) === path.resolve(repoPath);

        if (worktreePath) {
          worktrees.push({
            id: this.generateWorktreeId(repoId, worktreePath),
            repoId,
            name: branch || path.basename(worktreePath),
            path: worktreePath,
            isMain,
          });
        }
      }

      return worktrees;
    } catch (error) {
      console.error('Failed to list worktrees:', error);
      return [];
    }
  }

  /**
   * Generate a deterministic ID for a worktree based on repo and path
   */
  private generateWorktreeId(repoId: string, worktreePath: string): string {
    // Create a deterministic ID so we can reliably link chats to worktrees
    const normalized = path.resolve(worktreePath);
    const hash = this.simpleHash(`${repoId}:${normalized}`);
    return `wt-${hash}`;
  }

  /**
   * Simple hash function for generating deterministic IDs
   */
  private simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  /**
   * Create a new worktree
   */
  createWorktree(repoPath: string, branch: string, worktreePath: string): boolean {
    try {
      execSync(`git worktree add "${worktreePath}" "${branch}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to create worktree:', error);
      return false;
    }
  }

  /**
   * Create a new worktree with a new branch
   */
  createWorktreeWithNewBranch(
    repoPath: string,
    newBranch: string,
    worktreePath: string,
    baseBranch: string = 'HEAD'
  ): boolean {
    try {
      execSync(`git worktree add -b "${newBranch}" "${worktreePath}" "${baseBranch}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to create worktree with new branch:', error);
      return false;
    }
  }

  /**
   * Remove a worktree
   */
  removeWorktree(repoPath: string, worktreePath: string): boolean {
    try {
      execSync(`git worktree remove "${worktreePath}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to remove worktree:', error);
      return false;
    }
  }

  /**
   * Get the current HEAD commit SHA
   */
  getCurrentCommit(worktreePath: string): string | null {
    try {
      const result = execSync('git rev-parse HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * Get the current branch name
   */
  getCurrentBranch(worktreePath: string): string | null {
    try {
      const result = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * Get list of available branches
   */
  getBranches(repoPath: string): string[] {
    try {
      const result = execSync('git branch -a --format="%(refname:short)"', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return result
        .trim()
        .split('\n')
        .filter((b) => b && !b.includes('->'));
    } catch {
      return [];
    }
  }

  /**
   * Get changed files since a base commit
   */
  getChangedFiles(worktreePath: string, baseCommit: string): FileChange[] {
    try {
      // Get diff stat
      const output = execSync(`git diff --numstat ${baseCommit}..HEAD`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const changes: FileChange[] = [];

      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;

        const [additions, deletions, filePath] = line.split('\t');

        // Handle binary files (shows as -)
        const adds = additions === '-' ? 0 : parseInt(additions, 10);
        const dels = deletions === '-' ? 0 : parseInt(deletions, 10);

        let status: FileChange['status'] = 'modified';
        if (adds > 0 && dels === 0) {
          status = 'added';
        } else if (adds === 0 && dels > 0) {
          status = 'deleted';
        }

        changes.push({
          path: filePath,
          status,
          additions: adds,
          deletions: dels,
        });
      }

      return changes;
    } catch (error) {
      console.error('Failed to get changed files:', error);
      return [];
    }
  }

  /**
   * Get unstaged and staged changes (working tree status)
   */
  getWorkingTreeChanges(worktreePath: string): FileChange[] {
    try {
      const output = execSync('git diff --numstat HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const changes: FileChange[] = [];

      for (const line of output.trim().split('\n')) {
        if (!line.trim()) continue;

        const [additions, deletions, filePath] = line.split('\t');
        const adds = additions === '-' ? 0 : parseInt(additions, 10);
        const dels = deletions === '-' ? 0 : parseInt(deletions, 10);

        let status: FileChange['status'] = 'modified';
        if (adds > 0 && dels === 0) {
          status = 'added';
        } else if (adds === 0 && dels > 0) {
          status = 'deleted';
        }

        changes.push({
          path: filePath,
          status,
          additions: adds,
          deletions: dels,
        });
      }

      return changes;
    } catch {
      return [];
    }
  }

  /**
   * Get the diff for a specific file
   */
  getFileDiff(worktreePath: string, filePath: string, baseCommit?: string): string {
    try {
      const commitRange = baseCommit ? `${baseCommit}..HEAD` : 'HEAD';
      const output = execSync(`git diff ${commitRange} -- "${filePath}"`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output;
    } catch {
      return '';
    }
  }
}
