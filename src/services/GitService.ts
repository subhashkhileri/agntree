import { execFile, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Worktree, FileChange, RepositoryWorktrees } from '../types';
import { canonicalPath, isWithin } from '../utils/paths';

/** Outcome of a git command whose failure message the user should see. */
export interface GitOutcome {
  success: boolean;
  error?: string;
}

const execFileAsync = promisify(execFile);

/** Large enough for `git diff` of a big worktree when copying changes. */
const PATCH_MAX_BUFFER = 50 * 1024 * 1024;

/** Preferred rebase targets, in order. */
const REBASE_TARGETS = ['upstream/main', 'upstream/master', 'origin/main', 'origin/master'];

/**
 * Git operations for worktrees, the Changes panel, and rebases. Every call
 * passes an argument array, so branch names, paths, and refs are never
 * interpreted by a shell. Local commands run synchronously; network commands
 * (clone, fetch) are async so they never block the extension host.
 */
export class GitService {
  private run(
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

  /** Trimmed stdout, or null when git fails. */
  private output(args: string[], cwd: string): string | null {
    try {
      return this.run(args, cwd).trim();
    } catch {
      return null;
    }
  }

  /** Whether git exits successfully; for predicates where failure means "no". */
  private succeeds(args: string[], cwd: string): boolean {
    return this.output(args, cwd) !== null;
  }

  /** Run a command for its effect, logging a failure under `label`. */
  private attempt(args: string[], cwd: string, label: string): GitOutcome {
    try {
      this.run(args, cwd);
      return { success: true };
    } catch (error) {
      const message = gitErrorMessage(error);
      console.error(`${label} failed:`, message);
      return { success: false, error: message };
    }
  }

  private lines(args: string[], cwd: string): string[] {
    return (this.output(args, cwd) ?? '').split('\n').filter(Boolean);
  }

  isGitRepository(dirPath: string): boolean {
    return this.succeeds(['rev-parse', '--git-dir'], dirPath);
  }

  /** Run a network command for its effect, logging a failure under `label`. */
  private async attemptAsync(args: string[], cwd: string, label: string): Promise<GitOutcome> {
    try {
      await execFileAsync('git', args, { cwd });
      return { success: true };
    } catch (error) {
      const message = gitErrorMessage(error);
      console.error(`${label} failed:`, message);
      return { success: false, error: message };
    }
  }

  clone(url: string, destination: string): Promise<GitOutcome> {
    return this.attemptAsync(['clone', url, destination], path.dirname(destination), 'Clone');
  }

  getRepoRoot(dirPath: string): string | null {
    return this.output(['rev-parse', '--show-toplevel'], dirPath);
  }

  listWorktrees(repoPath: string, repoId: string): Worktree[] {
    return this.parseWorktrees(repoPath, repoId) ?? [];
  }

  /**
   * The worktrees sessions can run in for a workspace root. A plain folder is
   * its own single worktree, so chats can attach before `git init`; the id is
   * the one `git worktree list` reports for the main worktree afterwards,
   * which keeps every chat bound across the conversion.
   */
  listRepositoryWorktrees(repoPath: string, repoId: string): RepositoryWorktrees {
    const worktrees = this.parseWorktrees(repoPath, repoId);
    if (worktrees !== null) {
      return { isGit: true, worktrees };
    }
    return {
      isGit: false,
      worktrees: [
        {
          id: worktreeId(repoId, repoPath),
          repoId,
          name: path.basename(repoPath),
          path: repoPath,
          isMain: true,
        },
      ],
    };
  }

  /**
   * Parse `git worktree list --porcelain`, or null when the path is not a git
   * working tree root.
   */
  private parseWorktrees(repoPath: string, repoId: string): Worktree[] | null {
    let output: string;
    try {
      output = this.run(['worktree', 'list', '--porcelain'], repoPath);
    } catch (error) {
      // A plain folder is an expected answer. Anything else — git missing, or
      // a root that no longer exists — deserves a diagnostic, though the row
      // still falls back to a plain folder.
      if (!String((error as { stderr?: unknown }).stderr ?? '').includes('not a git repository')) {
        console.error(`Could not list git worktrees in ${repoPath}`, error);
      }
      return null;
    }

    const worktrees: Worktree[] = [];
    for (const entry of output.trim().split('\n\n')) {
      const lines = entry.split('\n');
      // Git emits `bare` only for the repository itself, which has no working
      // tree to run sessions in.
      if (lines.includes('bare')) {
        return [];
      }
      const worktreePath = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
      if (!worktreePath) {
        continue;
      }
      const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length);
      worktrees.push({
        id: worktreeId(repoId, worktreePath),
        repoId,
        name: branch || path.basename(worktreePath),
        branch: branch || undefined,
        path: worktreePath,
        // Git reports physical paths, while a folder added through a symlink
        // keeps the spelling the user picked.
        isMain: canonicalPath(worktreePath) === canonicalPath(repoPath),
      });
    }

    // Git also answers from a subdirectory of a repository with the ancestor's
    // worktrees. That folder is not one of them, so it is a plain folder.
    return worktrees.some((worktree) => worktree.isMain) ? worktrees : null;
  }

