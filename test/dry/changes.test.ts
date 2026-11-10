import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  ChangeSectionItem,
  ChangesTreeProvider,
  ChangeTreeItem,
} from '../../src/providers/ChangesTreeProvider';
import { registerChangesCommands } from '../../src/commands/changes';
import { FileChange } from '../../src/types';
import { runCommand, shown, stub, tempDir, worktreeRecord } from './support';

beforeEach(() => stub.__reset());

const worktree = worktreeRecord({ name: 'feature', path: '/tmp/agntree-dry-changes' });

function provider(staged: FileChange[], unstaged: FileChange[], isGit = true) {
  return new ChangesTreeProvider(
    {
      getStagedChanges: () => staged,
      getUnstagedChanges: () => unstaged,
      isRebaseInProgress: () => false,
      getRebaseProgress: () => null,
    } as never,
    () => isGit
  );
}

const labels = (items: vscode.TreeItem[]) => items.map((item) => `${item.label} | ${item.description}`);

test('sections summarize counts, and flat rows sort by status then path with their directory', async (t) => {
  const changes = provider(
    [
      { path: 'src/z.ts', status: 'modified', additions: 2, deletions: 1 },
      { path: 'README.md', status: 'added', additions: 5, deletions: 0 },
    ],
    [{ path: 'src/utils/a.ts', status: 'modified', additions: 1, deletions: 1 }]
  );
  t.after(() => changes.dispose());
  changes.setActiveWorktree(worktree);

  const sections = (await changes.getChildren()) as ChangeSectionItem[];
  assert.deepEqual(labels(sections), ['Staged Changes | 2 files · +7 -1', 'Changes | 1 file · +1 -1']);
  assert.deepEqual(
    sections.map((section) => section.id),
    ['changes:staged', 'changes:unstaged'],
    'stable ids keep sections expanded across refreshes'
  );

  const staged = (await changes.getChildren(sections[0])) as vscode.TreeItem[];
  assert.deepEqual(labels(staged), ['README.md | A +5', 'z.ts | src · M +2 -1']);
  assert.equal(staged[1].tooltip, 'src/z.ts\n\nModified · +2 -1');
  assert.deepEqual(labels((await changes.getChildren(sections[1])) as vscode.TreeItem[]), [
    'a.ts | src/utils · M +1 -1',
  ]);
});

test('empty states: a clean tree, a plain folder, and no selection', async () => {
  const placeholder = async (changes: ChangesTreeProvider) => {
    const [row] = (await changes.getChildren()) as vscode.TreeItem[];
    changes.dispose();
    return `${row.label} (${(row.iconPath as vscode.ThemeIcon).id})`;
  };

  const clean = provider([], []);
  clean.setActiveWorktree(worktree);
  assert.equal(await placeholder(clean), 'No uncommitted changes (check)');

  const folder = provider([], [], false);
  folder.setActiveWorktree(worktree);
  assert.equal(await placeholder(folder), 'Not a git repository (info)');

  const [idle] = (await provider([], []).getChildren()) as vscode.TreeItem[];
  assert.equal(idle.label, 'Select a worktree or chat to view changes');
});

/** Register the Changes commands against a git double that records calls. */
function setupCommands(worktreePath: string, tracked: Set<string>) {
  const calls: string[] = [];
  const git = {
    isTracked: (_w: string, file: string) => tracked.has(file),
    discardFile: (_w: string, file: string) => {
      calls.push(`discard ${file}`);
      return true;
    },
    discardAll: () => {
      calls.push('discardAll');
      return true;
    },
    getDiscardSummary: () => ({ tracked: 2, untracked: ['build/', 'notes.txt'] }),
  };
  let refreshes = 0;
  const changesProvider = {
    getActiveWorktree: () => worktreeRecord({ name: 'feature', path: worktreePath }),
    refresh: () => refreshes++,
  };
  registerChangesCommands({ subscriptions: [] } as never, git as never, changesProvider as never, () => undefined);
  return { calls, refreshes: () => refreshes };
}

const changeRow = (worktreePath: string, file: string) =>
  new ChangeTreeItem({ path: file, status: 'modified', additions: 0, deletions: 0 }, worktreePath, false);

test('Discard refuses paths outside the worktree, trashes untracked files, and restores tracked ones', async (t) => {
  const root = tempDir(t);
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'u');
  const { calls, refreshes } = setupCommands(root, new Set(['tracked.txt']));

  await runCommand('agntree.discardFile', changeRow(root, '../escape.txt'));
  assert.ok(shown('Refusing to discard a path outside the worktree'));

  stub.__warningResponses.push(undefined);
  await runCommand('agntree.discardFile', changeRow(root, 'untracked.txt'));
  assert.ok(fs.existsSync(path.join(root, 'untracked.txt')), 'cancelling keeps the file');

  stub.__warningResponses.push('Discard');
  await runCommand('agntree.discardFile', changeRow(root, 'untracked.txt'));
  assert.ok(shown('Move untracked file "untracked.txt" to the Trash?'));
  assert.deepEqual(stub.__deleted, [{ path: path.join(root, 'untracked.txt'), options: { useTrash: true } }]);

  stub.__warningResponses.push('Discard');
  await runCommand('agntree.discardFile', changeRow(root, 'tracked.txt'));
  assert.ok(shown('Discard changes to "tracked.txt"? This cannot be undone.'));
  assert.deepEqual(calls, ['discard tracked.txt']);
  assert.equal(refreshes(), 2);
});

test('Discard All says exactly what git clean will delete before it runs', async (t) => {
  const { calls } = setupCommands(tempDir(t), new Set());

  stub.__warningResponses.push(undefined);
  await runCommand('agntree.discardAll');
  assert.ok(
    shown('Discard 2 modified files and 2 untracked files or folders in "feature"?'),
    'the confirmation counts both kinds'
  );
  assert.ok(shown('permanently deleted'));
  assert.deepEqual(calls, [], 'cancelling discards nothing');

  stub.__warningResponses.push('Discard All');
  await runCommand('agntree.discardAll');
  assert.deepEqual(calls, ['discardAll']);
});
