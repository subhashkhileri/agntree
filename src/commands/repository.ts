import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { Repository } from '../types';

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
    vscode.commands.registerCommand('claude-workspaces.addRepository', async () => {
      const folders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Add Repository',
        title: 'Select a Git Repository',
      });

      if (!folders || folders.length === 0) {
        return;
      }

      const folderPath = folders[0].fsPath;

      // Check if it's a git repository
      if (!gitService.isGitRepository(folderPath)) {
        vscode.window.showErrorMessage(
          'The selected folder is not a git repository. Please select a folder containing a .git directory.'
        );
        return;
      }

      // Get the repo root (in case they selected a subdirectory)
      const repoRoot = gitService.getRepoRoot(folderPath);
      if (!repoRoot) {
        vscode.window.showErrorMessage('Could not determine the repository root.');
        return;
      }

      // Add the repository
      const name = path.basename(repoRoot);
      const repo = storageService.addRepository(name, repoRoot);

      vscode.window.showInformationMessage(`Added repository: ${repo.name}`);
      refreshTree();
    })
  );

  // Remove Repository (from extension only - does not delete files)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.removeRepository',
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
          `Remove "${repo.name}" from Claude Workspaces?\n\nThis only removes it from the extension. Your files, git repository, and Claude sessions are NOT deleted.`,
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

  // Refresh Workspaces
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-workspaces.refreshWorkspaces', () => {
      refreshTree();
    })
  );

  // Clone Repository from GitHub
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-workspaces.cloneRepository', async () => {
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
            const { execSync } = require('child_process');
            execSync(`git clone "${normalizedUrl}" "${clonePath}"`, {
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            });
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
