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

  // Hide Repository (soft remove)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.hideRepository',
      async (item?: WorkspaceTreeItem) => {
        let repo: Repository | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as Repository;
        } else {
          const repos = storageService.getRepositories();
          if (repos.length === 0) {
            vscode.window.showInformationMessage('No repositories to hide.');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            repos.map((r) => ({
              label: r.name,
              description: r.rootPath,
              repo: r,
            })),
            { placeHolder: 'Select repository to hide' }
          );

          if (!selected) {
            return;
          }

          repo = selected.repo;
        }

        storageService.hideRepository(repo.id);
        vscode.window.showInformationMessage(
          `Hidden repository: ${repo.name}. Use "Show Hidden Repositories" to restore it.`
        );
        refreshTree();
      }
    )
  );

  // Show Hidden Repositories (to restore them)
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-workspaces.showHiddenRepositories', async () => {
      const hiddenRepos = storageService.getHiddenRepositories();

      if (hiddenRepos.length === 0) {
        vscode.window.showInformationMessage('No hidden repositories.');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        hiddenRepos.map((r) => ({
          label: r.name,
          description: r.rootPath,
          repo: r,
        })),
        {
          placeHolder: 'Select repository to restore',
          canPickMany: true,
        }
      );

      if (!selected || selected.length === 0) {
        return;
      }

      for (const item of selected) {
        storageService.unhideRepository(item.repo.id);
      }

      vscode.window.showInformationMessage(`Restored ${selected.length} repository(s).`);
      refreshTree();
    })
  );

  // Remove Repository (permanent delete)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.removeRepository',
      async (item?: WorkspaceTreeItem) => {
        let repo: Repository | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as Repository;
        } else {
          // Show quick pick to select repository (include hidden)
          const repos = storageService.getRepositories(true);
          if (repos.length === 0) {
            vscode.window.showInformationMessage('No repositories to remove.');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            repos.map((r) => ({
              label: r.name + (r.hidden ? ' (hidden)' : ''),
              description: r.rootPath,
              repo: r,
            })),
            { placeHolder: 'Select repository to permanently remove' }
          );

          if (!selected) {
            return;
          }

          repo = selected.repo;
        }

        // Confirm removal
        const confirm = await vscode.window.showWarningMessage(
          `Permanently remove "${repo.name}" from the extension?\n\nNote: This only removes it from Claude Workspaces. Your files and Claude sessions in ~/.claude/ are not affected.`,
          { modal: true },
          'Remove Permanently'
        );

        if (confirm !== 'Remove Permanently') {
          return;
        }

        storageService.removeRepository(repo.id);
        vscode.window.showInformationMessage(`Removed repository: ${repo.name}`);
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
}
