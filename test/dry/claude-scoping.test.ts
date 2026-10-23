import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';

/**
 * Discovery must parse only the project directories that belong to the
 * worktree/repository being queried, not every session on disk. This test
 * builds a synthetic ~/.claude/projects tree and pins that behavior.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-claude-scoping-'));
const HOME = path.join(ROOT, 'home');
const PROJECTS = path.join(HOME, '.claude', 'projects');

const REPO = path.join(ROOT, 'repo');
const WORKTREE = path.join(ROOT, 'repo-feature');
const SUBDIR = path.join(WORKTREE, 'sub');
// Encodes to `<worktree>-other`, which the prefix filter also admits.
const SIBLING = path.join(ROOT, 'repo-feature-other');
const UNRELATED = path.join(ROOT, 'other-repo');

const BASE_TIME = Math.floor(Date.now() / 1000) - 1000;

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function encode(value: string): string {
  return path.resolve(value).replace(/[/\\.]/g, '-');
}

function projectDirFor(cwd: string): string {
  return path.join(PROJECTS, encode(cwd));
}

function writeSession(
  sessionId: string,
  projectCwd: string,
  sessionCwd: string,
  summary: string,
  mtimeSeconds: number
): void {
  const dir = projectDirFor(projectCwd);
  fs.mkdirSync(dir, { recursive: true });

  const timestamp = new Date(mtimeSeconds * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: 'summary', summary }),
    JSON.stringify({
      type: 'user',
      message: `${summary} prompt`,
      cwd: sessionCwd,
      timestamp,
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      cwd: sessionCwd,
      timestamp,
    }),
  ];

  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

function ids(sessions: { sessionId: string }[]): string[] {
  return sessions.map((session) => session.sessionId);
}

async function main(): Promise<void> {
  // Directories must exist so isWithin() can realpath them (macOS /var ->
  // /private/var would otherwise compare unlike paths).
  for (const dir of [REPO, WORKTREE, SUBDIR, SIBLING, UNRELATED]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  writeSession('wt-session', WORKTREE, WORKTREE, 'Worktree session', BASE_TIME + 30);
  writeSession('sub-session', SUBDIR, SUBDIR, 'Subdirectory session', BASE_TIME + 20);
  writeSession('repo-session', REPO, REPO, 'Repo root session', BASE_TIME + 10);
  writeSession('sibling-session', SIBLING, SIBLING, 'Sibling dir session', BASE_TIME + 5);
  // Trap: its parsed cwd points at the worktree, but its project directory
  // does not. The old global scan included it; scoped discovery must not.
  writeSession('unrelated-session', UNRELATED, WORKTREE, 'Unrelated dir session', BASE_TIME);

  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;

  try {
    const service = new ClaudeSessionService();

    console.log('\n== worktree discovery ==');
    const worktreeSessions = await service.findSessionsForWorktree(WORKTREE);
    const worktreeIds = ids(worktreeSessions);
    check(
      worktreeIds.join(',') === 'wt-session,sub-session',
      `worktree returns its own and subdirectory sessions, newest first: ${worktreeIds.join(',')}`
    );
    check(
      !worktreeIds.includes('sibling-session'),
      'prefix-colliding sibling directory is filtered by parsed cwd'
    );
    check(
      !worktreeIds.includes('unrelated-session'),
      'session outside the worktree project dirs is not scanned'
    );
    check(
      !worktreeIds.includes('repo-session'),
      'repository root session is not part of worktree discovery'
    );

    console.log('\n== repository discovery ==');
    const repoSessions = await service.findSessionsForRepository(REPO, [WORKTREE]);
    const repoIds = ids(repoSessions);
    check(
      repoIds.join(',') === 'wt-session,sub-session,repo-session',
      `repository returns root + worktree + subdirectory sessions: ${repoIds.join(',')}`
    );
    check(
      !repoIds.includes('unrelated-session') && !repoIds.includes('sibling-session'),
      'repository discovery excludes unrelated directories'
    );

    console.log('\n== per-session lookup still works ==');
    const byId = await service.getSessionById('sub-session');
    check(byId?.cwd === SUBDIR, 'getSessionById finds a session in any project dir');
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE SCOPING CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
