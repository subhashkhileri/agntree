import { execFile } from 'child_process';
import { promisify } from 'util';
import { PRInfo } from '../types';

const execFileAsync = promisify(execFile);

/**
 * Service for interacting with GitHub via the gh CLI
 */
export class GitHubService {
  /** Cache of PR info by repo:branch key */
  private prCache: Map<string, PRInfo | null> = new Map();

  /** Whether gh CLI is available (cached) */
  private ghAvailable: boolean | null = null;

  /** Promise for ongoing gh availability check */
  private ghCheckPromise: Promise<boolean> | null = null;

  /**
   * Check if gh CLI is available (async)
   */
  async isGhAvailable(): Promise<boolean> {
    if (this.ghAvailable !== null) return this.ghAvailable;

    // Prevent multiple concurrent checks
    if (this.ghCheckPromise) return this.ghCheckPromise;

    this.ghCheckPromise = (async () => {
      try {
        await execFileAsync('gh', ['--version'], { timeout: 5000 });
        this.ghAvailable = true;
      } catch {
        this.ghAvailable = false;
      }
      this.ghCheckPromise = null;
      return this.ghAvailable;
    })();

    return this.ghCheckPromise;
  }

  /**
   * Get cached PR info for a branch (synchronous, returns null if not cached)
   */
  getCachedPRInfo(repoPath: string, branchName: string): PRInfo | null | undefined {
    const cacheKey = `${repoPath}:${branchName}`;
    if (this.prCache.has(cacheKey)) {
      return this.prCache.get(cacheKey) ?? null;
    }
    return undefined; // Not in cache yet
  }

  /**
   * Check if PR info is cached for a branch
   */
  isCached(repoPath: string, branchName: string): boolean {
    const cacheKey = `${repoPath}:${branchName}`;
    return this.prCache.has(cacheKey);
  }

  /**
   * Fetch PR info for a branch (async, updates cache)
   */
  async fetchPRInfo(repoPath: string, branchName: string): Promise<PRInfo | null> {
    if (!(await this.isGhAvailable())) return null;

    const cacheKey = `${repoPath}:${branchName}`;

    try {
      // Use execFileAsync with array args to prevent command injection
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'list', '--head', branchName, '--json', 'number,title,state,isDraft,url', '--limit', '1'],
        { cwd: repoPath, timeout: 10000 }
      );
      const prs = JSON.parse(stdout);
      if (prs.length === 0) {
        this.prCache.set(cacheKey, null);
        return null;
      }
      const pr = prs[0];

      // Validate state from GitHub API
      const validStates = ['open', 'merged', 'closed'] as const;
      const state = pr.state?.toLowerCase() || 'closed';
      const validatedState: PRInfo['state'] = validStates.includes(state)
        ? (state as PRInfo['state'])
        : 'closed';

      const prInfo: PRInfo = {
        number: pr.number,
        title: pr.title || '',
        state: validatedState,
        isDraft: pr.isDraft ?? false,
        url: pr.url || '',
      };
      this.prCache.set(cacheKey, prInfo);
      return prInfo;
    } catch {
      this.prCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Get PR info for a branch (async) - fetches if not cached
   */
  async getPRInfo(repoPath: string, branchName: string): Promise<PRInfo | null> {
    const cached = this.getCachedPRInfo(repoPath, branchName);
    if (cached !== undefined) {
      return cached;
    }
    return this.fetchPRInfo(repoPath, branchName);
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.prCache.clear();
  }

  /**
   * List open PRs for a repository
   */
  async listPRs(repoPath: string): Promise<PRInfo[]> {
    if (!(await this.isGhAvailable())) return [];

    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'list', '--json', 'number,title,state,isDraft,url,headRefName', '--limit', '30'],
        { cwd: repoPath, timeout: 15000 }
      );
      const prs = JSON.parse(stdout);
      return prs.map((pr: Record<string, unknown>) => ({
        number: pr.number as number,
        title: (pr.title as string) || '',
        state: 'open' as const,
        isDraft: (pr.isDraft as boolean) ?? false,
        url: (pr.url as string) || '',
        headRefName: (pr.headRefName as string) || '',
      }));
    } catch {
      return [];
    }
  }

  /**
   * Fetch details for a specific PR by number or URL
   */
  async fetchPRDetails(repoPath: string, prRef: string): Promise<PRInfo | null> {
    if (!(await this.isGhAvailable())) return null;

    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', prRef, '--json', 'number,title,state,isDraft,url,headRefName'],
        { cwd: repoPath, timeout: 10000 }
      );
      const pr = JSON.parse(stdout);

      const validStates = ['open', 'merged', 'closed'] as const;
      const state = pr.state?.toLowerCase() || 'closed';
      const validatedState: PRInfo['state'] = validStates.includes(state)
        ? (state as PRInfo['state'])
        : 'closed';

      return {
        number: pr.number,
        title: pr.title || '',
        state: validatedState,
        isDraft: pr.isDraft ?? false,
        url: pr.url || '',
        headRefName: pr.headRefName || '',
      };
    } catch {
      return null;
    }
  }

  /**
   * Format PR info for display in tree item description
   * Returns: "#123", "#123 ○" (draft), "#123 ✓" (merged), "#123 ✗" (closed)
   */
  formatPRDescription(prInfo: PRInfo | null): string {
    if (!prInfo) return '';

    const symbol = prInfo.isDraft
      ? ' ○'
      : prInfo.state === 'merged'
        ? ' ✓'
        : prInfo.state === 'closed'
          ? ' ✗'
          : '';

    return `#${prInfo.number}${symbol}`;
  }
}
