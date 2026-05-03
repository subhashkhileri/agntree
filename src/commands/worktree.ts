import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { GitHubService } from '../services/GitHubService';
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

  // Rebase onto Upstream
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.rebaseWorktree',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;

        if (gitService.isRebaseInProgress(worktree.path)) {
          const choice = await vscode.window.showQuickPick(
            [
              { label: '$(check) Continue', value: 'continue' as const },
              { label: '$(close) Abort', value: 'abort' as const },
              { label: '$(debug-step-over) Skip', value: 'skip' as const },
            ],
            { placeHolder: 'A rebase is already in progress' }
          );
          if (!choice) {
            return;
          }
          if (choice.value === 'continue') {
            vscode.commands.executeCommand('agntree.rebaseContinue');
          } else if (choice.value === 'abort') {
            vscode.commands.executeCommand('agntree.rebaseAbort');
          } else {
            vscode.commands.executeCommand('agntree.rebaseSkip');
          }
          return;
        }

        // Fetch all remotes and collect branches
        const remotes = gitService.listRemotes(worktree.path);
        if (remotes.length === 0) {
          vscode.window.showErrorMessage('No remotes configured for this repository.');
          return;
        }

        const fetchSuccess = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Fetching remotes...',
            cancellable: false,
          },
          async () => {
            for (const remote of remotes) {
              if (!gitService.fetchRemote(worktree.path, remote)) {
                return false;
              }
            }
            return true;
          }
        );

        if (!fetchSuccess) {
          vscode.window.showErrorMessage('Failed to fetch from remotes. Check your network or credentials.');
          return;
        }

        // Collect all remote branches
        const allBranches: string[] = [];
        for (const remote of remotes) {
          allBranches.push(...gitService.getRemoteBranches(worktree.path, remote));
        }

        if (allBranches.length === 0) {
          vscode.window.showErrorMessage('No remote branches found.');
          return;
        }

        // Detect recommended branch (upstream/main > upstream/master > origin/main > origin/master)
        const recommended = gitService.getRebaseRemote(worktree.path);
        const currentBranch = gitService.getCurrentBranch(worktree.path);

        // Build QuickPick items with recommended at top
        const branchItems = allBranches
          .filter(b => b !== `${currentBranch}`) // exclude current
          .map(b => ({
            label: b === recommended?.branch ? `$(star) ${b}` : b,
            description: b === recommended?.branch ? '(Recommended)' : undefined,
            branch: b,
          }));

        // Sort: recommended first, then alphabetically
        branchItems.sort((a, b) => {
          if (a.branch === recommended?.branch) return -1;
          if (b.branch === recommended?.branch) return 1;
          return a.branch.localeCompare(b.branch);
        });

        const selectedBranch = await vscode.window.showQuickPick(branchItems, {
          placeHolder: `Select branch to rebase "${worktree.name}" onto`,
        });

        if (!selectedBranch) {
          return;
        }

        const targetBranch = selectedBranch.branch;

        if (gitService.isUpToDate(worktree.path, targetBranch)) {
          vscode.window.showInformationMessage(
            `"${worktree.name}" is already up to date with ${targetBranch}.`
          );
          return;
        }

        const conflictCheck = gitService.checkRebaseConflicts(worktree.path, targetBranch);
        const stagedCount = gitService.getStagedChanges(worktree.path).length;
        const unstagedCount = gitService.getUnstagedChanges(worktree.path).length;

        const details: string[] = [];
        if (conflictCheck.hasConflicts) {
          details.push(`${conflictCheck.conflictingFiles.length} conflicting file(s): ${conflictCheck.conflictingFiles.join(', ')}`);
        } else {
          details.push('No conflicts detected');
        }
        if (stagedCount + unstagedCount > 0) {
          details.push(`${stagedCount + unstagedCount} uncommitted change(s) will be auto-stashed`);
        }

        const proceed = await vscode.window.showQuickPick(
          [
            {
              label: '$(check) Proceed with Rebase',
              description: details.join(' · '),
              value: 'proceed' as const,
            },
            { label: '$(close) Cancel', value: 'cancel' as const },
          ],
          {
            placeHolder: conflictCheck.hasConflicts
              ? `Conflicts detected rebasing onto ${targetBranch}`
              : `Rebase "${worktree.name}" onto ${targetBranch}`,
          }
        );

        if (!proceed || proceed.value !== 'proceed') {
          return;
        }

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Rebasing ${worktree.name} onto ${targetBranch}...`,
            cancellable: false,
          },
          async () => gitService.rebase(worktree.path, targetBranch)
        );

        if (result.success) {
          vscode.window.showInformationMessage(
            `Successfully rebased "${worktree.name}" onto ${targetBranch}`
          );
          refreshTree();
        } else {
          if (gitService.isRebaseInProgress(worktree.path)) {
            vscode.window.showWarningMessage(
              'Rebase paused due to conflicts. Resolve conflicts and use the rebase controls in the Changes panel.'
            );
          } else {
            vscode.window.showErrorMessage(
              `Rebase failed: ${result.error || 'Unknown error'}`
            );
          }
        }

        vscode.commands.executeCommand('agntree.refreshChanges');
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

  // Checkout PR into a worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.checkoutPR',
      async (item?: WorkspaceTreeItem) => {
        let repo: Repository | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as Repository;
        } else {
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
            { placeHolder: 'Select repository to checkout PR from' }
          );

          if (!selected) {
            return;
          }

          repo = selected.repo;
        }

        const githubService = new GitHubService();

        if (!(await githubService.isGhAvailable())) {
          vscode.window.showErrorMessage('GitHub CLI (gh) is not installed or not authenticated. Install it from https://cli.github.com');
          return;
        }

        // Fetch open PRs with progress
        const prs = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Fetching open PRs...',
            cancellable: false,
          },
          () => githubService.listPRs(repo.rootPath)
        );

        // Build QuickPick items
        const manualEntry = {
          label: '$(edit) Enter PR number or URL manually...',
          description: '',
          detail: '',
          prNumber: -1,
          branchName: '',
        };

        const prItems = prs.map((pr) => ({
          label: `#${pr.number} ${pr.title}`,
          description: pr.headRefName || '',
          detail: pr.isDraft ? 'Draft' : '',
          prNumber: pr.number,
          branchName: pr.headRefName || '',
        }));

        const items = [manualEntry, ...prItems];

        if (prItems.length === 0) {
          items[0].detail = 'No open PRs found — enter a PR number or URL';
        }

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a PR to checkout',
          matchOnDescription: true,
        });

        if (!selected) {
          return;
        }

        let prNumber: number;
        let branchName: string;

        if (selected.prNumber === -1) {
          // Manual entry
          const input = await vscode.window.showInputBox({
            prompt: 'Enter PR number or GitHub PR URL',
            placeHolder: '123 or https://github.com/owner/repo/pull/123',
            validateInput: (value) => {
              if (!value || value.trim().length === 0) {
                return 'PR number or URL is required';
              }
              return undefined;
            },
          });

          if (!input) {
            return;
          }

          const prDetails = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Fetching PR details...',
              cancellable: false,
            },
            () => githubService.fetchPRDetails(repo.rootPath, input.trim())
          );

          if (!prDetails) {
            vscode.window.showErrorMessage(`Could not find PR: ${input}`);
            return;
          }

          if (!prDetails.headRefName) {
            vscode.window.showErrorMessage('Could not determine branch name for this PR.');
            return;
          }

          prNumber = prDetails.number;
          branchName = prDetails.headRefName;
        } else {
          prNumber = selected.prNumber;
          branchName = selected.branchName;
        }

        // Use pr-<number> as the local branch name to avoid collisions
        const localBranch = `pr-${prNumber}`;

        // Check if this PR already has a worktree
        const existingWorktrees = gitService.listWorktrees(repo.rootPath, repo.id);
        const existing = existingWorktrees.find(w => w.name === localBranch);

        if (existing) {
          vscode.window.showInformationMessage(`PR #${prNumber} already has a worktree.`);
          return;
        }

        // Fetch the PR and create worktree with progress
        const success = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Checking out PR #${prNumber}...`,
            cancellable: false,
          },
          async () => {
            const fetched = gitService.fetchPR(repo.rootPath, prNumber, localBranch);
            if (!fetched) {
              return false;
            }

            const parentDir = path.dirname(repo.rootPath);
            const worktreesDir = path.join(parentDir, `${repo.name}-worktrees`);
            const worktreePath = path.join(worktreesDir, branchName.replace(/\//g, '-'));

            return gitService.createWorktree(repo.rootPath, localBranch, worktreePath);
          }
        );

        if (success) {
          // Store PR association for the new worktree
          const worktrees = gitService.listWorktrees(repo.rootPath, repo.id);
          const newWorktree = worktrees.find(w => w.name === localBranch);
          if (newWorktree) {
            storageService.setPRWorktree(newWorktree.id, prNumber);
          }

          vscode.window.showInformationMessage(`Checked out PR #${prNumber}: ${branchName}`);
          refreshTree();
        } else {
          vscode.window.showErrorMessage(`Failed to checkout PR #${prNumber}. The PR may not exist or fetching from the remote failed.`);
        }
      }
    )
  );
}
