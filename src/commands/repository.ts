import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { Repository, Worktree } from '../types';
import { canonicalPath } from '../utils/paths';
import { commandRegistrar, withProgress } from './common';

export interface RepositoryCommandDeps {
  storageService: StorageService;
  gitService: GitService;
  /** Remove a forgotten root's chats and clear the panels if they show it. */
  forgetWorktrees: (worktrees: Worktree[]) => void;
  refreshTree: () => void;
}

/** Workspace-root commands: add, clone, remove, reorder, refresh. */
export function registerRepositoryCommands(context: vscode.ExtensionContext, deps: RepositoryCommandDeps): void {
  const { storageService, gitService, refreshTree } = deps;
  const register = commandRegistrar(context);

  const pickFolder = async (openLabel: string, title: string): Promise<string | undefined> =>
    (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel, title }))?.[0]
      ?.fsPath;

  register('agntree.addRepository', async () => {
    const picked = await pickFolder('Add', 'Select a Folder or Git Repository');
    if (!picked) {
      return;
    }
    // The physical path, so a folder opened through a symlink gets the same
    // identity git reports after `git init`.
    const folderPath = canonicalPath(picked);
    // `--show-toplevel` resolves a subdirectory to its repository root and
    // answers null for a plain folder.
    const repoRoot = gitService.getRepoRoot(folderPath);
    // A bare repository or a `.git` directory has no files to edit.
    if (!repoRoot && gitService.isGitRepository(folderPath)) {
      vscode.window.showErrorMessage(
        'That folder is a git directory, not a working tree. Select the project folder instead.'
      );
      return;
    }
    const rootPath = repoRoot ?? folderPath;
    const repo = storageService.addRepository(path.basename(rootPath), rootPath);
    vscode.window.showInformationMessage(repoRoot ? `Added repository: ${repo.name}` : `Added folder: ${repo.name}`);
    refreshTree();
  });

  register('agntree.removeRepository', async (item?: WorkspaceTreeItem) => {
    let repo = item?.itemType === 'repository' ? (item.data as Repository) : undefined;
    if (!repo) {
      const repos = storageService.getRepositories();
      if (repos.length === 0) {
        vscode.window.showInformationMessage('No repositories to remove.');
        return;
      }
      repo = (
        await vscode.window.showQuickPick(
          repos.map((r) => ({ label: r.name, description: r.rootPath, repo: r })),
          { placeHolder: 'Select repository to remove from extension' }
        )
      )?.repo;
      if (!repo) {
        return;
      }
    }

    const confirm = await vscode.window.showWarningMessage(
      `Remove "${repo.name}" from Agntree?\n\nIts session rows leave the list, losing custom names and stars, and their terminals close. Your files, git repository, and the agents' conversations are NOT deleted; Import Sessions can bring the sessions back after you add it again.`,
      { modal: true },
      'Remove'
    );
    if (confirm !== 'Remove') {
      return;
    }
    // Its chats would otherwise linger unseen and keep their sessions from
    // being imported when the folder is added again.
    deps.forgetWorktrees(gitService.listRepositoryWorktrees(repo.rootPath, repo.id).worktrees);
    storageService.removeRepository(repo.id);
    vscode.window.showInformationMessage(`Removed "${repo.name}" from extension`);
    refreshTree();
  });

  const moveRepository = (direction: 'up' | 'down') => (item?: WorkspaceTreeItem) => {
    if (item?.itemType !== 'repository') {
      return;
    }
    const repo = item.data as Repository;
    if (storageService.moveRepository(repo.id, direction)) {
      refreshTree();
    } else {
      vscode.window.showInformationMessage(`"${repo.name}" is already at the ${direction === 'up' ? 'top' : 'bottom'}.`);
    }
  };
  register('agntree.moveRepositoryUp', moveRepository('up'));
  register('agntree.moveRepositoryDown', moveRepository('down'));

  register('agntree.refreshWorkspaces', refreshTree);

  register('agntree.cloneRepository', async () => {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter GitHub repository URL',
      placeHolder: 'https://github.com/owner/repo or owner/repo',
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return 'Repository URL is required';
        }
        return trimmed.includes('github.com') || /^[\w-]+\/[\w.-]+$/.test(trimmed)
          ? undefined
          : 'Enter a valid GitHub URL or owner/repo format';
      },
    });
    if (!input) {
      return;
    }

    let url = input.trim();
    if (!url.includes('://')) {
      url = `https://github.com/${url}`;
    }
    if (!url.endsWith('.git')) {
      url = `${url}.git`;
    }
    const repoName = path.basename(url, '.git');
    if (!repoName || repoName === '.' || repoName === '..' || /[\\/]/.test(repoName)) {
      vscode.window.showErrorMessage('Could not determine a safe folder name from that URL.');
      return;
    }

    const parent = await pickFolder('Select Parent Folder', 'Select where to clone the repository');
    if (!parent) {
      return;
    }
    const clonePath = path.join(parent, repoName);
    const result = await withProgress(`Cloning ${repoName}...`, () => gitService.clone(url, clonePath));
    if (!result.success) {
      vscode.window.showErrorMessage(`Failed to clone repository: ${result.error}`);
      return;
    }
    const repo = storageService.addRepository(repoName, clonePath);
    vscode.window.showInformationMessage(`Cloned and added repository: ${repo.name}`);
    refreshTree();
  });
}
