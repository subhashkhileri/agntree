import { HarnessSession } from '../harnesses/types';
import { Worktree } from '../types';
import { canonicalPath, deepestContainingRoot } from '../utils/paths';
import { GitService } from './GitService';
import { StorageService } from './StorageService';

/** A workspace root and the worktrees git lists for it. */
export interface Scope {
  repoRoot: string;
  worktrees: Worktree[];
}

/** Listing worktrees is a synchronous git call per root; pollers ask often. */
const TTL_MS = 15_000;

/**
 * Every worktree Agntree knows across all workspace roots, and which of them
 * owns a session: the deepest one containing the session's directory. Roots
 * can nest (a `Documents` root holding a repository that is a root of its
 * own), and a harness lists a parent directory's sessions with those of its
 * subdirectories, so a per-root view would hand the inner root's sessions to
 * the outer one.
 */
export class WorktreeCatalog {
  private cache: { fetchedAt: number; scopes: Scope[] } | undefined;

  constructor(
    private readonly storageService: StorageService,
    private readonly gitService: GitService
  ) {}

  scopes(force = false): Scope[] {
    if (!force && this.cache && Date.now() - this.cache.fetchedAt < TTL_MS) {
      return this.cache.scopes;
    }
    const scopes: Scope[] = [];
    for (const repo of this.storageService.getRepositories()) {
      const { worktrees } = this.gitService.listRepositoryWorktrees(repo.rootPath, repo.id);
      if (worktrees.length > 0) {
        scopes.push({ repoRoot: repo.rootPath, worktrees });
      }
    }
    this.cache = { fetchedAt: Date.now(), scopes };
    return scopes;
  }

  worktrees(): Worktree[] {
    return this.scopes().flatMap((scope) => scope.worktrees);
  }

  /** The worktree a session started in `cwd` belongs to, if any. */
  owner(cwd: string): Worktree | undefined {
    return deepestContainingRoot(this.worktrees(), cwd);
  }

  /**
   * Whether a session started in `cwd` belongs to `worktreePath` itself rather
   * than to a root nested inside it. A worktree the catalog does not know
   * keeps every session.
   */
  owns(worktreePath: string, cwd: string): boolean {
    const target = canonicalPath(worktreePath);
    const worktrees = this.worktrees();
    if (!worktrees.some((worktree) => canonicalPath(worktree.path) === target)) {
      return true;
    }
    const owner = deepestContainingRoot(worktrees, cwd);
    return !owner || canonicalPath(owner.path) === target;
  }

  ownedSessions<T extends Pick<HarnessSession, 'cwd'>>(worktreePath: string, sessions: T[]): T[] {
    return sessions.filter((session) => this.owns(worktreePath, session.cwd));
  }
}
