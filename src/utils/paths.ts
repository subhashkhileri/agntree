import * as fs from 'fs';
import * as path from 'path';
import { BoundedCache } from './boundedCache';

/**
 * Successful realpath lookups. Paths rarely change while the extension runs;
 * the bound keeps a long session's distinct session cwds from growing it.
 */
const realpathCache = new BoundedCache<string, string>(2_000);

/**
 * Resolve a path and follow symlinks when possible.
 * Successes are memoized because opencode filtering calls this per session.
 */
export function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  const cached = realpathCache.get(resolved);
  if (cached) {
    return cached;
  }

  try {
    const real = fs.realpathSync(resolved).normalize('NFC');
    realpathCache.set(resolved, real);
    return real;
  } catch {
    return resolved.normalize('NFC');
  }
}

/** True when `candidate` is `root` or a subdirectory of it. */
export function isWithin(candidate: string, root: string): boolean {
  const normalizedCandidate = canonicalPath(candidate);
  const normalizedRoot = canonicalPath(root);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(normalizedRoot + path.sep)
  );
}

/** True when `candidate` is strictly below `root` (the root itself is not). */
export function isStrictlyWithin(candidate: string, root: string): boolean {
  return isWithin(candidate, root) && canonicalPath(candidate) !== canonicalPath(root);
}

/**
 * The deepest root that contains `target`, so a session in a nested worktree
 * maps to that worktree rather than to the repository around it.
 */
export function deepestContainingRoot<T extends { path: string }>(
  roots: readonly T[],
  target: string
): T | undefined {
  let best: T | undefined;
  for (const root of roots) {
    if (isWithin(target, root.path) && (!best || root.path.length > best.path.length)) {
      best = root;
    }
  }
  return best;
}

/**
 * Claude Code encodes a project path by replacing every character outside
 * `[A-Za-z0-9]` with `-`. It encodes the physical cwd, so resolve symlinks and
 * normalize Unicode first; otherwise a worktree opened through a symlink is
 * stored under a different project directory.
 */
export function encodeClaudeProjectPath(projectPath: string): string {
  return canonicalPath(projectPath).replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Claude truncates a project directory name to 200 characters plus a short
 * hash when the encoded path is longer, and the hash is not reproducible.
 * A worktree root also owns the directories of sessions started in its
 * subdirectories, which encode as `<root>-<subdir>`.
 */
export function claudeProjectDirMatches(
  encodedPath: string,
  dirName: string
): boolean {
  if (encodedPath.length <= 200) {
    return (
      dirName === encodedPath || dirName.startsWith(`${encodedPath}-`)
    );
  }
  return dirName.startsWith(`${encodedPath.slice(0, 200)}-`);
}
