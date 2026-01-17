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
  removeWorktree(repoPath: string, worktreePath: string, force: boolean = false): boolean {
    try {
      const forceFlag = force ? ' --force' : '';
      execSync(`git worktree remove${forceFlag} "${worktreePath}"`, {
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
   * Delete a branch
   */
  deleteBranch(repoPath: string, branchName: string, force: boolean = false): boolean {
    try {
      const forceFlag = force ? ' -D' : ' -d';
      execSync(`git branch${forceFlag} "${branchName}"`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to delete branch:', error);
      return false;
    }
  }

  /**
   * Check if a worktree has uncommitted changes
   */
  hasUncommittedChanges(worktreePath: string): boolean {
    try {
      const output = execSync('git status --porcelain', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Copy uncommitted changes from one worktree to another.
   * Creates a patch from the source and applies it to the destination.
   * Also copies untracked files.
   */
  copyUncommittedChanges(sourceWorktree: string, destWorktree: string): boolean {
    try {
      // Get list of all changes (tracked and untracked)
      const statusOutput = execSync('git status --porcelain', {
        cwd: sourceWorktree,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      if (!statusOutput.trim()) {
        return true; // No changes to copy
      }

      // Create a patch for tracked changes (both staged and unstaged)
      try {
        const patchOutput = execSync('git diff HEAD', {
          cwd: sourceWorktree,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large diffs
        });

        if (patchOutput.trim()) {
          // Apply the patch to destination
          execSync('git apply --3way -', {
            cwd: destWorktree,
            encoding: 'utf-8',
            input: patchOutput,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        }
      } catch (patchError) {
        console.error('Failed to apply patch:', patchError);
        // Continue to try copying untracked files
      }

      // Handle untracked files - copy them directly
      const lines = statusOutput.trim().split('\n');
      for (const line of lines) {
        if (line.startsWith('??')) {
          // Untracked file
          const filePath = line.substring(3).trim();
          const sourcePath = path.join(sourceWorktree, filePath);
          const destPath = path.join(destWorktree, filePath);

          try {
            // Ensure destination directory exists
            const destDir = path.dirname(destPath);
            execSync(`mkdir -p "${destDir}"`, { encoding: 'utf-8' });

            // Copy the file
            execSync(`cp -r "${sourcePath}" "${destPath}"`, { encoding: 'utf-8' });
          } catch (copyError) {
            console.error(`Failed to copy untracked file ${filePath}:`, copyError);
          }
        }
      }

      return true;
    } catch (error) {
      console.error('Failed to copy uncommitted changes:', error);
      return false;
    }
  }

  /**
   * Merge a source branch into the target worktree
   * @param targetWorktreePath - Path to the worktree where merge will happen
   * @param sourceBranch - Branch name to merge from
   * @returns Object with success status and optional error message
   */
  mergeBranch(
    targetWorktreePath: string,
    sourceBranch: string
  ): { success: boolean; error?: string } {
    try {
      // Regular merge with --no-ff to preserve branch history
      execSync(`git merge --no-ff "${sourceBranch}"`, {
        cwd: targetWorktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Failed to merge branch:', errorMessage);
      return { success: false, error: errorMessage };
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

  /**
   * Get staged changes (files added to index)
   */
  getStagedChanges(worktreePath: string): FileChange[] {
    try {
      const output = execSync('git diff --cached --numstat', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return this.parseNumstatOutput(output, worktreePath);
    } catch {
      return [];
    }
  }

  /**
   * Get unstaged changes (modified but not added to index)
   */
  getUnstagedChanges(worktreePath: string): FileChange[] {
    try {
      // Get modified tracked files
      const trackedOutput = execSync('git diff --numstat', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const changes = this.parseNumstatOutput(trackedOutput, worktreePath);

      // Get untracked files
      const untrackedOutput = execSync('git ls-files --others --exclude-standard', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      for (const line of untrackedOutput.trim().split('\n')) {
        if (!line.trim()) continue;
        changes.push({
          path: line.trim(),
          status: 'added',
          additions: 0,
          deletions: 0,
        });
      }

      return changes;
    } catch {
      return [];
    }
  }

  /**
   * Parse git diff --numstat output into FileChange array
   */
  private parseNumstatOutput(output: string, worktreePath: string): FileChange[] {
    const changes: FileChange[] = [];

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;

      const [additions, deletions, filePath] = line.split('\t');
      const adds = additions === '-' ? 0 : parseInt(additions, 10);
      const dels = deletions === '-' ? 0 : parseInt(deletions, 10);

      // Check if file exists to determine add vs modify vs delete
      let status: FileChange['status'] = 'modified';
      try {
        // Check if file exists in working tree
        execSync(`test -e "${filePath}"`, {
          cwd: worktreePath,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // File exists - check if it's new or modified
        try {
          execSync(`git ls-files --error-unmatch "${filePath}"`, {
            cwd: worktreePath,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          // File is tracked - it's modified
          status = 'modified';
        } catch {
          // File is not tracked - it's added
          status = 'added';
        }
      } catch {
        // File doesn't exist - it's deleted
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
  }

  /**
   * Stage a file
   */
  stageFile(worktreePath: string, filePath: string): boolean {
    try {
      execSync(`git add "${filePath}"`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to stage file:', error);
      return false;
    }
  }

  /**
   * Unstage a file
   */
  unstageFile(worktreePath: string, filePath: string): boolean {
    try {
      execSync(`git reset HEAD "${filePath}"`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to unstage file:', error);
      return false;
    }
  }

  /**
   * Discard changes to a file (restore to HEAD)
   */
  discardFile(worktreePath: string, filePath: string): boolean {
    try {
      // Check if file is untracked
      try {
        execSync(`git ls-files --error-unmatch "${filePath}"`, {
          cwd: worktreePath,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // File is tracked - use checkout to restore
        execSync(`git checkout HEAD -- "${filePath}"`, {
          cwd: worktreePath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // File is untracked - just delete it
        const fs = require('fs');
        const fullPath = path.join(worktreePath, filePath);
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
      return true;
    } catch (error) {
      console.error('Failed to discard file:', error);
      return false;
    }
  }

  /**
   * Stage all changes
   */
  stageAll(worktreePath: string): boolean {
    try {
      execSync('git add -A', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to stage all:', error);
      return false;
    }
  }

  /**
   * Unstage all changes
   */
  unstageAll(worktreePath: string): boolean {
    try {
      execSync('git reset HEAD', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to unstage all:', error);
      return false;
    }
  }
}
