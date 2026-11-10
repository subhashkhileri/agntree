import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { GitService } from '../../src/services/GitService';
import { registerRepositoryCommands } from '../../src/commands/repository';
import { makeStorage, runCommand, shownMessages, stub, tempDir } from './support';

beforeEach(() => stub.__reset());

function setup() {
  const storage = makeStorage();
  let refreshes = 0;
  const forgotten: string[] = [];
  registerRepositoryCommands({ subscriptions: [] } as never, {
    storageService: storage,
    gitService: new GitService(),
    forgetWorktrees: (worktrees) => forgotten.push(...worktrees.map((worktree) => worktree.path)),
    refreshTree: () => refreshes++,
  });
  const add = async (folder: string) => {
    stub.__openDialogResponses.push([{ fsPath: folder }]);
    await runCommand('agntree.addRepository');
    return shownMessages().at(-1);
  };
  const roots = () => storage.getRepositories().map((repo) => repo.name);
  return { storage, add, roots, forgotten, refreshes: () => refreshes };
}

test('Add accepts a plain folder, adds a subdirectory as its repository root, and refuses a bare repository', async (t) => {
  const scratch = tempDir(t);
  const plain = path.join(scratch, 'scratchpad');
  const repo = path.join(scratch, 'notes');
  const bare = path.join(scratch, 'bare.git');
  fs.mkdirSync(plain);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const { add, roots } = setup();

  assert.equal(await add(plain), 'Added folder: scratchpad');
  assert.equal(await add(path.join(repo, 'src')), 'Added repository: notes');
  assert.match((await add(bare)) ?? '', /not a working tree/);
  assert.deepEqual(roots(), ['scratchpad', 'notes']);
});

test('Move Up and Move Down reorder roots; a refused move explains itself without a refresh', async () => {
  const { storage, roots, refreshes } = setup();
  const first = storage.addRepository('first', '/first');
  storage.addRepository('second', '/second');
  const row = { itemType: 'repository', data: first };

  await runCommand('agntree.moveRepositoryDown', row);
  assert.deepEqual(roots(), ['second', 'first']);
  await runCommand('agntree.moveRepositoryUp', row);
  assert.deepEqual(roots(), ['first', 'second']);
  assert.equal(refreshes(), 2);

  await runCommand('agntree.moveRepositoryUp', row);
  assert.equal(refreshes(), 2);
  assert.equal(shownMessages().at(-1), '"first" is already at the top.');
});

test('Remove forgets every worktree of the root, so re-adding the folder can import its sessions again', async (t) => {
  const scratch = tempDir(t);
  const repo = path.join(scratch, 'app');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const linked = path.join(scratch, 'app-feature');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'feature', linked], { cwd: repo });
  const { storage, add, roots, forgotten } = setup();
  await add(repo);
  const row = { itemType: 'repository', data: storage.getRepositories()[0] };

  await runCommand('agntree.removeRepository', row);
  assert.deepEqual(roots(), ['app'], 'nothing changes without confirmation');
  assert.deepEqual(forgotten, []);

  stub.__warningResponses.push('Remove');
  await runCommand('agntree.removeRepository', row);
  assert.deepEqual(roots(), []);
  assert.deepEqual(forgotten.map((p) => fs.realpathSync(p)).sort(), [fs.realpathSync(repo), fs.realpathSync(linked)].sort());
});
