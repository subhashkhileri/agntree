import * as vscode from 'vscode';
import {
  ChangeSectionItem,
  ChangesTreeProvider,
} from '../../src/providers/ChangesTreeProvider';
import { FileChange, Worktree } from '../../src/types';

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

const worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  name: 'feature',
  path: '/tmp/agntree-dry-changes',
  isMain: false,
} as Worktree;

const staged: FileChange[] = [
  { path: 'src/z.ts', status: 'modified', additions: 2, deletions: 1 },
  { path: 'README.md', status: 'added', additions: 5, deletions: 0 },
];
const unstaged: FileChange[] = [
  { path: 'src/utils/a.ts', status: 'modified', additions: 1, deletions: 1 },
];

function createProvider(
  stagedChanges: FileChange[],
  unstagedChanges: FileChange[]
): ChangesTreeProvider {
  return new ChangesTreeProvider(
    {} as any,
    {
      getStagedChanges: () => stagedChanges,
      getUnstagedChanges: () => unstagedChanges,
      isRebaseInProgress: () => false,
      getRebaseProgress: () => null,
    } as any,
    () => worktree
  );
}

async function main(): Promise<void> {
  console.log('\n== sections ==');
  const provider = createProvider(staged, unstaged);
  provider.setActiveWorktree(worktree);

  const roots = (await provider.getChildren()) as ChangeSectionItem[];
  check(roots.length === 2, 'staged and unstaged sections are rendered');
  check(
    roots[0] instanceof ChangeSectionItem && roots[0].sectionType === 'staged',
    'staged section comes first'
  );
  check(
    roots[0].description === '2 files · +7 -1',
    `staged header reads naturally: ${roots[0].description}`
  );
  check(
    roots[1].description === '1 file · +1 -1',
    `singular header uses "file": ${roots[1].description}`
  );
  check(
    roots[0].id === 'changes:staged' && roots[1].id === 'changes:unstaged',
    'sections have stable ids so refreshes keep them expanded'
  );

  const stagedIcon = roots[0].iconPath as vscode.ThemeIcon;
  const unstagedIcon = roots[1].iconPath as vscode.ThemeIcon;
  check(stagedIcon.id === 'check', 'staged section uses a check mark');
  check(
    (stagedIcon.color as vscode.ThemeColor)?.id === 'charts.green',
    'staged section is green'
  );
  check(
    unstagedIcon.id === 'edit' &&
      (unstagedIcon.color as vscode.ThemeColor)?.id === 'charts.yellow',
    'unstaged section is yellow'
  );

  console.log('\n== file rows ==');
  const stagedFiles = (await provider.getChildren(roots[0])) as vscode.TreeItem[];
  check(stagedFiles.length === 2, 'every staged file is listed');
  check(
    stagedFiles[0].label === 'README.md' && stagedFiles[1].label === 'z.ts',
    'files sort by status, then path'
  );
  check(
    stagedFiles[0].description === 'A +5',
    `root files omit an empty directory: ${stagedFiles[0].description}`
  );
  check(
    stagedFiles[1].description === 'src · M +2 -1',
    `nested files show their directory: ${stagedFiles[1].description}`
  );
  check(
    stagedFiles[1].tooltip === 'src/z.ts\n\nModified · +2 -1',
    `tooltip carries the path and a readable status: ${stagedFiles[1].tooltip}`
  );

  const unstagedFiles = (await provider.getChildren(roots[1])) as vscode.TreeItem[];
  check(
    unstagedFiles[0].description === 'src/utils · M +1 -1',
    `nested path stays readable in the unstaged section: ${unstagedFiles[0].description}`
  );

  console.log('\n== empty state ==');
  const cleanProvider = createProvider([], []);
  cleanProvider.setActiveWorktree(worktree);
  const clean = (await cleanProvider.getChildren()) as vscode.TreeItem[];
  const emptyIcon = clean[0]?.iconPath as vscode.ThemeIcon;
  check(clean.length === 1 && clean[0].label === 'No uncommitted changes', 'clean tree explains itself');
  check(
    emptyIcon?.id === 'check' &&
      (emptyIcon.color as vscode.ThemeColor)?.id === 'charts.green',
    'clean tree uses a green check'
  );

  const idleProvider = createProvider([], []);
  const idle = (await idleProvider.getChildren()) as vscode.TreeItem[];
  check(
    idle[0]?.label === 'Select a worktree or chat to view changes',
    'no active worktree asks for one'
  );

  provider.dispose();
  cleanProvider.dispose();
  idleProvider.dispose();
  console.log(
    `\n${failures === 0 ? 'ALL CHANGES PANEL CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
