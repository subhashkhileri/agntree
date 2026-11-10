/**
 * A synthetic Claude Code profile under a temp directory. Tests never read the
 * developer's `~/.claude`: the profile sets `CLAUDE_CONFIG_DIR` (or `HOME`) for
 * the test and restores the environment afterwards.
 */
import * as fs from 'fs';
import * as path from 'path';
import { encodeClaudeProjectPath } from '../../src/utils/paths';
import { tempDir } from './support';

type Hooks = { after(fn: () => void): void };

/** Set environment variables for one test; `undefined` unsets one. */
export function setEnv(t: Hooks, values: Record<string, string | undefined>): void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(saved));
}

/** Transcript entries. `write()` adds the session's cwd and ID to each. */
export const entry = {
  user: (text: string, timestamp = new Date().toISOString()) => ({
    type: 'user',
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  }),
  assistant: (text: string, stopReason: string | null = 'end_turn', timestamp = new Date().toISOString()) => ({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] },
  }),
  summary: (summary: string) => ({ type: 'summary', summary }),
  aiTitle: (aiTitle: string) => ({ type: 'ai-title', aiTitle }),
};

export function claudeProfile(t: Hooks, options: { viaHome?: boolean } = {}) {
  const root = tempDir(t, 'agntree-claude-');
  const home = path.join(root, 'home');
  const configDir = options.viaHome ? path.join(home, '.claude') : path.join(root, 'config');
  setEnv(t, {
    CLAUDE_CONFIG_DIR: options.viaHome ? undefined : configDir,
    CLAUDE_CODE_PROJECT_DIR_NAME: undefined,
    HOME: home,
    USERPROFILE: home,
  });
  const projects = path.join(configDir, 'projects');

  return {
    root,
    projects,
    /** Create a directory under the profile root (it must exist to encode). */
    dir(name: string): string {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** The project directory Claude uses for sessions started in `cwd`. */
    projectDir(cwd: string, projectsRoot = projects): string {
      return path.join(projectsRoot, encodeClaudeProjectPath(cwd));
    },
    /** Write a transcript; returns its path. */
    write(
      sessionId: string,
      cwd: string,
      entries: object[],
      options: { projectDir?: string; mtimeSeconds?: number } = {}
    ): string {
      const dir = options.projectDir ?? this.projectDir(cwd);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${sessionId}.jsonl`);
      fs.writeFileSync(file, entries.map((value) => `${JSON.stringify({ cwd, sessionId, ...value })}\n`).join(''));
      if (options.mtimeSeconds !== undefined) {
        fs.utimesSync(file, options.mtimeSeconds, options.mtimeSeconds);
      }
      return file;
    },
  };
}
