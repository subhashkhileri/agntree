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
  refreshTree: () => void,
  getPRUrl: (worktreeId: string) => string | undefined
): void {
  // Add Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.addWorktree',
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
        const allBranches = gitService.getBranches(repo.rootPath);

        // Get branches already checked out in worktrees
        const existingWorktrees = gitService.listWorktrees(repo.rootPath, repo.id);
        const checkedOutBranches = new Set(existingWorktrees.map(w => w.name));

        // Filter out branches already in worktrees (for existing branch option)
        const availableBranches = allBranches.filter(b => !checkedOutBranches.has(b));

        // Check if upstream remote exists
        const hasUpstream = gitService.hasRemote(repo.rootPath, 'upstream');

        // Build options dynamically
        const worktreeOptions: { label: string; description: string; value: string }[] = [
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
        ];

        if (hasUpstream) {
          worktreeOptions.push({
            label: 'From upstream',
            description: 'Fetch from upstream and create new branch',
            value: 'upstream',
          });
        }

        // Ask user what type of worktree
        const worktreeType = await vscode.window.showQuickPick(
          worktreeOptions,
          { placeHolder: 'How would you like to create the worktree?' }
        );

        if (!worktreeType) {
          return;
        }

        let branchName: string;
        let isNewBranch = false;
        let baseBranch: string | undefined;

        if (worktreeType.value === 'existing') {
          // Check if there are available branches
          if (availableBranches.length === 0) {
            vscode.window.showInformationMessage('All branches are already checked out in worktrees. Create a new branch instead.');
            return;
          }

          // Select existing branch (only show branches not already in worktrees)
          const selectedBranch = await vscode.window.showQuickPick(
            availableBranches.map((b) => ({ label: b })),
            { placeHolder: 'Select branch for worktree (branches already in worktrees are hidden)' }
          );

          if (!selectedBranch) {
            return;
          }

          branchName = selectedBranch.label;
        } else if (worktreeType.value === 'new') {
          // Select base branch first (can base off any branch, including checked out ones)
          const selectedBaseBranch = await vscode.window.showQuickPick(
            allBranches.map((b) => ({ label: b })),
            { placeHolder: 'Select base branch to create new branch from' }
          );

          if (!selectedBaseBranch) {
            return;
          }

          baseBranch = selectedBaseBranch.label;

          // Create new branch
          const newBranchName = await vscode.window.showInputBox({
            prompt: `Enter new branch name (based on ${baseBranch})`,
            placeHolder: 'feature/my-feature',
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return 'Branch name is required';
              }
              if (allBranches.includes(value)) {
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
        } else if (worktreeType.value === 'upstream') {
          // Fetch from upstream with progress
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Fetching from upstream...',
              cancellable: false,
            },
            async () => {
              gitService.fetchRemote(repo.rootPath, 'upstream');
            }
          );

          // Get upstream branches
          const upstreamBranches = gitService.getRemoteBranches(repo.rootPath, 'upstream');

          if (upstreamBranches.length === 0) {
            vscode.window.showErrorMessage('No branches found on upstream remote.');
            return;
          }

          // Let user select base branch from upstream
          const selectedUpstreamBranch = await vscode.window.showQuickPick(
            upstreamBranches.map(b => ({ label: b })),
            { placeHolder: 'Select upstream branch to base new branch on' }
          );

          if (!selectedUpstreamBranch) {
            return;
          }

          baseBranch = selectedUpstreamBranch.label;

          // Ask for new branch name
          const newBranchName = await vscode.window.showInputBox({
            prompt: `Enter new branch name (based on ${baseBranch})`,
            placeHolder: 'feature/my-feature',
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return 'Branch name is required';
              }
              if (allBranches.includes(value)) {
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
        } else {
          return;
        }

        // Determine worktree path (using dedicated worktrees folder)
        const parentDir = path.dirname(repo.rootPath);
        const worktreesDir = path.join(parentDir, `${repo.name}-worktrees`);
        const defaultWorktreePath = path.join(worktreesDir, branchName.replace(/\//g, '-'));

        // Use the default path directly for both existing and new branches
        const worktreePath = defaultWorktreePath;

        // Create the worktree
        let success: boolean;
        if (isNewBranch) {
          success = gitService.createWorktreeWithNewBranch(repo.rootPath, branchName, worktreePath, baseBranch);
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
      'agntree.openInNewWindow',
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

  // Copy Worktree Path
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.copyWorktreePath',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        await vscode.env.clipboard.writeText(worktree.path);
        vscode.window.showInformationMessage(`Copied path: ${worktree.path}`);
      }
    )
  );

  // Open Terminal at Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openTerminalAtWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const terminal = vscode.window.createTerminal({
          name: `Terminal: ${worktree.name}`,
          cwd: worktree.path,
        });
        terminal.show();
      }
    )
  );

  // Switch to Workspace (manual switch when auto-switch is disabled)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.switchToWorkspace',
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
      'agntree.deleteWorktree',
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

        let confirmMessage = `Delete worktree "${worktree.name}"?`;

        if (hasChanges) {
          confirmMessage += '\n\n⚠️ WARNING: This worktree has uncommitted changes that will be lost!';
        }

        // Show options: delete worktree only, or delete worktree and branch
        const deleteWorktreeOnly = hasChanges ? 'Delete Worktree Only (force)' : 'Delete Worktree Only';
        const deleteWithBranch = hasChanges ? 'Delete Worktree & Branch (force)' : 'Delete Worktree & Branch';

        const confirm = await vscode.window.showWarningMessage(
          confirmMessage,
          { modal: true },
          deleteWorktreeOnly,
          deleteWithBranch,
          'Cancel'
        );

        if (confirm === 'Cancel' || !confirm) {
          return;
        }

        const deleteBranch = confirm === deleteWithBranch;

        // Get repo root for the git command
        const repo = storageService.getRepository(worktree.repoId);
        if (!repo) {
          vscode.window.showErrorMessage('Could not find parent repository.');
          return;
        }

        // Attempt to remove the worktree
        const success = gitService.removeWorktree(repo.rootPath, worktree.path, hasChanges);

        if (success) {
          // If user chose to delete the branch too
          if (deleteBranch) {
            const branchDeleted = gitService.deleteBranch(repo.rootPath, worktree.name, true);
            if (branchDeleted) {
              vscode.window.showInformationMessage(`Deleted worktree and branch "${worktree.name}"`);
            } else {
              vscode.window.showWarningMessage(`Worktree deleted, but failed to delete branch "${worktree.name}". It may be the current branch or have other references.`);
            }
          } else {
            vscode.window.showInformationMessage(`Deleted worktree "${worktree.name}"`);
          }
          refreshTree();
        } else {
          vscode.window.showErrorMessage(`Failed to delete worktree. Check the Output panel for details.`);
        }
      }
    )
  );

  // Merge Branch Into This Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.mergeWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const targetWorktree = item.data as Worktree;

        // Get the repository to find all worktrees/branches
        const repo = storageService.getRepository(targetWorktree.repoId);
        if (!repo) {
          vscode.window.showErrorMessage('Could not find repository.');
          return;
        }

        // Get all worktrees in this repository
        const allWorktrees = gitService.listWorktrees(repo.rootPath, repo.id);

        // Filter out the target worktree (can't merge into itself)
        const sourceWorktrees = allWorktrees.filter(w => w.id !== targetWorktree.id);

        if (sourceWorktrees.length === 0) {
          vscode.window.showInformationMessage('No other worktrees available to merge from.');
          return;
        }

        // Show picker for source branch
        const sourceItems = sourceWorktrees.map(w => ({
          label: w.name,
          description: w.isMain ? '(main branch)' : undefined,
          detail: w.path,
          worktree: w,
        }));

        const selected = await vscode.window.showQuickPick(sourceItems, {
          placeHolder: `Select branch to merge into "${targetWorktree.name}"`,
        });

        if (!selected) {
          return;
        }

        const sourceBranch = selected.worktree.name;

        // Check for uncommitted changes in target worktree
        if (gitService.hasUncommittedChanges(targetWorktree.path)) {
          const proceed = await vscode.window.showWarningMessage(
            `"${targetWorktree.name}" has uncommitted changes. Commit or stash them before merging.`,
            'Merge Anyway',
            'Cancel'
          );
          if (proceed !== 'Merge Anyway') {
            return;
          }
        }

        // Perform the merge
        const result = gitService.mergeBranch(targetWorktree.path, sourceBranch);

        if (result.success) {
          vscode.window.showInformationMessage(
            `Successfully merged "${sourceBranch}" into "${targetWorktree.name}"`
          );
          refreshTree();
        } else {
          // Check if it's a merge conflict
          if (result.error?.includes('CONFLICT') || result.error?.includes('conflict')) {
            vscode.window.showWarningMessage(
              `Merge conflicts detected. Resolve them in "${targetWorktree.name}" and commit.`,
              'Open in Terminal'
            ).then(choice => {
              if (choice === 'Open in Terminal') {
                const terminal = vscode.window.createTerminal({
                  name: `Git: ${targetWorktree.name}`,
                  cwd: targetWorktree.path,
                });
                terminal.show();
                terminal.sendText('git status');
              }
            });
          } else {
            vscode.window.showErrorMessage(
              `Failed to merge: ${result.error || 'Unknown error'}`
            );
          }
        }
      }
    )
  );

  // Open PR in Browser
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openPRInBrowser',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
        const prUrl = getPRUrl(worktree.id);
        if (!prUrl) {
          vscode.window.showInformationMessage('No PR found for this branch.');
          return;
        }

        await vscode.env.openExternal(vscode.Uri.parse(prUrl));
      }
    )
  );
}
