import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { Repository } from '../types';
import { canonicalPath } from '../utils/paths';

/**
 * Register repository-related commands
 */
export function registerRepositoryCommands(
  context: vscode.ExtensionContext,
  storageService: StorageService,
  gitService: GitService,
  refreshTree: () => void
): void {
  // Add Repository
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.addRepository', async () => {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Add',
        title: 'Select a Folder or Git Repository',
      });

      if (!folders || folders.length === 0) {
        return;
      }

      // Store the physical path so a folder opened through a symlink gets the
      // same identity git will report after `git init`.
      const folderPath = canonicalPath(folders[0].fsPath);

      // `--show-toplevel` resolves a subdirectory to the repository root and
      // answers null for a plain folder, so one probe decides both cases.
      const repoRoot = gitService.getRepoRoot(folderPath);

      // A bare repository or a `.git` directory is a git directory, not a
      // working tree; sessions need files to edit.
      if (!repoRoot && gitService.isGitRepository(folderPath)) {
        vscode.window.showErrorMessage(
          'That folder is a git directory, not a working tree. Select the project folder instead.'
        );
        return;
      }

      const rootPath = repoRoot ?? folderPath;
      const name = path.basename(rootPath);
      const repo = storageService.addRepository(name, rootPath);

      vscode.window.showInformationMessage(
        repoRoot ? `Added repository: ${repo.name}` : `Added folder: ${repo.name}`
      );
      refreshTree();
    })
  );

  // Remove Repository (from extension only - does not delete files)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.removeRepository',
      async (item?: WorkspaceTreeItem) => {
        let repo: Repository | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as Repository;
        } else {
          const repos = storageService.getRepositories();
          if (repos.length === 0) {
            vscode.window.showInformationMessage('No repositories to remove.');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            repos.map((r) => ({
              label: r.name,
              description: r.rootPath,
              repo: r,
            })),
            { placeHolder: 'Select repository to remove from extension' }
          );

          if (!selected) {
            return;
          }

          repo = selected.repo;
        }

        // Confirm removal
        const confirm = await vscode.window.showWarningMessage(
          `Remove "${repo.name}" from Agntree?\n\nThis only removes it from the extension. Your files, git repository, and agent sessions are NOT deleted.`,
          { modal: true },
          'Remove'
        );

        if (confirm !== 'Remove') {
          return;
        }

        storageService.removeRepository(repo.id);
        vscode.window.showInformationMessage(`Removed "${repo.name}" from extension`);
        refreshTree();
      }
    )
  );

  // Move Repository Up / Down. The rows follow the stored array order, so a
  // successful move only needs a tree refresh.
  const moveRepository =
    (direction: 'up' | 'down') => (item?: WorkspaceTreeItem) => {
      if (!item || item.itemType !== 'repository') {
        return;
      }

      const repo = item.data as Repository;
      if (storageService.moveRepository(repo.id, direction)) {
        refreshTree();
        return;
      }

      vscode.window.showInformationMessage(
        direction === 'up'
          ? `"${repo.name}" is already at the top.`
          : `"${repo.name}" is already at the bottom.`
      );
    };

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.moveRepositoryUp', moveRepository('up')),
    vscode.commands.registerCommand('agntree.moveRepositoryDown', moveRepository('down'))
  );

  // Refresh Workspaces
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.refreshWorkspaces', () => {
      refreshTree();
    })
  );

  // Clone Repository from GitHub
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.cloneRepository', async () => {
      // Ask for GitHub URL
      const repoUrl = await vscode.window.showInputBox({
        prompt: 'Enter GitHub repository URL',
        placeHolder: 'https://github.com/owner/repo or owner/repo',
        validateInput: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Repository URL is required';
          }
          // Accept full URL or owner/repo format
          const trimmed = value.trim();
          if (trimmed.includes('github.com') || /^[\w-]+\/[\w.-]+$/.test(trimmed)) {
            return undefined;
          }
          return 'Enter a valid GitHub URL or owner/repo format';
        },
      });

      if (!repoUrl) {
        return;
      }

      // Normalize URL
      let normalizedUrl = repoUrl.trim();
      if (!normalizedUrl.includes('://')) {
        // Convert owner/repo to full URL
        normalizedUrl = `https://github.com/${normalizedUrl}`;
      }
      // Ensure .git suffix for cloning
      if (!normalizedUrl.endsWith('.git')) {
        normalizedUrl = `${normalizedUrl}.git`;
      }

      // Extract repo name from URL
      const repoName = path.basename(normalizedUrl, '.git');
      if (
        !repoName ||
        repoName === '.' ||
        repoName === '..' ||
        /[\\/]/.test(repoName)
      ) {
        vscode.window.showErrorMessage('Could not determine a safe folder name from that URL.');
        return;
      }

      // Ask where to clone
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Select Parent Folder',
        title: 'Select where to clone the repository',
      });

      if (!folders || folders.length === 0) {
        return;
      }

      const parentPath = folders[0].fsPath;
      const clonePath = path.join(parentPath, repoName);

      // Clone the repository
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Cloning ${repoName}...`,
            cancellable: false,
          },
          async () => {
            // Argument array: the URL is user input and must never be
            // interpreted by a shell.
            gitService.clone(normalizedUrl, clonePath);
          }
        );

        // Add to extension
        const repo = storageService.addRepository(repoName, clonePath);
        vscode.window.showInformationMessage(`Cloned and added repository: ${repo.name}`);
        refreshTree();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to clone repository: ${errorMessage}`);
      }
    })
  );
}
