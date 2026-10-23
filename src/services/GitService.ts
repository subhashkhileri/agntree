import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Worktree, FileChange } from '../types';
import { canonicalPath, isWithin } from '../utils/paths';

/**
 * Service for git operations including worktree management and change tracking
 */
export class GitService {
  /**
   * Run git with an argument array. This avoids shell quoting entirely, so
   * branch names, paths, and commit refs cannot be interpreted as commands.
   */
  private runGit(
    args: string[],
    cwd: string,
    options: { input?: string; maxBuffer?: number } = {}
  ): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      input: options.input,
      maxBuffer: options.maxBuffer,
    });
  }

  /**
   * Check if a directory is a git repository
   */
  isGitRepository(dirPath: string): boolean {
    try {
      this.runGit(['rev-parse', '--git-dir'], dirPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clone a repository into `destination`. Throws with git's message on
   * failure so the command can show it.
   */
  clone(url: string, destination: string): void {
    this.runGit(['clone', url, destination], path.dirname(destination));
  }

  /**
   * Get the root path of the git repository
   */
  getRepoRoot(dirPath: string): string | null {
    try {
      const result = this.runGit(['rev-parse', '--show-toplevel'], dirPath);
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
      const output = this.runGit(['worktree', 'list', '--porcelain'], repoPath);

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
      this.runGit(['worktree', 'add', worktreePath, branch], repoPath);
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
      this.runGit(
        ['worktree', 'add', '-b', newBranch, worktreePath, baseBranch],
        repoPath
      );
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
      const args = ['worktree', 'remove'];
      if (force) {
        args.push('--force');
      }
      args.push(worktreePath);
      this.runGit(args, repoPath);
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
   * Force remove a worktree with invalid .git structure.
   *
   * This is the only place the extension deletes a directory with Node, so it
   * refuses anything that git does not list as a worktree of this repository,
   * and anything that could contain the repository or the user's home.
   */
  private forceRemoveWorktree(repoPath: string, worktreePath: string): boolean {
    const resolvedPath = path.resolve(worktreePath);

    if (!this.isSafeWorktreePath(repoPath, worktreePath)) {
      console.error(
        `Refusing to force-remove "${resolvedPath}": it is not a registered worktree of "${repoPath}".`
      );
      return false;
    }

    if (!fs.existsSync(resolvedPath)) {
      return true;
    }

    try {
      // Prune stale worktree references first
      try {
        this.runGit(['worktree', 'prune'], repoPath);
      } catch {
        // Non-fatal, continue
      }

      console.warn(`Removing worktree directory: ${resolvedPath}`);
      fs.rmSync(resolvedPath, { recursive: true, force: true });

      // Prune again to clean up any remaining references
      try {
        this.runGit(['worktree', 'prune'], repoPath);
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
   * Whether a directory may be removed by force cleanup: it must be a
   * registered worktree of the repository, and must not be the filesystem
   * root, the repository, the user's home, or an ancestor of either.
   */
  private isSafeWorktreePath(repoPath: string, worktreePath: string): boolean {
    // Compare canonical paths: git reports the real path, while callers may
    // hold a symlinked one (e.g. /tmp on macOS).
    const resolved = canonicalPath(worktreePath);
    const resolvedRepo = canonicalPath(repoPath);
    const home = process.env.HOME || process.env.USERPROFILE;

    if (resolved === path.parse(resolved).root || resolved === resolvedRepo) {
      return false;
    }

    // Never delete the home directory or one of its ancestors.
    if (home && isWithin(home, resolved)) {
      return false;
    }

    // Never delete a directory that contains the repository.
    if (isWithin(resolvedRepo, resolved)) {
      return false;
    }

    try {
      const output = this.runGit(['worktree', 'list', '--porcelain'], resolvedRepo);
      const registered = output
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => canonicalPath(line.slice('worktree '.length)));
      return registered.includes(resolved);
    } catch {
      return false;
    }
  }

  /**
   * Delete a branch
   */
  deleteBranch(repoPath: string, branchName: string, force: boolean = false): boolean {
    try {
      this.runGit(['branch', force ? '-D' : '-d', branchName], repoPath);
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
      const output = this.runGit(['status', '--porcelain'], worktreePath);
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
      const statusOutput = this.runGit(['status', '--porcelain'], sourceWorktree);

      if (!statusOutput.trim()) {
        return true; // No changes to copy
      }

      // Create a patch for tracked changes (both staged and unstaged)
      try {
        const patchOutput = this.runGit(['diff', 'HEAD'], sourceWorktree, {
          maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large diffs
        });

        if (patchOutput.trim()) {
          // Apply the patch to destination
          this.runGit(['apply', '--3way', '-'], destWorktree, {
            input: patchOutput,
            maxBuffer: 50 * 1024 * 1024,
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

          // Never write outside the destination worktree.
          if (!isWithin(destPath, destWorktree)) {
            console.error(`Skipping untracked path outside the destination: ${filePath}`);
            continue;
          }

          try {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.cpSync(sourcePath, destPath, {
              recursive: true,
              errorOnExist: true,
              force: false,
            });
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
      this.runGit(['merge', '--no-ff', sourceBranch], targetWorktreePath);
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
      const result = this.runGit(['rev-parse', 'HEAD'], worktreePath);
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
      const result = this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * Commit count ahead of / behind the branch's upstream.
   *
   * `@{upstream}...HEAD` compares from the upstream side, so its
   * `--left-right --count` output is "<behind> <ahead>". Returns null when the
   * branch has no upstream or the repository is detached.
   */
  getAheadBehind(worktreePath: string): { ahead: number; behind: number } | null {
    try {
      const result = this.runGit(
        ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        worktreePath
      ).trim();
      const [behindRaw, aheadRaw] = result.split(/\s+/);
      const ahead = Number(aheadRaw);
      const behind = Number(behindRaw);
      if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
        return null;
      }
      return { ahead, behind };
    } catch {
      return null;
    }
  }

  /**
   * Get list of available branches
   */
  getBranches(repoPath: string): string[] {
    try {
      const result = this.runGit(
        ['branch', '-a', '--format=%(refname:short)'],
        repoPath
      );
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
      const output = this.runGit(['remote'], repoPath);
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
      this.runGit(['fetch', remoteName], repoPath);
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
      this.runGit(['fetch', 'origin', branchName], repoPath);
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
      execFileSync(
        'gh',
        ['pr', 'checkout', String(prNumber), '--branch', localBranchName],
        {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      // Switch back to the previous branch — the local branch remains for worktree use
      this.runGit(['checkout', '-'], repoPath);
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
      const output = this.runGit(
        ['branch', '-r', '--format=%(refname:short)'],
        repoPath
      );
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
      const output = this.runGit(
        ['diff', '--numstat', `${baseCommit}..HEAD`],
        worktreePath
      );

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
      const output = this.runGit(['diff', '--numstat', 'HEAD'], worktreePath);

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
      return this.runGit(['diff', commitRange, '--', filePath], worktreePath);
    } catch {
      return '';
    }
  }

  /**
   * Get staged changes (files added to index)
   */
  getStagedChanges(worktreePath: string): FileChange[] {
    try {
      const output = this.runGit(['diff', '--cached', '--numstat'], worktreePath);

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
      const trackedOutput = this.runGit(['diff', '--numstat'], worktreePath);

      const changes = this.parseNumstatOutput(trackedOutput, worktreePath, false);

      // Get untracked files
      const untrackedOutput = this.runGit(
        ['ls-files', '--others', '--exclude-standard'],
        worktreePath
      );

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
        if (!fs.existsSync(path.join(worktreePath, filePath))) {
          throw new Error('missing');
        }
        // File exists - check if it existed in the comparison base
        if (staged) {
          // For staged changes, check against HEAD to detect new files
          status = this.existsInHead(worktreePath, filePath) ? 'modified' : 'added';
        } else {
          // For unstaged changes, check if tracked in index
          status = this.isTracked(worktreePath, filePath) ? 'modified' : 'added';
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
      this.runGit(['add', '--', filePath], worktreePath);
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
      this.runGit(['reset', 'HEAD', '--', filePath], worktreePath);
      return true;
    } catch (error) {
      console.error('Failed to unstage file:', error);
      return false;
    }
  }

  /**
   * Whether a path is tracked by git (staged or committed).
   */
  isTracked(worktreePath: string, filePath: string): boolean {
    try {
      this.runGit(['ls-files', '--error-unmatch', '--', filePath], worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether a path exists in the HEAD commit. Staged-but-new files do not,
   * so the diff editor opens index-only content for them.
   */
  existsInHead(worktreePath: string, filePath: string): boolean {
    try {
      this.runGit(['cat-file', '-e', `HEAD:${filePath}`], worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Discard unstaged changes to a file (restore working tree from index).
   * Untracked files are deleted here; callers that want recoverable deletion
   * should use `isTracked()` and move the file to the trash themselves.
   */
  discardFile(worktreePath: string, filePath: string): boolean {
    try {
      if (this.isTracked(worktreePath, filePath)) {
        // Restore working tree from index (preserves staged changes)
        this.runGit(['checkout', '--', filePath], worktreePath);
        return true;
      }

      // Untracked: delete exactly this file, never a directory tree outside
      // the worktree.
      const fullPath = path.resolve(worktreePath, filePath);
      if (!isWithin(fullPath, worktreePath)) {
        console.error(`Refusing to discard a path outside the worktree: ${fullPath}`);
        return false;
      }
      if (!fs.existsSync(fullPath)) {
        return true;
      }
      if (!fs.lstatSync(fullPath).isFile()) {
        console.error(`Refusing to discard a non-file path: ${fullPath}`);
        return false;
      }
      fs.unlinkSync(fullPath);
      return true;
    } catch (error) {
      console.error('Failed to discard file:', error);
      return false;
    }
  }

  /**
   * Counts for the discard-all confirmation. Untracked paths are listed so the
   * dialog can say exactly what `git clean` is about to delete.
   */
  getDiscardSummary(worktreePath: string): {
    tracked: number;
    untracked: string[];
  } {
    try {
      const output = this.runGit(['status', '--porcelain', '-unormal'], worktreePath);

      let tracked = 0;
      const untracked: string[] = [];
      for (const line of output.split('\n')) {
        if (!line.trim()) {
          continue;
        }
        if (line.startsWith('?? ')) {
          untracked.push(line.slice(3).trim());
        } else {
          tracked++;
        }
      }
      return { tracked, untracked };
    } catch {
      return { tracked: 0, untracked: [] };
    }
  }

  /**
   * Discard all unstaged and untracked changes
   */
  discardAll(worktreePath: string): boolean {
    try {
      // Restore working tree from index (preserves staged changes)
      this.runGit(['checkout', '--', '.'], worktreePath);
      // Remove all untracked files and directories
      this.runGit(['clean', '-fd'], worktreePath);
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
      this.runGit(['add', '-A'], worktreePath);
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
      this.runGit(['reset', 'HEAD'], worktreePath);
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
      const gitDir = this.runGit(['rev-parse', '--git-dir'], worktreePath).trim();

      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      return fs.existsSync(path.join(resolvedGitDir, 'rebase-merge')) ||
        fs.existsSync(path.join(resolvedGitDir, 'rebase-apply'));
    } catch {
      return false;
    }
  }

  getRebaseProgress(worktreePath: string): { current: number; total: number } | null {
    try {
      const gitDir = this.runGit(['rev-parse', '--git-dir'], worktreePath).trim();

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
      this.runGit(['merge-tree', '--write-tree', onto, 'HEAD'], worktreePath);
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
      this.runGit(['merge-base', '--is-ancestor', ref, 'HEAD'], worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  rebase(worktreePath: string, onto: string): { success: boolean; error?: string } {
    try {
      this.runGit(['rebase', '--autostash', onto], worktreePath);
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
      this.runGit(['-c', 'core.editor=true', 'rebase', '--continue'], worktreePath);
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
      this.runGit(['rebase', '--abort'], worktreePath);
      return true;
    } catch (error) {
      console.error('Rebase abort failed:', error);
      return false;
    }
  }

  rebaseSkip(worktreePath: string): { success: boolean; error?: string } {
    try {
      this.runGit(['rebase', '--skip'], worktreePath);
      return { success: true };
    } catch (error: unknown) {
      const execError = error as { stderr?: string; message?: string };
      const errorMessage = execError.stderr || execError.message || String(error);
      console.error('Rebase skip failed:', errorMessage);
      return { success: false, error: errorMessage };
    }
  }
}
