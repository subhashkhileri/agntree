import * as os from 'os';
import * as path from 'path';
import { canonicalPath } from '../utils/paths';

/**
 * Claude Code's data directory, honoring an explicit override.
 *
 * Claude resolves a relative `CLAUDE_CONFIG_DIR` against each session's own
 * working directory, which Agntree cannot know globally. Such a value is
 * therefore resolved against the extension-host cwd (the previous implicit
 * behavior) and warned about, so the mismatch is visible instead of silent.
 */
export function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured && !path.isAbsolute(configured)) {
    console.warn(
      '[Agntree] CLAUDE_CONFIG_DIR is relative; Claude resolves it against each session\'s working directory, so Agntree may not discover those sessions. Set an absolute path.'
    );
  }
  return canonicalPath(configured || path.join(os.homedir(), '.claude'));
}

/**
 * Claude's project-directory override. Claude honors it only together with an
 * explicit config dir; with the default config dir the variable is ignored.
 */
export function claudeProjectDirOverride(): string | null {
  if (!process.env.CLAUDE_CONFIG_DIR) {
    return null;
  }
  return process.env.CLAUDE_CODE_PROJECT_DIR_NAME || null;
}
