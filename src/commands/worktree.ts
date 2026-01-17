import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem } from '../providers/WorkspacesTreeProvider';
import { Repository, Worktree } from '../types';

/**
 * Register worktree-related commands
 */
export function registerWorktreeCommands(
  context: vscode.ExtensionContext,
  storageService: StorageService,
  gitService: GitService,
  refreshTree: () => void
): void {
  // Add Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.addWorktree',
      async (item?: WorkspaceTreeItem) => {
        let repo: Repository | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as Repository;
        } else {
          // Show quick pick to select repository
          const repos = storageService.getRepositories();
          if (repos.length === 0) {
            vscode.window.showErrorMessage('No repositories added. Add a repository first.');
            return;
          }

          const selected = await vscode.window.showQuickPick(
            repos.map((r) => ({
              label: r.name,
              description: r.rootPath,
              repo: r,
            })),
            { placeHolder: 'Select repository for new worktree' }
          );

          if (!selected) {
            return;
          }

          repo = selected.repo;
        }

        // Get available branches
        const branches = gitService.getBranches(repo.rootPath);

        // Ask user what type of worktree
        const worktreeType = await vscode.window.showQuickPick(
          [
            {
              label: 'Existing branch',
              description: 'Create worktree from an existing branch',
              value: 'existing',
            },
            {
              label: 'New branch',
              description: 'Create a new branch with a worktree',
              value: 'new',
            },
          ],
          { placeHolder: 'How would you like to create the worktree?' }
        );

        if (!worktreeType) {
          return;
        }

        let branchName: string;
        let isNewBranch = false;

        if (worktreeType.value === 'existing') {
          // Select existing branch
          const selectedBranch = await vscode.window.showQuickPick(
            branches.map((b) => ({ label: b })),
            { placeHolder: 'Select branch for worktree' }
          );

          if (!selectedBranch) {
            return;
          }

          branchName = selectedBranch.label;
        } else {
          // Create new branch
          const newBranchName = await vscode.window.showInputBox({
            prompt: 'Enter new branch name',
            placeHolder: 'feature/my-feature',
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return 'Branch name is required';
              }
              if (branches.includes(value)) {
                return 'Branch already exists';
              }
              // Basic git branch name validation
              if (!/^[\w\-\/\.]+$/.test(value)) {
                return 'Invalid branch name. Use only letters, numbers, hyphens, slashes, and dots.';
              }
              return undefined;
            },
          });

          if (!newBranchName) {
            return;
          }

          branchName = newBranchName;
          isNewBranch = true;
        }

        // Determine worktree path
        const parentDir = path.dirname(repo.rootPath);
        const defaultWorktreePath = path.join(parentDir, `${repo.name}-${branchName.replace(/\//g, '-')}`);

        const worktreePath = await vscode.window.showInputBox({
          prompt: 'Enter path for worktree directory',
          value: defaultWorktreePath,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Path is required';
            }
            return undefined;
          },
        });

        if (!worktreePath) {
          return;
        }

        // Create the worktree
        let success: boolean;
        if (isNewBranch) {
          success = gitService.createWorktreeWithNewBranch(repo.rootPath, branchName, worktreePath);
        } else {
          success = gitService.createWorktree(repo.rootPath, branchName, worktreePath);
        }

        if (success) {
          vscode.window.showInformationMessage(`Created worktree: ${branchName}`);
          refreshTree();
        } else {
          vscode.window.showErrorMessage(`Failed to create worktree. Check that the branch exists and path is valid.`);
        }
      }
    )
  );

  // Open in New Window
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.openInNewWindow',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const uri = vscode.Uri.file(worktree.path);

        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
      }
    )
  );

  // Switch to Workspace (manual switch when auto-switch is disabled)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.switchToWorkspace',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const worktreePath = worktree.path;
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (currentFolder !== worktreePath) {
          const folderCount = vscode.workspace.workspaceFolders?.length || 0;
          vscode.workspace.updateWorkspaceFolders(
            0,
            folderCount,
            { uri: vscode.Uri.file(worktreePath) }
          );
        }
      }
    )
  );

  // Delete Worktree (actually removes the git worktree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.deleteWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;

        // Don't allow deleting the main worktree
        if (worktree.isMain) {
          vscode.window.showErrorMessage('Cannot delete the main worktree. Use git commands directly if you need to remove the repository.');
          return;
        }

        // Check for uncommitted changes
        const hasChanges = gitService.hasUncommittedChanges(worktree.path);

        let confirmMessage = `Delete worktree "${worktree.name}"?\n\nThis will run "git worktree remove" and delete the directory at:\n${worktree.path}`;

        if (hasChanges) {
          confirmMessage += '\n\n⚠️ WARNING: This worktree has uncommitted changes that will be lost!';
        }

        const options = hasChanges ? ['Delete Anyway', 'Cancel'] : ['Delete', 'Cancel'];
        const confirm = await vscode.window.showWarningMessage(
          confirmMessage,
          { modal: true },
          ...options
        );

        if (confirm !== 'Delete' && confirm !== 'Delete Anyway') {
          return;
        }

        // Get repo root for the git command
        const repo = storageService.getRepository(worktree.repoId);
        if (!repo) {
          vscode.window.showErrorMessage('Could not find parent repository.');
          return;
        }

        // Attempt to remove the worktree
        const success = gitService.removeWorktree(repo.rootPath, worktree.path, hasChanges);

        if (success) {
          vscode.window.showInformationMessage(`Deleted worktree "${worktree.name}"`);
          refreshTree();
        } else {
          vscode.window.showErrorMessage(`Failed to delete worktree. Check the Output panel for details.`);
        }
      }
    )
  );
}