  createWorktree(repoPath: string, branch: string, worktreePath: string): boolean {
    return this.attempt(['worktree', 'add', worktreePath, branch], repoPath, 'Create worktree').success;
  }

  createWorktreeWithNewBranch(
    repoPath: string,
    newBranch: string,
    worktreePath: string,
    baseBranch = 'HEAD'
  ): boolean {
    return this.attempt(
      ['worktree', 'add', '-b', newBranch, worktreePath, baseBranch],
      repoPath,
      'Create worktree with new branch'
    ).success;
  }

  removeWorktree(repoPath: string, worktreePath: string, force = false): boolean {
    const args = ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath];
    const outcome = this.attempt(args, repoPath, 'Remove worktree');
    // A worktree whose `.git` became a directory cannot be removed by git.
    if (
      !outcome.success &&
      (outcome.error?.includes('is not a .git file') || outcome.error?.includes('error code 3'))
    ) {
      return this.forceRemoveWorktree(repoPath, worktreePath);
    }
    return outcome.success;
  }

  /**
   * Delete a worktree directory git could not remove. This is the extension's
   * only recursive delete, so it refuses anything git does not list as a
   * worktree of this repository and anything that could contain the
   * repository or the user's home.
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

    this.succeeds(['worktree', 'prune'], repoPath);
    console.warn(`Removing worktree directory: ${resolvedPath}`);
    try {
      fs.rmSync(resolvedPath, { recursive: true, force: true });
    } catch (error) {
      console.error('Failed to force remove worktree:', error);
      return false;
    }
    this.succeeds(['worktree', 'prune'], repoPath);
    return true;
  }

  /**
   * Whether a directory may be removed by force cleanup: it must be a
   * registered worktree of the repository, and must not be the filesystem
   * root, the repository, the user's home, or an ancestor of either.
   */
  private isSafeWorktreePath(repoPath: string, worktreePath: string): boolean {
    // Git reports real paths, while callers may hold a symlinked one.
    const resolved = canonicalPath(worktreePath);
    const resolvedRepo = canonicalPath(repoPath);
    const home = process.env.HOME || process.env.USERPROFILE;

    if (
      resolved === path.parse(resolved).root ||
      (home && isWithin(home, resolved)) ||
      isWithin(resolvedRepo, resolved)
    ) {
      return false;
    }

    return this.lines(['worktree', 'list', '--porcelain'], resolvedRepo)
      .filter((line) => line.startsWith('worktree '))
      .some((line) => canonicalPath(line.slice('worktree '.length)) === resolved);
  }

  deleteBranch(repoPath: string, branchName: string, force = false): boolean {
    return this.attempt(['branch', force ? '-D' : '-d', branchName], repoPath, 'Delete branch').success;
  }

  hasUncommittedChanges(worktreePath: string): boolean {
    return Boolean(this.output(['status', '--porcelain'], worktreePath));
  }

  /**
   * Copy uncommitted work into another worktree: tracked changes as a binary
   * patch against HEAD, untracked files by copying them. Never overwrites a
   * file in the destination.
   */
  copyUncommittedChanges(sourceWorktree: string, destWorktree: string): boolean {
    try {
      const patch = this.run(['diff', 'HEAD', '--binary'], sourceWorktree, {
        maxBuffer: PATCH_MAX_BUFFER,
      });
      if (patch.trim()) {
        this.run(['apply', '--3way', '-'], destWorktree, { input: patch, maxBuffer: PATCH_MAX_BUFFER });
      }
    } catch (error) {
      // Untracked files are still worth copying.
      console.error('Failed to apply patch:', gitErrorMessage(error));
    }

    let untracked: string[];
    try {
      untracked = this.untrackedFiles(sourceWorktree);
    } catch (error) {
      console.error('Failed to copy uncommitted changes:', error);
      return false;
    }
    for (const filePath of untracked) {
      const destPath = path.join(destWorktree, filePath);
      if (!isWithin(destPath, destWorktree)) {
        console.error(`Skipping untracked path outside the destination: ${filePath}`);
        continue;
      }
      try {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        // An untracked nested repository is listed as a directory.
        fs.cpSync(path.join(sourceWorktree, filePath), destPath, { recursive: true, errorOnExist: true, force: false });
      } catch (error) {
        console.error(`Failed to copy untracked file ${filePath}:`, error);
      }
    }
    return true;
  }

  /** Untracked, non-ignored files, verbatim (no quoting of unusual names). */
  private untrackedFiles(worktreePath: string): string[] {
    return this.run(['ls-files', '-z', '--others', '--exclude-standard'], worktreePath)
      .split('\0')
      .filter(Boolean);
  }

  /** Merge with `--no-ff` so the branch's history stays visible. */
  mergeBranch(targetWorktreePath: string, sourceBranch: string): GitOutcome {
    return this.attempt(['merge', '--no-ff', sourceBranch], targetWorktreePath, 'Merge');
  }

  getCurrentCommit(worktreePath: string): string | null {
    return this.output(['rev-parse', 'HEAD'], worktreePath);
  }

  getCurrentBranch(worktreePath: string): string | null {
    return this.output(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  }

  /**
   * Commits ahead of / behind the upstream, or null without one.
   * `@{upstream}...HEAD` counts from the upstream side: "<behind> <ahead>".
   */
  getAheadBehind(worktreePath: string): { ahead: number; behind: number } | null {
    const counts = this.output(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], worktreePath);
    const [behind, ahead] = (counts ?? '').split(/\s+/).map(Number);
    return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
  }

  /** Local and remote-tracking branch names, without symbolic refs. */
  getBranches(repoPath: string): string[] {
    return this.lines(['branch', '-a', '--format=%(refname:short)'], repoPath).filter(
      (b) => !b.includes('->')
    );
  }

  listRemotes(repoPath: string): string[] {
    return this.lines(['remote'], repoPath);
  }

  hasRemote(repoPath: string, remoteName: string): boolean {
    return this.listRemotes(repoPath).includes(remoteName);
  }

  async fetchRemote(repoPath: string, remoteName: string): Promise<boolean> {
    return (await this.attemptAsync(['fetch', remoteName], repoPath, `Fetch ${remoteName}`)).success;
  }

  /** Remote-tracking branches of one remote, as `<remote>/<branch>`. */
  getRemoteBranches(repoPath: string, remoteName: string): string[] {
    return this.lines(['branch', '-r', '--format=%(refname:short)'], repoPath).filter(
      (b) => b.startsWith(`${remoteName}/`) && !b.includes('->')
    );
  }

  /** Changes staged in the index, relative to HEAD. */
  getStagedChanges(worktreePath: string): FileChange[] {
    try {
      return this.listDiff(worktreePath, ['--cached']);
    } catch {
      return [];
    }
  }

  /** Unstaged changes to tracked files, plus untracked files as additions. */
  getUnstagedChanges(worktreePath: string): FileChange[] {
    try {
      return [
        ...this.listDiff(worktreePath, []),
        ...this.untrackedFiles(worktreePath).map(
          (filePath): FileChange => ({ path: filePath, status: 'added', additions: 0, deletions: 0 })
        ),
      ];
    } catch {
      return [];
    }
  }

  /**
   * One `git diff` listing: statuses from `--name-status`, line counts from
   * `--numstat`. Two calls cover every file, so the panel's cost does not grow
   * with the number of changes. `-z` keeps paths verbatim, and `--no-renames`
   * lists a rename as the deletion and addition that stage, unstage, and
   * discard act on.
   */
  private listDiff(worktreePath: string, scope: string[]): FileChange[] {
    const args = ['diff', ...scope, '--no-renames', '-z'];
    const statuses = new Map<string, FileChange['status']>();
    const nameStatus = this.run([...args, '--name-status'], worktreePath).split('\0');
    for (let i = 0; i + 1 < nameStatus.length; i += 2) {
      const letter = nameStatus[i];
      statuses.set(nameStatus[i + 1], letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified');
    }

    const changes: FileChange[] = [];
    for (const record of this.run([...args, '--numstat'], worktreePath).split('\0')) {
      const [additions, deletions, filePath] = record.split('\t');
      if (filePath) {
        // Binary files report `-` for both counts.
        changes.push({
          path: filePath,
          status: statuses.get(filePath) ?? 'modified',
          additions: additions === '-' ? 0 : parseInt(additions, 10),
          deletions: deletions === '-' ? 0 : parseInt(deletions, 10),
        });
      }
    }
    return changes;
  }

  stageFile(worktreePath: string, filePath: string): boolean {
    return this.attempt(['add', '--', filePath], worktreePath, 'Stage').success;
  }

  unstageFile(worktreePath: string, filePath: string): boolean {
    return this.attempt(['reset', 'HEAD', '--', filePath], worktreePath, 'Unstage').success;
  }

  stageAll(worktreePath: string): boolean {
    return this.attempt(['add', '-A'], worktreePath, 'Stage all').success;
  }

  unstageAll(worktreePath: string): boolean {
    return this.attempt(['reset', 'HEAD'], worktreePath, 'Unstage all').success;
  }

  /** Whether a path is tracked (staged or committed). */
  isTracked(worktreePath: string, filePath: string): boolean {
    return this.succeeds(['ls-files', '--error-unmatch', '--', filePath], worktreePath);
  }

  /**
   * Restore a tracked file's working copy from the index, keeping staged
   * changes. Untracked files are the caller's to move to the Trash.
   */
  discardFile(worktreePath: string, filePath: string): boolean {
    return this.attempt(['checkout', '--', filePath], worktreePath, 'Discard').success;
  }

  /**
   * What Discard All will touch: the count of tracked changes and the exact
   * untracked paths `git clean -fd` deletes (directories collapsed, as git
   * clean treats them).
   */
  getDiscardSummary(worktreePath: string): { tracked: number; untracked: string[] } {
    const summary = { tracked: 0, untracked: [] as string[] };
    let output: string;
    try {
      output = this.run(['status', '--porcelain', '-z', '-unormal'], worktreePath);
    } catch {
      return summary;
    }
    const records = output.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) {
        continue;
      }
      if (record.startsWith('?? ')) {
        summary.untracked.push(record.slice(3));
        continue;
      }
      summary.tracked++;
      // A rename or copy is followed by its original path.
      if (/^[RC]|^.[RC]/.test(record)) {
        i++;
      }
    }
    return summary;
  }

  /** Discard unstaged and untracked changes; staged changes stay. */
  discardAll(worktreePath: string): boolean {
    return (
      this.attempt(['checkout', '--', '.'], worktreePath, 'Discard all').success &&
      this.attempt(['clean', '-fd'], worktreePath, 'Clean').success
    );
  }

  /** The rebase state directory while a rebase is stopped, else null. */
  private rebaseDir(worktreePath: string): string | null {
    const gitDir = this.output(['rev-parse', '--git-dir'], worktreePath);
    if (!gitDir) {
      return null;
    }
    const resolved = path.resolve(worktreePath, gitDir);
    return (
      ['rebase-merge', 'rebase-apply']
        .map((name) => path.join(resolved, name))
        .find((dir) => fs.existsSync(dir)) ?? null
    );
  }

  isRebaseInProgress(worktreePath: string): boolean {
    return this.rebaseDir(worktreePath) !== null;
  }

  getRebaseProgress(worktreePath: string): { current: number; total: number } | null {
    const dir = this.rebaseDir(worktreePath);
    if (!dir) {
      return null;
    }
    try {
      const read = (name: string) => parseInt(fs.readFileSync(path.join(dir, name), 'utf-8'), 10);
      return { current: read('msgnum'), total: read('end') };
    } catch {
      return null;
    }
  }

  /** Files a rebase onto `onto` would conflict on, from a trial merge. */
  checkRebaseConflicts(worktreePath: string, onto: string): { hasConflicts: boolean; conflictingFiles: string[] } {
    try {
      this.run(['merge-tree', '--write-tree', onto, 'HEAD'], worktreePath);
      return { hasConflicts: false, conflictingFiles: [] };
    } catch (error) {
      const { stdout, status } = error as { stdout?: string; status?: number };
      if (!status || !stdout) {
        return { hasConflicts: false, conflictingFiles: [] };
      }
      const conflictingFiles = stdout
        .split('\n')
        .map((line) => line.match(/^CONFLICT \([^)]+\): .* in (.+)$/)?.[1])
        .filter((file): file is string => Boolean(file));
      return { hasConflicts: true, conflictingFiles };
    }
  }

  isUpToDate(worktreePath: string, ref: string): boolean {
    return this.succeeds(['merge-base', '--is-ancestor', ref, 'HEAD'], worktreePath);
  }

  rebase(worktreePath: string, onto: string): GitOutcome {
    return this.attempt(['rebase', '--autostash', onto], worktreePath, 'Rebase');
  }

  rebaseContinue(worktreePath: string): GitOutcome {
    return this.attempt(['-c', 'core.editor=true', 'rebase', '--continue'], worktreePath, 'Rebase continue');
  }

  rebaseSkip(worktreePath: string): GitOutcome {
    return this.attempt(['rebase', '--skip'], worktreePath, 'Rebase skip');
  }

  rebaseAbort(worktreePath: string): boolean {
    return this.attempt(['rebase', '--abort'], worktreePath, 'Rebase abort').success;
  }
}

/** The usual rebase target among remote branches: upstream before origin, main before master. */
export function recommendedRebaseTarget(remoteBranches: readonly string[]): string | undefined {
  return REBASE_TARGETS.find((branch) => remoteBranches.includes(branch));
}

/**
 * A deterministic worktree id. Chats are stored against it, so the hash must
 * never change; the path is canonical so a folder keeps its id when `git init`
 * starts reporting its physical path.
 */
function worktreeId(repoId: string, worktreePath: string): string {
  const key = `${repoId}:${canonicalPath(worktreePath)}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return `wt-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/** git's own explanation when it has one, otherwise the spawn error. */
function gitErrorMessage(error: unknown): string {
  const execError = error as { stderr?: string; message?: string };
  return execError.stderr || execError.message || String(error);
}
