/**
 * Discovery parses only the project directories that belong to the worktree
 * or repository being queried. These tests pin Claude's directory encoding,
 * its long-path truncation, and its config-dir overrides on a synthetic
 * profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { claudeProjectDirMatches, encodeClaudeProjectPath } from '../../src/utils/paths';
import { claudeProfile, entry, setEnv } from './claudeFixture';

const BASE = Math.floor(Date.now() / 1000) - 1000;
const ids = (sessions: { sessionId: string }[]) => sessions.map((session) => session.sessionId);

/** One prompted session whose transcript is dated `BASE + offset`. */
function writeSession(
  profile: ReturnType<typeof claudeProfile>,
  sessionId: string,
  cwd: string,
  offset: number,
  options: { projectDir?: string; summary?: string } = {}
) {
  profile.write(sessionId, cwd, [entry.summary(options.summary ?? sessionId), entry.user('prompt', new Date((BASE + offset) * 1000).toISOString())], {
    projectDir: options.projectDir,
    mtimeSeconds: BASE + offset,
  });
}

test('worktree and repository discovery scan only their own project directories', async (t) => {
  const profile = claudeProfile(t, { viaHome: true });
  const repo = profile.dir('repo');
  const worktree = profile.dir('repo-feature');
  const sub = profile.dir('repo-feature/sub');
  // `<worktree>-other` passes the directory-prefix filter; the parsed cwd must reject it.
  const sibling = profile.dir('repo-feature-other');
  writeSession(profile, 'wt-session', worktree, 40);
  writeSession(profile, 'sub-session', sub, 30);
  writeSession(profile, 'repo-session', repo, 20);
  writeSession(profile, 'sibling-session', sibling, 10);
  // Its cwd claims the worktree, but its directory belongs elsewhere: a
  // scoped scan never opens it.
  writeSession(profile, 'unrelated-session', worktree, 0, { projectDir: profile.projectDir(profile.dir('other-repo')) });
  const service = new ClaudeSessionService();

  assert.deepEqual(ids(await service.findSessionsForWorktree(worktree)), ['wt-session', 'sub-session'], 'newest first');
  assert.deepEqual(ids(await service.findSessionsForRepository(repo, [worktree])), ['wt-session', 'sub-session', 'repo-session']);
  assert.equal((await service.getSessionById('sub-session'))?.cwd, sub, 'lookup by ID searches every directory');
});

test('paths encode every non-alphanumeric character, resolve symlinks, and match long names by prefix', async (t) => {
  const profile = claudeProfile(t, { viaHome: true });
  const service = new ClaudeSessionService();

  const special = profile.dir('repo with space_underscore.dot-é');
  assert.equal(encodeClaudeProjectPath(special), fs.realpathSync(special).normalize('NFC').replace(/[^A-Za-z0-9]/g, '-'));
  writeSession(profile, 'special-session', special, 0);
  assert.deepEqual(ids(await service.findSessionsForWorktree(special)), ['special-session']);

  const worktree = profile.dir('worktree');
  writeSession(profile, 'wt-session', worktree, 1);
  const linkedWorktree = path.join(profile.root, 'linked-worktree');
  fs.symlinkSync(worktree, linkedWorktree, 'dir');
  assert.equal(encodeClaudeProjectPath(linkedWorktree), encodeClaudeProjectPath(worktree), 'the physical path is encoded');
  assert.deepEqual(ids(await service.findSessionsForWorktree(linkedWorktree)), ['wt-session']);

  const linkTarget = profile.dir('linked-project-target');
  writeSession(profile, 'symlinked-dir-session', worktree, 2, { projectDir: linkTarget });
  fs.symlinkSync(linkTarget, `${profile.projectDir(worktree)}-linked`, 'dir');
  assert.ok(ids(await service.findSessionsForWorktree(worktree)).includes('symlinked-dir-session'), 'a symlinked project directory is scanned');

  // Claude truncates names past 200 characters and appends a hash it does not
  // document; the parsed cwd separates two paths that share the prefix.
  const long = profile.dir(`long-${'a'.repeat(220)}`);
  const longDir = path.join(profile.projects, `${encodeClaudeProjectPath(long).slice(0, 200)}-abcdef`);
  writeSession(profile, 'long-session', long, 3, { projectDir: longDir });
  writeSession(profile, 'long-sibling-session', profile.dir(`long-${'a'.repeat(220)}-other`), 4, { projectDir: longDir });
  assert.deepEqual(ids(await service.findSessionsForWorktree(long)), ['long-session']);

  assert.ok(claudeProjectDirMatches('short-name', 'short-name-subdir'));
  assert.ok(!claudeProjectDirMatches('short-name', 'other-name'));
});

test('a session found in two project directories is listed once, newest copy first', async (t) => {
  const profile = claudeProfile(t, { viaHome: true });
  const worktree = profile.dir('worktree');
  writeSession(profile, 'dup-session', worktree, 1, { summary: 'Old copy' });
  writeSession(profile, 'dup-session', worktree, 2, { summary: 'New copy', projectDir: profile.projectDir(profile.dir('worktree/sub')) });

  const sessions = await new ClaudeSessionService().findSessionsForWorktree(worktree);
  assert.deepEqual(sessions.map((s) => `${s.sessionId}:${s.summary}`), ['dup-session:New copy']);
});

test('CLAUDE_CONFIG_DIR replaces the default root; CLAUDE_CODE_PROJECT_DIR_NAME applies only with it', async (t) => {
  const profile = claudeProfile(t, { viaHome: true });
  const worktree = profile.dir('worktree');
  writeSession(profile, 'default-root-session', worktree, 0);
  writeSession(profile, 'ignored-override-session', worktree, 1, { projectDir: path.join(profile.projects, 'custom-project') });
  const find = async () => ids(await new ClaudeSessionService().findSessionsForWorktree(worktree)).sort();

  setEnv(t, { CLAUDE_CODE_PROJECT_DIR_NAME: 'custom-project' });
  assert.deepEqual(await find(), ['default-root-session'], 'the override needs an explicit config dir');

  const customProjects = path.join(profile.dir('custom-config'), 'projects');
  setEnv(t, { CLAUDE_CONFIG_DIR: path.dirname(customProjects) });
  writeSession(profile, 'custom-config-session', worktree, 2, { projectDir: profile.projectDir(worktree, customProjects) });
  writeSession(profile, 'override-session', worktree, 3, { projectDir: path.join(customProjects, 'custom-project') });
  assert.deepEqual(await find(), ['custom-config-session', 'override-session']);
});
