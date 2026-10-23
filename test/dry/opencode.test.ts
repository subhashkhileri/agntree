import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpencodeSessionService } from '../../src/services/OpencodeSessionService';
import { OpencodeHarness } from '../../src/harnesses/OpencodeHarness';

const START_DIR = process.env.AGNTREE_TEST_OPENCODE_WORKTREE || process.cwd();
let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

async function main(): Promise<void> {
  const service = new OpencodeSessionService();
  const harness = new OpencodeHarness();

  console.log(`\n== discovery (project: ${START_DIR}) ==`);
  const sessions = await service.listSessions(START_DIR, { force: true });
  if (sessions.length === 0) {
    console.log(
      'SKIP  no opencode sessions found for this project; set AGNTREE_TEST_OPENCODE_WORKTREE to a project with sessions'
    );
    process.exit(0);
  }

  check(sessions.length > 0, `listSessions returned ${sessions.length} sessions`);

  // Pick a session with at least one user message so the fork test is valid.
  let target = sessions[0];
  let preview = await service.getPreview(
    target.id,
    3,
    target.location.directory
  );
  for (const candidate of sessions.slice(1, 6)) {
    if (preview.messageCount > 0) {
      break;
    }
    target = candidate;
    preview = await service.getPreview(
      candidate.id,
      3,
      candidate.location.directory
    );
  }

  if (preview.messageCount === 0) {
    console.log('SKIP  no non-empty opencode session found to exercise forking');
    process.exit(0);
  }

  const WORKTREE = target.location.directory;
  check(Boolean(target.id), `session ID: ${target.id}`);
  check(
    service.getCachedSession(target.id)?.location.directory === WORKTREE,
    'session index is populated with the directory'
  );

  console.log('\n== preview ==');
  check(preview.messages.length > 0, `preview has ${preview.messages.length} user messages`);
  check(preview.messageCount > 0, `preview messageCount is ${preview.messageCount}`);
  if (preview.messages[0]) {
    console.log(`      sample: ${preview.messages[0].text.slice(0, 70)}`);
  }

  console.log('\n== adapter ==');
  check(await harness.isInstalled(), 'isInstalled() is true');
  check(
    harness.buildLaunchCommand({ worktreePath: WORKTREE }) === 'opencode',
    'new-session launch command is "opencode"'
  );
  check(
    harness.buildLaunchCommand({ worktreePath: WORKTREE, sessionId: target.id }) ===
      `opencode --session ${target.id}`,
    'resume launch command uses --session'
  );
  check(
    harness.buildLaunchCommand({
      worktreePath: WORKTREE,
      forkFromSessionId: target.id,
    }) === `opencode --session ${target.id}`,
    'fork fallback resumes the API-created fork'
  );

  check(
    await harness.isSessionResumable(target.id, WORKTREE),
    'isSessionResumable finds the session'
  );
  check(
    !(await harness.isSessionResumable('ses_doesnotexist', WORKTREE)),
    'isSessionResumable rejects a missing session'
  );

  const worktreeSessions = await harness.listSessionsForWorktree(WORKTREE, true);
  check(
    worktreeSessions.every(
      (session) =>
        session.cwd === WORKTREE || session.cwd.startsWith(`${WORKTREE}/`)
    ),
    `worktree filter kept ${worktreeSessions.length} sessions in this directory`
  );

  const metadata = await harness.getSessionMetadata(target.id);
  check(Boolean(metadata?.model), `metadata model: ${metadata?.model}`);
  check(typeof metadata?.lastActivity === 'number', 'metadata lastActivity is set');
  check(metadata?.recap === null, 'opencode metadata has no recap');

  console.log('\n== fork + move + delete (scratch) ==');
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-opencode-move-'));
  let forkId: string | undefined;
  let forkDeleted = false;
  try {
    const fork = await harness.forkSession(target.id, WORKTREE);
    check(
      fork.kind === 'linked' && Boolean(fork.sessionId),
      `forkSession created ${fork.kind === 'linked' ? fork.sessionId : ''}`
    );
    forkId = fork.kind === 'linked' ? fork.sessionId : undefined;
    if (!forkId) {
      throw new Error('forkSession returned no session ID');
    }

    await harness.moveSession(forkId, destination, WORKTREE);
    const moved = await service.getSession(forkId, destination);
    check(
      moved?.location.directory === destination,
      `fork moved to ${moved?.location.directory}`
    );
    check(moved?.parentID === undefined, 'fork is a top-level session');

    const origin = await service.getSession(target.id, WORKTREE);
    check(Boolean(origin), 'source session still exists after forking');
  } finally {
    if (forkId) {
      await service.deleteSession(forkId, destination).catch(() => undefined);
      forkDeleted = (await service.getSession(forkId, destination)) === null;
    }
    fs.rmSync(destination, { recursive: true, force: true });
  }

  if (forkId) {
    check(forkDeleted, 'scratch fork was deleted');
  }

  console.log(`\n${failures === 0 ? 'ALL OPENCODE CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
