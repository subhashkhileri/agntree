import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../../src/services/GitService';
import { GitHubService } from '../../src/services/GitHubService';
import { registerWorktreeCommands } from '../../src/commands/worktree';
import { Worktree } from '../../src/types';
import { makeStorage, runCommand, shown, stub, tempDir } from './support';

beforeEach(() => stub.__reset());

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', ...args], { cwd, encoding: 'utf8' }).trim();

/** A repository `app` with one commit on `main`, added as a root. */
function setup(t: { after(fn: () => void): void }) {
  const scratch = fs.realpathSync(tempDir(t));
  const repoPath = path.join(scratch, 'app');
  fs.mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'commit', '-q', '--allow-empty', '-m', 'init');

  const storage = makeStorage();
  const repo = storage.addRepository('app', repoPath);
  const gitService = new GitService();
  // Records whether each worktree's directory still existed when it was forgotten.
  const forgotten: { path: string; existed: boolean }[] = [];
  registerWorktreeCommands({ subscriptions: [] } as never, {
    storageService: storage,
    gitService,
    gitHubService: new GitHubService(),
    workspacesProvider: {
      getWorktreeForItem: (item) => item?.data as Worktree | undefined,
      isGitRepo: () => true,
      getPRUrl: () => undefined,
    },
    forgetWorktrees: (worktrees) =>
      forgotten.push(...worktrees.map((w) => ({ path: w.path, existed: fs.existsSync(w.path) }))),
    switchWorkspaceFolder: () => undefined,
    refreshTree: () => undefined,
  });
  const worktreeAt = (worktreePath: string) =>
    gitService.listWorktrees(repoPath, repo.id).find((w) => w.path === worktreePath)!;
  const branches = () => gitService.getBranches(repoPath).sort();
  return { scratch, repoPath, repo, worktreeAt, branches, forgotten };
}

test('Create Worktree puts a new branch under <repo>-worktrees and hides branches already checked out', async (t) => {
  const { scratch, repo, worktreeAt, branches } = setup(t);
  const row = { itemType: 'repository', data: repo };

  stub.__quickPickResponses.push({ value: 'new' }, { label: 'main' });
  stub.__inputResponses.push('feat/login');
  await runCommand('agntree.addWorktree', row);
  const created = path.join(scratch, 'app-worktrees', 'feat-login');
  assert.equal(worktreeAt(created)?.branch, 'feat/login');
  assert.deepEqual(branches(), ['feat/login', 'main']);

  // Both branches are checked out, so "Existing branch" has nothing to offer.
  stub.__quickPickResponses.push({ value: 'existing' });
  await runCommand('agntree.addWorktree', row);
  assert.ok(shown('All branches are already checked out'));
});

test('Delete Worktree closes its sessions before removing the directory, and a detached worktree never deletes a branch', async (t) => {
  const { scratch, repoPath, worktreeAt, branches, forgotten } = setup(t);
  // A branch that shares the detached worktree's folder name.
  git(repoPath, 'branch', 'release');
  const detached = path.join(scratch, 'release');
  git(repoPath, 'worktree', 'add', '-q', '--detach', detached);
  const worktree = worktreeAt(detached);
  assert.equal(worktree.name, 'release');
  assert.equal(worktree.branch, undefined);

  stub.__warningResponses.push('Delete Worktree Only');
  await runCommand('agntree.deleteWorktree', { itemType: 'worktree', data: worktree });

  const confirmation = stub.__messages.find((args) => String(args[0]).startsWith('Delete worktree'))!;
  assert.deepEqual(confirmation.slice(2), ['Delete Worktree Only'], 'no branch to delete');
  assert.equal(fs.existsSync(detached), false);
  assert.deepEqual(forgotten, [{ path: detached, existed: true }]);
  assert.deepEqual(branches(), ['main', 'release']);
});

test('Delete Worktree & Branch removes the worktree and its branch', async (t) => {
  const { scratch, repoPath, worktreeAt, branches } = setup(t);
  const linked = path.join(scratch, 'app-feature');
  git(repoPath, 'worktree', 'add', '-q', '-b', 'feature', linked);

  stub.__warningResponses.push('Delete Worktree & Branch');
  await runCommand('agntree.deleteWorktree', { itemType: 'worktree', data: worktreeAt(linked) });

  assert.equal(fs.existsSync(linked), false);
  assert.deepEqual(branches(), ['main']);
});

test('Rebase offers the remote branches, recommended main first, but not the branch’s own remote copy', async (t) => {
  const { scratch, repoPath, worktreeAt } = setup(t);
  const remote = path.join(scratch, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git(repoPath, 'remote', 'add', 'origin', remote);
  git(repoPath, 'push', '-q', 'origin', 'main');
  const linked = path.join(scratch, 'app-feature');
  git(repoPath, 'worktree', 'add', '-q', '-b', 'feature', linked);
  git(linked, 'push', '-q', 'origin', 'feature', 'main:zeta');

  let offered: string[] = [];
  stub.__setQuickPickHandler((items: { branch: string }[]) => {
    offered = items.map((item) => item.branch);
    return undefined;
  });
  await runCommand('agntree.rebaseWorktree', { itemType: 'worktree', data: worktreeAt(linked) });

  assert.deepEqual(offered, ['origin/main', 'origin/zeta']);
});
