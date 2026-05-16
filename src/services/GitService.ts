import { execSync } from 'child_process';
import * as fs from 'fs';
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
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const errorMessage = execError.stderr || execError.message || String(error);

      // Handle case where .git is a directory instead of a file (corrupted worktree)
      if (errorMessage.includes('is not a .git file') || errorMessage.includes('error code 3')) {
        console.log('Worktree has invalid .git structure, attempting manual cleanup...');
        return this.forceRemoveWorktree(repoPath, worktreePath);
      }

      console.error('Failed to remove worktree:', error);
      return false;
    }
  }

  /**
   * Force remove a worktree with invalid .git structure
   */
  private forceRemoveWorktree(repoPath: string, worktreePath: string): boolean {
    const resolvedPath = path.resolve(worktreePath);

    try {
      // Prune stale worktree references first
      try {
        execSync('git worktree prune', {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Non-fatal, continue
      }

      // Remove the directory if it exists
      if (fs.existsSync(resolvedPath)) {
        fs.rmSync(resolvedPath, { recursive: true, force: true });
      }

      // Prune again to clean up any remaining references
      try {
        execSync('git worktree prune', {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // Non-fatal
      }

      return true;
    } catch (error) {
      console.error('Failed to force remove worktree:', error);
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
   * List all remotes
   */
  listRemotes(repoPath: string): string[] {
    try {
      const output = execSync('git remote', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim().split('\n').filter(r => r);
    } catch {
      return [];
    }
  }

  /**
   * Check if a specific remote exists
   */
  hasRemote(repoPath: string, remoteName: string): boolean {
    return this.listRemotes(repoPath).includes(remoteName);
  }

  /**
   * Fetch from a specific remote
   */
  fetchRemote(repoPath: string, remoteName: string): boolean {
    try {
      execSync(`git fetch ${remoteName}`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error(`Failed to fetch from ${remoteName}:`, error);
      return false;
    }
  }

  /**
   * Fetch a specific branch from origin
   */
  fetchBranch(repoPath: string, branchName: string): boolean {
    try {
      execSync(`git fetch origin ${branchName}`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error(`Failed to fetch branch ${branchName}:`, error);
      return false;
    }
  }

  /**
   * Fetch a pull request using gh CLI and create a local branch.
   * gh handles remote resolution automatically (origin, upstream, forks, etc.).
   */
  fetchPR(repoPath: string, prNumber: number, localBranchName: string): boolean {
    try {
      // gh pr checkout handles finding the correct remote and fetching
      execSync(`gh pr checkout ${prNumber} --branch ${localBranchName}`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Switch back to the previous branch — the local branch remains for worktree use
      execSync('git checkout -', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error(`Failed to fetch PR #${prNumber}:`, error);
      return false;
    }
  }

  /**
   * Get branches for a specific remote
   */
  getRemoteBranches(repoPath: string, remoteName: string): string[] {
    try {
      const output = execSync('git branch -r --format="%(refname:short)"', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output
        .trim()
        .split('\n')
        .filter(b => b.startsWith(`${remoteName}/`) && !b.includes('->'));
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

      return this.parseNumstatOutput(output, worktreePath, true);
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

      const changes = this.parseNumstatOutput(trackedOutput, worktreePath, false);

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
  private parseNumstatOutput(output: string, worktreePath: string, staged: boolean): FileChange[] {
    const changes: FileChange[] = [];

    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue;

      const [additions, deletions, filePath] = line.split('\t');
      const adds = additions === '-' ? 0 : parseInt(additions, 10);
      const dels = deletions === '-' ? 0 : parseInt(deletions, 10);

      let status: FileChange['status'] = 'modified';
      try {
        // Check if file exists in working tree
        execSync(`test -e "${filePath}"`, {
          cwd: worktreePath,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // File exists - check if it existed in the comparison base
        if (staged) {
          // For staged changes, check against HEAD to detect new files
          try {
            execSync(`git cat-file -e HEAD:"${filePath}"`, {
              cwd: worktreePath,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            status = 'modified';
          } catch {
            status = 'added';
          }
        } else {
          // For unstaged changes, check if tracked in index
          try {
            execSync(`git ls-files --error-unmatch "${filePath}"`, {
              cwd: worktreePath,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            status = 'modified';
          } catch {
            status = 'added';
          }
        }
      } catch {
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
   * Discard unstaged changes to a file (restore working tree from index)
   */
  discardFile(worktreePath: string, filePath: string): boolean {
    try {
      // Check if file is untracked
      try {
        execSync(`git ls-files --error-unmatch "${filePath}"`, {
          cwd: worktreePath,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        // File is tracked - restore working tree from index (preserves staged changes)
        execSync(`git checkout -- "${filePath}"`, {
          cwd: worktreePath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        // File is untracked - just delete it
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
   * Discard all unstaged and untracked changes
   */
  discardAll(worktreePath: string): boolean {
    try {
      // Restore working tree from index (preserves staged changes)
      execSync('git checkout -- .', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Remove all untracked files and directories
      execSync('git clean -fd', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Failed to discard all changes:', error);
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

  getRebaseRemote(worktreePath: string): { remote: string; branch: string } | null {
    try {
      const remotes = this.listRemotes(worktreePath);
      let remote: string | undefined;
      if (remotes.includes('upstream')) {
        remote = 'upstream';
      } else if (remotes.includes('origin')) {
        remote = 'origin';
      }
      if (!remote) {
        return null;
      }

      // Fetch to ensure remote tracking branches are available
      this.fetchRemote(worktreePath, remote);

      const remoteBranches = this.getRemoteBranches(worktreePath, remote);
      const branchNames = remoteBranches.map(b => b.replace(`${remote}/`, ''));
      let branch: string | undefined;
      if (branchNames.includes('main')) {
        branch = `${remote}/main`;
      } else if (branchNames.includes('master')) {
        branch = `${remote}/master`;
      }
      if (!branch) {
        return null;
      }

      return { remote, branch };
    } catch {
      return null;
    }
  }

  isRebaseInProgress(worktreePath: string): boolean {
    try {
      const gitDir = execSync('git rev-parse --git-dir', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      return fs.existsSync(path.join(resolvedGitDir, 'rebase-merge')) ||
        fs.existsSync(path.join(resolvedGitDir, 'rebase-apply'));
    } catch {
      return false;
    }
  }

  getRebaseProgress(worktreePath: string): { current: number; total: number } | null {
    try {
      const gitDir = execSync('git rev-parse --git-dir', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      let rebaseDir = path.join(resolvedGitDir, 'rebase-merge');
      if (!fs.existsSync(rebaseDir)) {
        rebaseDir = path.join(resolvedGitDir, 'rebase-apply');
      }
      if (!fs.existsSync(rebaseDir)) {
        return null;
      }

      const current = parseInt(fs.readFileSync(path.join(rebaseDir, 'msgnum'), 'utf-8').trim(), 10);
      const total = parseInt(fs.readFileSync(path.join(rebaseDir, 'end'), 'utf-8').trim(), 10);
      return { current, total };
    } catch {
      return null;
    }
  }

  checkRebaseConflicts(worktreePath: string, onto: string): { hasConflicts: boolean; conflictingFiles: string[] } {
    try {
      execSync(`git merge-tree --write-tree ${onto} HEAD`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { hasConflicts: false, conflictingFiles: [] };
    } catch (error: unknown) {
      const execError = error as { stdout?: string; status?: number };
      if (execError.status && execError.stdout) {
        const files: string[] = [];
        const lines = execError.stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/^CONFLICT \([^)]+\): .* in (.+)$/);
          if (match) {
            files.push(match[1]);
          }
        }
        return { hasConflicts: true, conflictingFiles: files };
      }
      return { hasConflicts: false, conflictingFiles: [] };
    }
  }

  isUpToDate(worktreePath: string, ref: string): boolean {
    try {
      execSync(`git merge-base --is-ancestor ${ref} HEAD`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  rebase(worktreePath: string, onto: string): { success: boolean; error?: string } {
    try {
      execSync(`git rebase --autostash ${onto}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Rebase failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  rebaseContinue(worktreePath: string): { success: boolean; error?: string } {
    try {
      execSync('git -c core.editor=true rebase --continue', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Rebase continue failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }

  rebaseAbort(worktreePath: string): boolean {
    try {
      execSync('git rebase --abort', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (error) {
      console.error('Rebase abort failed:', error);
      return false;
    }
  }

  rebaseSkip(worktreePath: string): { success: boolean; error?: string } {
    try {
      execSync('git rebase --skip', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { success: true };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Rebase skip failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }
}
