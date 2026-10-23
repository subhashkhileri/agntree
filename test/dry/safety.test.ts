import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GitService } from '../../src/services/GitService';
import { OpencodeSessionService } from '../../src/services/OpencodeSessionService';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function makeRepo(): { root: string; scratch: string } {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-safety-'));
  const root = path.join(scratch, 'repo');
  fs.mkdirSync(root);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Agntree Test']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'init']);
  return { root, scratch };
}

async function main(): Promise<void> {
  const { root, scratch } = makeRepo();
  const service = new GitService();

  try {
    console.log('\n== index / head lookups ==');
    check(service.isTracked(root, 'tracked.txt'), 'tracked file is reported as tracked');
    check(!service.isTracked(root, 'missing.txt'), 'unknown file is not tracked');
    check(service.existsInHead(root, 'tracked.txt'), 'committed file exists in HEAD');
    fs.writeFileSync(path.join(root, 'new.txt'), 'new\n');
    check(!service.existsInHead(root, 'new.txt'), 'untracked file is not in HEAD');

    console.log('\n== discard summary and guards ==');
    const summary = service.getDiscardSummary(root);
    check(summary.tracked === 0, 'summary counts no tracked changes yet');
    check(
      summary.untracked.includes('new.txt'),
      'summary lists the untracked file'
    );

    const outside = path.join(scratch, 'outside.txt');
    fs.writeFileSync(outside, 'keep me\n');
    check(
      service.discardFile(root, '../outside.txt') === false,
      'discard outside the worktree is refused'
    );
    check(fs.existsSync(outside), 'outside file survived the refused discard');

    check(
      service.discardFile(root, 'new.txt') === true,
      'untracked file inside the worktree is discarded'
    );
    check(!fs.existsSync(path.join(root, 'new.txt')), 'untracked file is gone');

    fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed\n');
    check(
      service.discardFile(root, 'tracked.txt') === true,
      'tracked change is discarded'
    );
    check(
      fs.readFileSync(path.join(root, 'tracked.txt'), 'utf-8') === 'original\n',
      'tracked file was restored from the index'
    );

    console.log('\n== worktree deletion guards ==');
    const isSafe = (target: string): boolean =>
      (service as unknown as {
        isSafeWorktreePath: (repo: string, wt: string) => boolean;
      }).isSafeWorktreePath(root, target);

    check(!isSafe(root), 'the repository itself cannot be force-removed');
    check(!isSafe(path.parse(root).root), 'the filesystem root cannot be force-removed');
    check(!isSafe(os.homedir()), 'the home directory cannot be force-removed');
    check(!isSafe(path.dirname(root)), 'a parent of the repository cannot be force-removed');
    check(
      !isSafe(path.join(scratch, 'not-a-worktree')),
      'a directory git does not list cannot be force-removed'
    );

    const worktree = path.join(scratch, 'worktree');
    check(
      service.createWorktreeWithNewBranch(root, 'safety-test-branch', worktree),
      'test worktree was created'
    );
    check(isSafe(worktree), 'a registered worktree may be force-removed');

    console.log('\n== harness deletion guards ==');
    const opencode = new OpencodeSessionService();
    let rejectedTraversal = false;
    try {
      await opencode.deleteSession('../../etc/passwd', scratch);
    } catch {
      rejectedTraversal = true;
    }
    check(rejectedTraversal, 'opencode refuses to delete a non-session value');

    let rejectedMissingId = false;
    try {
      await opencode.deleteSession('', scratch);
    } catch {
      rejectedMissingId = true;
    }
    check(rejectedMissingId, 'opencode refuses an empty session ID');
  } finally {
    service.removeWorktree(root, path.join(scratch, 'worktree'), true);
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(
    `\n${failures === 0 ? 'ALL SAFETY CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
