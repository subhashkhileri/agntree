import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';

const REPO = process.env.AGNTREE_TEST_CLAUDE_REPO || process.cwd();
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
  const service = new ClaudeSessionService();
  const harness = new ClaudeHarness();

  console.log(`\n== installation + discovery (repo: ${REPO}) ==`);
  check(service.isClaudeInstalled(), 'isClaudeInstalled() is true');

  const worktreeSessions = await service.findSessionsForWorktree(REPO);
  if (worktreeSessions.length === 0) {
    console.log(
      'SKIP  no Claude sessions found for this repository; set AGNTREE_TEST_CLAUDE_REPO to a repo with sessions'
    );
    process.exit(0);
  }

  const session =
    worktreeSessions.find((candidate) => candidate.messageCount > 0) ??
    worktreeSessions[0];
  check(worktreeSessions.length > 0, `findSessionsForWorktree returned ${worktreeSessions.length}`);
  check(Boolean(session.sessionId), `session ID: ${session.sessionId}`);
  check(Boolean(session.cwd), `session cwd: ${session.cwd}`);
  console.log(`      summary: ${session.summary}`);
  console.log(`      branch: ${session.gitBranch}, messages: ${session.messageCount}`);

  console.log('\n== session lookup + preview ==');
  const byId = await service.getSessionById(session.sessionId);
  check(byId?.sessionId === session.sessionId, 'getSessionById returns the session');
  check(service.isSessionResumable(session.sessionId), 'isSessionResumable is true');
  check(
    !service.isSessionResumable('00000000-0000-0000-0000-000000000000'),
    'missing session is not resumable'
  );

  const preview = service.getSessionPreview(session.sessionId, 3);
  check(Array.isArray(preview), `getSessionPreview returned ${preview.length} messages`);
  for (const message of preview) {
    console.log(`      preview: ${message.text.slice(0, 60)}`);
  }

  check(
    typeof byId?.lastPromptAt === 'number' && byId.lastPromptAt > 0,
    `lastPromptAt: ${byId?.lastPromptAt ? new Date(byId.lastPromptAt).toISOString() : byId?.lastPromptAt}`
  );

  const recap = byId?.recap ?? null;
  console.log(`      recap: ${recap ? recap.slice(0, 60) : '(none)'}`);

  const repoWide = await service.findSessionsForRepository(REPO, []);
  check(
    repoWide.length >= worktreeSessions.length,
    `findSessionsForRepository returned ${repoWide.length}`
  );

  console.log('\n== adapter ==');
  check(await harness.isInstalled(), 'ClaudeHarness.isInstalled() is true');
  check(
    harness.buildLaunchCommand({ worktreePath: REPO }) === 'claude',
    'new-session command is "claude"'
  );
  check(
    harness.buildLaunchCommand({ worktreePath: REPO, sessionId: session.sessionId }) ===
      `claude --resume ${session.sessionId}`,
    'resume command uses --resume'
  );
  check(
    harness.buildLaunchCommand({
      worktreePath: REPO,
      forkFromSessionId: session.sessionId,
    }) === `claude --resume ${session.sessionId} --fork-session`,
    'fork command uses --fork-session'
  );
  check(
    await harness.isSessionResumable(session.sessionId),
    'adapter isSessionResumable is true'
  );

  const headless = harness.buildHeadlessCommand({
    name: 'Dry Test',
    prompt: 'say ok',
    allowedTools: 'Read',
  });
  check(
    headless?.command === 'claude' &&
      headless.args.join(' ') === '-p say ok --allowedTools Read',
    `headless command: ${headless?.command} ${headless?.args.join(' ')}`
  );
  check(
    harness.buildHeadlessCommand({ name: 'Dry Test', prompt: 'say ok' }) === null,
    'headless requires allowedTools for Claude'
  );

  const metadata = await harness.getSessionMetadata(session.sessionId);
  check(metadata !== null, 'getSessionMetadata returns data');
  check(typeof metadata?.lastActivity === 'number', 'metadata lastActivity is set');
  check(metadata?.recap === session.recap, 'metadata recap matches the parsed session');

  const adapterPreview = await harness.getPreview(session.sessionId, 2);
  check(
    adapterPreview.length <= 2,
    `adapter getPreview returned ${adapterPreview.length} messages`
  );

  const adapterSessions = await harness.listSessionsForWorktree(REPO);
  check(
    adapterSessions.length === worktreeSessions.length,
    'adapter discovery matches the service'
  );
  const adapterRepo = await harness.listSessionsForRepository(REPO, []);
  check(adapterRepo.length === repoWide.length, 'adapter repo search matches the service');
  check(
    harness.capabilities.fork && !harness.capabilities.move && harness.capabilities.recap,
    'Claude capabilities are fork/recap without move'
  );

  const fork = await harness.forkSession(session.sessionId);
  check(fork.sessionId === undefined, 'Claude fork defers to the terminal (no ID yet)');

  console.log(`\n${failures === 0 ? 'ALL CLAUDE CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
