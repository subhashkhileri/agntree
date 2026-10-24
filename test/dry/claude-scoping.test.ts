import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import {
  claudeProjectDirMatches,
  encodeClaudeProjectPath,
} from '../../src/utils/paths';

/**
 * Discovery must parse only the project directories that belong to the
 * worktree/repository being queried, not every session on disk. This test
 * builds a synthetic ~/.claude/projects tree and pins that behavior, including
 * the encoding, long-path prefix matching, and config-dir overrides.
 */

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-claude-scoping-'));
const HOME = path.join(ROOT, 'home');
const DEFAULT_PROJECTS = path.join(HOME, '.claude', 'projects');

const REPO = path.join(ROOT, 'repo');
const WORKTREE = path.join(ROOT, 'repo-feature');
const SUBDIR = path.join(WORKTREE, 'sub');
// Encodes to `<worktree>-other`, which the prefix filter also admits.
const SIBLING = path.join(ROOT, 'repo-feature-other');
const UNRELATED = path.join(ROOT, 'other-repo');
const SPECIAL = path.join(ROOT, 'repo with space_underscore.dot-é');
const LONG = path.join(ROOT, `long-${'a'.repeat(220)}`);

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
  return encodeClaudeProjectPath(value);
}

/** Claude's documented rule, applied to the physical path independently. */
function expectedEncoding(value: string): string {
  return fs.realpathSync(value).normalize('NFC').replace(/[^A-Za-z0-9]/g, '-');
}

function projectDirFor(cwd: string, projectsDir = DEFAULT_PROJECTS): string {
  return path.join(projectsDir, encode(cwd));
}

