import * as fs from 'fs';
import * as path from 'path';

/** Successful realpath lookups; paths are stable for the process lifetime. */
const realpathCache = new Map<string, string>();

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
    const real = fs.realpathSync(resolved);
    realpathCache.set(resolved, real);
    return real;
  } catch {
    return resolved;
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

/** Claude Code encodes project paths by replacing `/`, `\`, and `.` with `-`. */
export function encodeClaudeProjectPath(projectPath: string): string {
  return path.resolve(projectPath).replace(/[/\\.]/g, '-');
}
