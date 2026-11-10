import { execFile } from 'child_process';
import { promisify } from 'util';
import { PRInfo } from '../types';

const execFileAsync = promisify(execFile);
const PR_FIELDS = 'number,title,state,isDraft,url,headRefName';

/**
 * Pull-request lookups through the `gh` CLI, which owns authentication and
 * remote resolution (origin, upstream, forks).
 */
export class GitHubService {
  /** PR per `repo:branch`; null caches "no PR". Cleared on every tree refresh. */
  private readonly prCache = new Map<string, PRInfo | null>();
  private readonly inFlight = new Map<string, Promise<PRInfo | null>>();
  private ghAvailable?: Promise<boolean>;

  isGhAvailable(): Promise<boolean> {
    this.ghAvailable ??= execFileAsync('gh', ['--version'], { timeout: 5000 }).then(
      () => true,
      () => false
    );
    return this.ghAvailable;
  }

  private async gh(args: string[], cwd: string, timeout = 10_000): Promise<string> {
    return (await execFileAsync('gh', args, { cwd, timeout })).stdout;
  }

  /** Cached PR for a branch: undefined when not looked up yet. */
  getCachedPRInfo(repoPath: string, branchName: string): PRInfo | null | undefined {
    return this.prCache.get(`${repoPath}:${branchName}`);
  }

  /** Look up a branch's PR; concurrent renders share one `gh` call. */
  fetchPRInfo(repoPath: string, branchName: string): Promise<PRInfo | null> {
    const key = `${repoPath}:${branchName}`;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.lookUpPR(repoPath, branchName).then((info) => {
        this.prCache.set(key, info);
        this.inFlight.delete(key);
        return info;
      });
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async lookUpPR(repoPath: string, branchName: string): Promise<PRInfo | null> {
    if (!(await this.isGhAvailable())) {
      return null;
    }
    try {
      const prs = JSON.parse(
        await this.gh(['pr', 'list', '--head', branchName, '--json', PR_FIELDS, '--limit', '1'], repoPath)
      ) as Record<string, unknown>[];
      return prs.length > 0 ? toPRInfo(prs[0]) : null;
    } catch {
      // Not a GitHub repository, not logged in, or offline: no badge.
      return null;
    }
  }

  clearCache(): void {
    this.prCache.clear();
  }

  /** The 30 most recent open PRs. */
  async listPRs(repoPath: string): Promise<PRInfo[]> {
    if (!(await this.isGhAvailable())) {
      return [];
    }
    try {
      const prs = JSON.parse(
        await this.gh(['pr', 'list', '--json', PR_FIELDS, '--limit', '30'], repoPath, 15_000)
      ) as Record<string, unknown>[];
      return prs.map(toPRInfo);
    } catch {
      return [];
    }
  }

  /** One PR by number or URL. */
  async fetchPRDetails(repoPath: string, prRef: string): Promise<PRInfo | null> {
    if (!(await this.isGhAvailable())) {
      return null;
    }
    try {
      return toPRInfo(JSON.parse(await this.gh(['pr', 'view', prRef, '--json', PR_FIELDS], repoPath)));
    } catch {
      return null;
    }
  }

  /**
   * Create a local branch for a PR. `gh pr checkout` switches the main
   * worktree to it, so switch straight back; the branch stays for a worktree.
   */
  async fetchPRBranch(repoPath: string, prNumber: number, localBranch: string): Promise<boolean> {
    try {
      await this.gh(['pr', 'checkout', String(prNumber), '--branch', localBranch], repoPath, 120_000);
      await execFileAsync('git', ['checkout', '-'], { cwd: repoPath });
      return true;
    } catch (error) {
      console.error(`Failed to fetch PR #${prNumber}:`, error);
      return false;
    }
  }
}

/** Normalize one `gh pr` JSON row. Unknown states read as closed. */
function toPRInfo(pr: Record<string, unknown>): PRInfo {
  const state = String(pr.state ?? '').toLowerCase();
  return {
    number: pr.number as number,
    title: (pr.title as string) || '',
    state: state === 'open' || state === 'merged' ? state : 'closed',
    isDraft: (pr.isDraft as boolean) ?? false,
    url: (pr.url as string) || '',
    headRefName: (pr.headRefName as string) || undefined,
  };
}
