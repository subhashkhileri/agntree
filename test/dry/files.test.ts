import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FileTreeItem,
  FilesTreeProvider,
} from '../../src/providers/FilesTreeProvider';
import { Worktree } from '../../src/types';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-dry-files-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(root, 'file10.txt'), 'ten\n');
  fs.writeFileSync(path.join(root, 'file2.txt'), 'two\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# demo\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), '');

  const worktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    name: 'feature',
    path: root,
    isMain: false,
  } as Worktree;

  const provider = new FilesTreeProvider();

  console.log('\n== empty state ==');
  const idle = (await provider.getChildren()) as vscode.TreeItem[];
  check(
    idle.length === 1 && idle[0].label === 'Select a worktree or chat',
    'no worktree shows a placeholder row'
  );

  console.log('\n== listing ==');
  provider.setActiveWorktree(worktree);
  const items = (await provider.getChildren()) as FileTreeItem[];
  check(
    items.map((item) => item.label).join(',') === 'src,file2.txt,file10.txt,README.md',
    `directories first, then natural file order: ${items
      .map((item) => item.label)
      .join(', ')}`
  );
  check(
    !items.some((item) => item.label === 'node_modules' || item.label === '.git'),
    'build output and VCS metadata stay hidden'
  );
  check(
    items.every((item) => item.tooltip === item.label),
    'top-level rows tooltip their relative path'
  );
  check(
    items.every((item) => item.id === `file:${item.uri.fsPath}`),
    'rows have stable ids so watcher refreshes keep folders expanded'
  );

  const src = items.find((item) => item.label === 'src')!;
  check(
    src.fileType === vscode.FileType.Directory && src.contextValue === 'folder',
    'folders are collapsible and carry folder actions'
  );
  const nested = (await provider.getChildren(src)) as FileTreeItem[];
  check(
    nested.length === 1 && nested[0].label === 'a.ts',
    'folder children are listed'
  );
  check(
    nested[0].tooltip === 'src/a.ts' && nested[0].resourceUri?.fsPath === path.join(root, 'src', 'a.ts'),
    `nested rows tooltip the worktree-relative path: ${nested[0].tooltip}`
  );

  provider.dispose();
  fs.rmSync(root, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL FILES PANEL CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