function writeSession(
  sessionId: string,
  projectDir: string,
  sessionCwd: string,
  summary: string,
  mtimeSeconds: number
): void {
  fs.mkdirSync(projectDir, { recursive: true });

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

  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

function ids(sessions: { sessionId: string }[]): string[] {
  return sessions.map((session) => session.sessionId);
}

function restoreEnv(
  name: string,
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function main(): Promise<void> {
  // Directories must exist so isWithin() can realpath them (macOS /var ->
  // /private/var would otherwise compare unlike paths).
  for (const dir of [REPO, WORKTREE, SUBDIR, SIBLING, UNRELATED, SPECIAL, LONG]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  writeSession(
    'wt-session',
    projectDirFor(WORKTREE),
    WORKTREE,
    'Worktree session',
    BASE_TIME + 40
  );
  writeSession(
    'sub-session',
    projectDirFor(SUBDIR),
    SUBDIR,
    'Subdirectory session',
    BASE_TIME + 30
  );
  writeSession(
    'repo-session',
    projectDirFor(REPO),
    REPO,
    'Repo root session',
    BASE_TIME + 20
  );
  writeSession(
    'sibling-session',
    projectDirFor(SIBLING),
    SIBLING,
    'Sibling dir session',
    BASE_TIME + 10
  );
  // Trap: its parsed cwd points at the worktree, but its project directory
  // does not. The old global scan included it; scoped discovery must not.
  writeSession(
    'unrelated-session',
    projectDirFor(UNRELATED),
    WORKTREE,
    'Unrelated dir session',
    BASE_TIME
  );

  // Spaces, underscores, dots, and unicode all encode to dashes.
  writeSession(
    'special-session',
    projectDirFor(SPECIAL),
    SPECIAL,
    'Special characters session',
    BASE_TIME + 50
  );

  // A path longer than Claude's 200-character project-dir limit.
  const encodedLong = encode(LONG);
  check(
    encodedLong.length > 200,
    `the long path encodes to ${encodedLong.length} characters`
  );
  const longProjectDir = path.join(
    DEFAULT_PROJECTS,
    `${encodedLong.slice(0, 200)}-abcdef`
  );
  writeSession(
    'long-session',
    longProjectDir,
    LONG,
    'Long path session',
    BASE_TIME + 60
  );
  // The prefix match over-includes; the parsed cwd must disambiguate.
  writeSession(
    'long-sibling-session',
    longProjectDir,
    `${LONG}-other`,
    'Long path sibling session',
    BASE_TIME + 55
  );

  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalProjectDirName = process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
  process.env.HOME = HOME;
  process.env.USERPROFILE = HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;

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

    console.log('\n== symlinked project directories ==');
    const linkTarget = path.join(ROOT, 'linked-project-target');
    fs.mkdirSync(linkTarget, { recursive: true });
    writeSession(
      'symlinked-dir-session',
      linkTarget,
      WORKTREE,
      'Symlinked project dir',
      BASE_TIME + 42
    );
    try {
      fs.symlinkSync(
        linkTarget,
        path.join(DEFAULT_PROJECTS, `${encode(WORKTREE)}-linked`),
        'dir'
      );
      const symlinked = await service.findSessionsForWorktree(WORKTREE);
      check(
        ids(symlinked).includes('symlinked-dir-session'),
        'a symlinked project directory is scanned'
      );
    } catch {
      // Creating symlinks may be unavailable (e.g. unprivileged Windows).
      console.log('SKIP  symlinks are not supported on this platform');
    }

    console.log('\n== symlinked worktree ==');
    const linkedWorktree = path.join(ROOT, 'linked-worktree');
    try {
      fs.symlinkSync(WORKTREE, linkedWorktree, 'dir');
      check(
        encodeClaudeProjectPath(linkedWorktree) === encode(WORKTREE),
        'encoding a symlinked worktree uses its physical path'
      );
      const linkedSessions = await service.findSessionsForWorktree(linkedWorktree);
      check(
        ids(linkedSessions).includes('wt-session'),
        'a symlinked worktree finds its physical sessions'
      );
    } catch {
      console.log('SKIP  symlinks are not supported on this platform');
    }

    console.log('\n== duplicate transcripts ==');
    writeSession(
      'dup-session',
      projectDirFor(WORKTREE),
      WORKTREE,
      'Old copy',
      BASE_TIME + 1
    );
    writeSession(
      'dup-session',
      projectDirFor(SUBDIR),
      WORKTREE,
      'New copy',
      BASE_TIME + 2
    );
    const dupSessions = await service.findSessionsForWorktree(WORKTREE);
    check(
      ids(dupSessions).filter((id) => id === 'dup-session').length === 1,
      'a session ID present in two project dirs is listed once'
    );
    check(
      dupSessions.find((session) => session.sessionId === 'dup-session')
        ?.summary === 'New copy',
      'the newest duplicate transcript is kept'
    );

    console.log('\n== path encoding ==');
    check(
      encodeClaudeProjectPath(SPECIAL) === expectedEncoding(SPECIAL),
      'every non-alphanumeric character encodes to a dash'
    );
    const specialSessions = await service.findSessionsForWorktree(SPECIAL);
    check(
      ids(specialSessions).includes('special-session'),
      'spaces, underscores, dots, and unicode discover sessions'
    );
    check(
      claudeProjectDirMatches('short-name', 'short-name') &&
        claudeProjectDirMatches('short-name', 'short-name-subdir') &&
        !claudeProjectDirMatches('short-name', 'other-name'),
      'a short project name matches itself and its subdirectory dirs'
    );
    const longEncoded = 'b'.repeat(201);
    check(
      claudeProjectDirMatches(
        longEncoded,
        `${longEncoded.slice(0, 200)}-abcdef`
      ),
      'a long project name matches its 200-character prefix and hash'
    );

    const longSessions = await service.findSessionsForWorktree(LONG);
    const longIds = ids(longSessions);
    check(
      longIds.includes('long-session'),
      'a path longer than 200 characters discovers its session'
    );
    check(
      !longIds.includes('long-sibling-session'),
      'the parsed cwd disambiguates two long paths sharing a prefix'
    );

    console.log('\n== per-session lookup still works ==');
    const byId = await service.getSessionById('sub-session');
    check(byId?.cwd === SUBDIR, 'getSessionById finds a session in any project dir');

    console.log('\n== config directory ==');
    const customConfig = path.join(ROOT, 'custom-config');
    const customProjects = path.join(customConfig, 'projects');
    process.env.CLAUDE_CONFIG_DIR = customConfig;
    delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
    writeSession(
      'custom-config-session',
      projectDirFor(WORKTREE, customProjects),
      WORKTREE,
      'Custom config session',
      BASE_TIME + 70
    );
    const customService = new ClaudeSessionService();
    const customSessions = await customService.findSessionsForWorktree(WORKTREE);
    check(
      ids(customSessions).join(',') === 'custom-config-session',
      'CLAUDE_CONFIG_DIR is the only projects root used'
    );

    console.log('\n== project name override ==');
    process.env.CLAUDE_CODE_PROJECT_DIR_NAME = 'custom-project';
    writeSession(
      'override-session',
      path.join(customProjects, 'custom-project'),
      WORKTREE,
      'Override project dir session',
      BASE_TIME + 80
    );
    const overrideService = new ClaudeSessionService();
    const overrideIds = ids(await overrideService.findSessionsForWorktree(WORKTREE));
    check(
      overrideIds.includes('override-session'),
      'CLAUDE_CODE_PROJECT_DIR_NAME is included when a config dir is set'
    );

    delete process.env.CLAUDE_CONFIG_DIR;
    fs.mkdirSync(path.join(DEFAULT_PROJECTS, 'custom-project'), {
      recursive: true,
    });
    writeSession(
      'ignored-override-session',
      path.join(DEFAULT_PROJECTS, 'custom-project'),
      WORKTREE,
      'Ignored override session',
      BASE_TIME + 90
    );
    const ignoredService = new ClaudeSessionService();
    const ignoredIds = ids(await ignoredService.findSessionsForWorktree(WORKTREE));
    check(
      !ignoredIds.includes('ignored-override-session'),
      'the project name override is ignored without a config dir'
    );
  } finally {
    restoreEnv('HOME', originalHome);
    restoreEnv('USERPROFILE', originalUserProfile);
    restoreEnv('CLAUDE_CONFIG_DIR', originalConfigDir);
    restoreEnv('CLAUDE_CODE_PROJECT_DIR_NAME', originalProjectDirName);
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
