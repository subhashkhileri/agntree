import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FilesTreeProvider, FileTreeItem } from '../../src/providers/FilesTreeProvider';
import { tempDir, worktreeRecord } from './support';

test('All Files lists folders first in natural order, hides build and VCS output, and keys rows by path', async (t) => {
  const root = tempDir(t);
  for (const dir of ['src', 'node_modules', '.git']) {
    fs.mkdirSync(path.join(root, dir));
  }
  for (const file of ['src/a.ts', 'file10.txt', 'file2.txt', 'README.md', 'node_modules/x.js']) {
    fs.writeFileSync(path.join(root, file), '');
  }
  const files = new FilesTreeProvider();
  t.after(() => files.dispose());

  const [placeholder] = (await files.getChildren()) as vscode.TreeItem[];
  assert.equal(placeholder.label, 'Select a worktree or chat');

  files.setActiveWorktree(worktreeRecord({ path: root }));
  const top = (await files.getChildren()) as FileTreeItem[];
  assert.deepEqual(top.map((item) => item.label), ['src', 'file2.txt', 'file10.txt', 'README.md']);
  assert.ok(top.every((item) => item.id === `file:${item.uri.fsPath}`), 'stable ids keep folders expanded');

  const src = top[0];
  assert.equal(src.contextValue, 'folder');
  const [nested] = (await files.getChildren(src)) as FileTreeItem[];
  assert.equal(nested.tooltip, 'src/a.ts', 'rows tooltip their worktree-relative path');
});
