import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { StorageService } from '../../src/services/StorageService';
import { GitService } from '../../src/services/GitService';
import { registerRepositoryCommands } from '../../src/commands/repository';
import { canonicalPath } from '../../src/utils/paths';

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

function makeMemento() {
  const state = new Map<string, unknown>();
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    get: <T>(key: string, fallback: T): T =>
      state.has(key) ? clone(state.get(key) as T) : fallback,
    update: async (key: string, value: unknown): Promise<void> => {
      state.set(key, clone(value));
    },
    keys: () => Array.from(state.keys()),
    setKeysForSync: () => undefined,
  };
}

async function main(): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-roots-'));
  const folder = path.join(scratch, 'notes');
  fs.mkdirSync(folder);

  try {
    const service = new GitService();

    console.log('\n== plain folder roots ==');
    const before = service.listRepositoryWorktrees(folder, 'repo-notes');
    check(before.isGit === false, 'a plain folder is not reported as git');
    check(
      before.worktrees.length === 1 && before.worktrees[0].isMain,
      'a plain folder is its own single worktree'
    );
    const folderWorktree = before.worktrees[0];
    check(
      folderWorktree.path === folder && folderWorktree.name === 'notes',
      `the root worktree points at the folder (${folderWorktree.path})`
    );
    check(
      service.listWorktrees(folder, 'repo-notes').length === 0,
      'git-only callers still see no worktrees for a plain folder'
    );

    console.log('\n== git init keeps the worktree binding ==');
    git(folder, ['init']);
    const after = service.listRepositoryWorktrees(folder, 'repo-notes');
    check(after.isGit === true, 'the same folder is now a git repository');
    check(
      after.worktrees.length === 1 && after.worktrees[0].isMain,
      'the repository has one main worktree'
    );
    check(
      after.worktrees[0].id === folderWorktree.id,
      'the worktree id is identical before and after git init'
    );

    console.log('\n== a repository inside a plain folder ==');
    const nested = path.join(folder, 'nested');
    fs.mkdirSync(nested);
    const nestedState = service.listRepositoryWorktrees(nested, 'repo-nested');
    check(
      nestedState.isGit === false,
      'a subdirectory of a repository is not itself a workspace root'
    );
    check(
      nestedState.worktrees[0].path === nested,
      `the subdirectory is its own root worktree (${nestedState.worktrees[0].path})`
    );

    console.log('\n== bare repositories ==');
    const bare = path.join(scratch, 'bare.git');
    git(scratch, ['init', '--bare', bare]);
    const bareState = service.listRepositoryWorktrees(bare, 'repo-bare');
    check(bareState.isGit === true, 'a bare repository is still a repository');
    check(
      bareState.worktrees.length === 0,
      'a bare repository has no working tree to run sessions in'
    );

    console.log('\n== add command accepts any folder ==');
    const storageService = new StorageService({
      globalState: makeMemento(),
      workspaceState: makeMemento(),
    } as any);
    const commands = (vscode as any).commands;
    const context = {
      subscriptions: [] as { dispose(): void }[],
      extensionUri: (vscode as any).Uri.file('/extension'),
    };
    let refreshes = 0;
    registerRepositoryCommands(
      context as any,
      storageService,
      service,
      () => {
        refreshes++;
      }
    );

    const plain = path.join(scratch, 'scratchpad');
    fs.mkdirSync(plain);
    (vscode as any).__openDialogResponses.push([{ fsPath: plain }]);
    await commands.executeCommand('agntree.addRepository');
    const plainRepo = storageService
      .getRepositories()
      .find((repo) => repo.rootPath === canonicalPath(plain));
    check(Boolean(plainRepo), 'a plain folder is stored as a workspace root');
    check(
      (vscode as any).__messages.at(-1)?.[0] === 'Added folder: scratchpad',
      `the message names a folder (${(vscode as any).__messages.at(-1)?.[0]})`
    );

    console.log('\n== a subdirectory adds its repository root ==');
    const sub = path.join(folder, 'src');
    fs.mkdirSync(sub);
    (vscode as any).__openDialogResponses.push([{ fsPath: sub }]);
    await commands.executeCommand('agntree.addRepository');
    const added = storageService
      .getRepositories()
      .find((repo) => repo.rootPath === canonicalPath(folder));
    check(Boolean(added), 'selecting a subdirectory stores the repository root');
    check(
      (vscode as any).__messages.at(-1)?.[0] === 'Added repository: notes',
      `the message names a repository (${(vscode as any).__messages.at(-1)?.[0]})`
    );

    console.log('\n== add command refuses a git directory ==');
    (vscode as any).__openDialogResponses.push([{ fsPath: bare }]);
    await commands.executeCommand('agntree.addRepository');
    check(
      !storageService
        .getRepositories()
        .some((repo) => repo.rootPath === canonicalPath(bare)),
      'a bare repository is not stored as a workspace root'
    );
    check(
      String((vscode as any).__messages.at(-1)?.[0]).includes('not a working tree'),
      `the message explains the refusal (${(vscode as any).__messages.at(-1)?.[0]})`
    );

    console.log('\n== repository order commands ==');
    const order = () =>
      storageService
        .getRepositories()
        .map((repo) => repo.name)
        .join(',');
    const scratchpadRepo = storageService
      .getRepositories()
      .find((repo) => repo.name === 'scratchpad')!;
    const asItem = (data: unknown) => ({ itemType: 'repository', data });

    check(order() === 'scratchpad,notes', `rows follow the stored order (${order()})`);
    refreshes = 0;
    await commands.executeCommand('agntree.moveRepositoryDown', asItem(scratchpadRepo));
    check(order() === 'notes,scratchpad', `Move Down reorders the rows (${order()})`);
    check(refreshes === 1, 'a successful move refreshes the tree');

    refreshes = 0;
    await commands.executeCommand('agntree.moveRepositoryUp', asItem(scratchpadRepo));
    check(order() === 'scratchpad,notes', `Move Up reorders the rows (${order()})`);
    check(refreshes === 1, 'moving up refreshes the tree');

    refreshes = 0;
    await commands.executeCommand('agntree.moveRepositoryUp', asItem(scratchpadRepo));
    check(order() === 'scratchpad,notes', 'moving the first row up changes nothing');
    check(refreshes === 0, 'a refused move does not refresh');
    check(
      (vscode as any).__messages.at(-1)?.[0] === '"scratchpad" is already at the top.',
      `a refused move explains why (${(vscode as any).__messages.at(-1)?.[0]})`
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(
    `\n${failures === 0 ? 'ALL WORKSPACE ROOT CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
