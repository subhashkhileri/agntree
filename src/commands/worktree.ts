import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService, recommendedRebaseTarget } from '../services/GitService';
import { GitHubService } from '../services/GitHubService';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { Repository, Worktree } from '../types';
import { logOperation } from '../services/OperationLog';
import { commandRegistrar, defaultWorktreePath, promptNewBranchName, withProgress } from './common';

export interface WorktreeCommandDeps {
  storageService: StorageService;
  gitService: GitService;
  gitHubService: GitHubService;
  workspacesProvider: Pick<WorkspacesTreeProvider, 'getWorktreeForItem' | 'isGitRepo' | 'getPRUrl'>;
  /** Remove a deleted worktree's chats and clear the panels if they show it. */
  forgetWorktrees: (worktrees: Worktree[]) => void;
  switchWorkspaceFolder: (folderPath: string) => void;
  refreshTree: () => void;
}

/**
 * Worktree commands: create, delete, merge, rebase, PR checkout, and the
 * small open/copy/switch actions on a worktree row.
 */
export function registerWorktreeCommands(context: vscode.ExtensionContext, deps: WorktreeCommandDeps): void {
  const { storageService, gitService, gitHubService, workspacesProvider, refreshTree } = deps;
  const register = commandRegistrar(context);

  /** The selected repository row, or a choice among the git repositories. */
  const resolveGitRepository = async (
    item: WorkspaceTreeItem | undefined,
    placeHolder: string
  ): Promise<Repository | undefined> => {
    if (item?.itemType === 'repository') {
      return item.data as Repository;
    }
    const repos = storageService.getRepositories().filter((repo) => workspacesProvider.isGitRepo(repo));
    if (repos.length === 0) {
      vscode.window.showErrorMessage('No git repositories added. Add a repository first.');
      return undefined;
    }
    const selected = await vscode.window.showQuickPick(
      repos.map((repo) => ({ label: repo.name, description: repo.rootPath, repo })),
      { placeHolder }
    );
    return selected?.repo;
  };

  const worktreeRow = (item?: WorkspaceTreeItem): Worktree | undefined =>
    item?.itemType === 'worktree' ? (item.data as Worktree) : undefined;

  const openTerminal = (name: string, cwd: string): vscode.Terminal => {
    const terminal = vscode.window.createTerminal({ name, cwd });
    terminal.show();
    return terminal;
  };

  register('agntree.addWorktree', async (item?: WorkspaceTreeItem) => {
    const repo = await resolveGitRepository(item, 'Select repository for new worktree');
    if (!repo) {
      return;
    }
    const allBranches = gitService.getBranches(repo.rootPath);
    const checkedOut = new Set(gitService.listWorktrees(repo.rootPath, repo.id).map((w) => w.branch));
    const options = [
      { label: 'Existing branch', description: 'Create worktree from an existing branch', value: 'existing' },
      { label: 'New branch', description: 'Create a new branch with a worktree', value: 'new' },
    ];
    if (gitService.hasRemote(repo.rootPath, 'upstream')) {
      options.push({ label: 'From upstream', description: 'Fetch from upstream and create new branch', value: 'upstream' });
    }
    const kind = (await vscode.window.showQuickPick(options, { placeHolder: 'How would you like to create the worktree?' }))
      ?.value;
    if (!kind) {
      return;
    }

    let branch: string | undefined;
    let base: string | undefined;
    if (kind === 'existing') {
      const available = allBranches.filter((b) => !checkedOut.has(b));
      if (available.length === 0) {
        vscode.window.showInformationMessage(
          'All branches are already checked out in worktrees. Create a new branch instead.'
        );
        return;
      }
      branch = (
        await vscode.window.showQuickPick(
          available.map((label) => ({ label })),
          { placeHolder: 'Select branch for worktree (branches already in worktrees are hidden)' }
        )
      )?.label;
    } else {
      let bases = allBranches;
      if (kind === 'upstream') {
        await withProgress('Fetching from upstream...', () => gitService.fetchRemote(repo.rootPath, 'upstream'));
        bases = gitService.getRemoteBranches(repo.rootPath, 'upstream');
        if (bases.length === 0) {
          vscode.window.showErrorMessage('No branches found on upstream remote.');
          return;
        }
      }
      base = (
        await vscode.window.showQuickPick(
          bases.map((label) => ({ label })),
          {
            placeHolder:
              kind === 'upstream'
                ? 'Select upstream branch to base new branch on'
                : 'Select base branch to create new branch from',
          }
        )
      )?.label;
      if (base) {
        branch = await promptNewBranchName(allBranches, { prompt: `Enter new branch name (based on ${base})` });
      }
    }
    if (!branch) {
      return;
    }

    const worktreePath = defaultWorktreePath(repo, branch);
    const created = base
      ? gitService.createWorktreeWithNewBranch(repo.rootPath, branch, worktreePath, base)
      : gitService.createWorktree(repo.rootPath, branch, worktreePath);
    if (created) {
      vscode.window.showInformationMessage(`Created worktree: ${branch}`);
      refreshTree();
    } else {
      vscode.window.showErrorMessage('Failed to create worktree. Check that the branch exists and path is valid.');
    }
  });

  register('agntree.openInNewWindow', async (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktree.path), {
        forceNewWindow: true,
      });
    }
  });

  register('agntree.copyWorktreePath', async (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      await vscode.env.clipboard.writeText(worktree.path);
      vscode.window.showInformationMessage(`Copied path: ${worktree.path}`);
    }
  });

  register('agntree.openTerminalAtWorktree', (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      openTerminal(`Terminal: ${worktree.name}`, worktree.path);
    }
  });

  register('agntree.switchToWorkspace', (item?: WorkspaceTreeItem) => {
    const worktree = workspacesProvider.getWorktreeForItem(item);
    if (worktree) {
      deps.switchWorkspaceFolder(worktree.path);
    }
  });

  register('agntree.deleteWorktree', async (item?: WorkspaceTreeItem) => {
    const worktree = worktreeRow(item);
    if (!worktree) {
      return;
    }
    if (worktree.isMain) {
      vscode.window.showErrorMessage(
        'Cannot delete the main worktree. Use git commands directly if you need to remove the repository.'
      );
      return;
    }
    const repo = storageService.getRepository(worktree.repoId);
    if (!repo) {
      vscode.window.showErrorMessage('Could not find parent repository.');
      return;
    }

    const dirty = gitService.hasUncommittedChanges(worktree.path);
    const sessionCount = storageService.getChatsByWorktree(worktree.id).length;
    const lines = [
      `Delete worktree "${worktree.name}"?`,
      'Its directory will be removed from disk (this is not sent to the Trash).',
    ];
    if (sessionCount > 0) {
      lines.push(
        `Its ${sessionCount} session row(s) leave the list and their terminals close. The agents keep the conversations.`
      );
    }
    if (dirty) {
      lines.push('⚠️ WARNING: This worktree has uncommitted changes that will be lost!');
    }
    const worktreeOnly = dirty ? 'Delete Worktree Only (force)' : 'Delete Worktree Only';
    const withBranch = dirty ? 'Delete Worktree & Branch (force)' : 'Delete Worktree & Branch';
    // A detached worktree has no branch of its own to delete.
    const { branch } = worktree;
    const choice = await vscode.window.showWarningMessage(
      lines.join('\n\n'),
      { modal: true },
      ...(branch ? [worktreeOnly, withBranch] : [worktreeOnly])
    );
    if (choice !== worktreeOnly && choice !== withBranch) {
      return;
    }
    const deleteBranch = choice === withBranch;

    // Close its terminals first: an agent still running in the directory can
    // block the removal or write into it. A failed removal leaves no tombstone,
    // so the sessions import again.
    storageService.removePRWorktree(worktree.id);
    deps.forgetWorktrees([worktree]);
    if (!gitService.removeWorktree(repo.rootPath, worktree.path, dirty)) {
      logOperation(`Failed to delete worktree "${worktree.name}" at ${worktree.path}`);
      vscode.window.showErrorMessage('Failed to delete worktree. Check the Output panel for details.');
      return;
    }
    logOperation(
      `Deleted worktree "${worktree.name}" at ${worktree.path}` +
        (branch && deleteBranch ? ` and branch "${branch}"` : '')
    );
    if (!branch || !deleteBranch) {
      vscode.window.showInformationMessage(`Deleted worktree "${worktree.name}"`);
    } else if (gitService.deleteBranch(repo.rootPath, branch, true)) {
      vscode.window.showInformationMessage(`Deleted worktree and branch "${worktree.name}"`);
    } else {
      logOperation(`Failed to delete branch "${worktree.name}" after removing worktree`);
      vscode.window.showWarningMessage(
        `Worktree deleted, but failed to delete branch "${worktree.name}". It may be the current branch or have other references.`
      );
    }
    refreshTree();
  });

  register('agntree.mergeWorktree', async (item?: WorkspaceTreeItem) => {
    const target = worktreeRow(item);
    const repo = target && storageService.getRepository(target.repoId);
    if (!target || !repo) {
      return;
    }
    const sources = gitService.listWorktrees(repo.rootPath, repo.id).filter((w) => w.id !== target.id);
    if (sources.length === 0) {
      vscode.window.showInformationMessage('No other worktrees available to merge from.');
      return;
    }
    const selected = await vscode.window.showQuickPick(
      sources.map((w) => ({
        label: w.name,
        description: w.isMain ? '(main branch)' : undefined,
        detail: w.path,
      })),
      { placeHolder: `Select branch to merge into "${target.name}"` }
    );
    if (!selected) {
      return;
    }
    const source = selected.label;

    if (gitService.hasUncommittedChanges(target.path)) {
      const proceed = await vscode.window.showWarningMessage(
        `"${target.name}" has uncommitted changes. Commit or stash them before merging.`,
        'Merge Anyway',
        'Cancel'
      );
      if (proceed !== 'Merge Anyway') {
        return;
      }
    }

    const result = gitService.mergeBranch(target.path, source);
    if (result.success) {
      vscode.window.showInformationMessage(`Successfully merged "${source}" into "${target.name}"`);
      refreshTree();
    } else if (/conflict/i.test(result.error ?? '')) {
      const choice = await vscode.window.showWarningMessage(
        `Merge conflicts detected. Resolve them in "${target.name}" and commit.`,
        'Open in Terminal'
      );
      if (choice === 'Open in Terminal') {
        openTerminal(`Git: ${target.name}`, target.path).sendText('git status');
      }
    } else {
      vscode.window.showErrorMessage(`Failed to merge: ${result.error || 'Unknown error'}`);
    }
  });

  register('agntree.rebaseWorktree', async (item?: WorkspaceTreeItem) => {
    const worktree = worktreeRow(item);
    if (!worktree) {
      return;
    }

    if (gitService.isRebaseInProgress(worktree.path)) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(check) Continue', command: 'agntree.rebaseContinue' },
          { label: '$(close) Abort', command: 'agntree.rebaseAbort' },
          { label: '$(debug-step-over) Skip', command: 'agntree.rebaseSkip' },
        ],
        { placeHolder: 'A rebase is already in progress' }
      );
      if (choice) {
        void vscode.commands.executeCommand(choice.command);
      }
      return;
    }

    const remotes = gitService.listRemotes(worktree.path);
    if (remotes.length === 0) {
      vscode.window.showErrorMessage('No remotes configured for this repository.');
      return;
    }
    const fetched = await withProgress('Fetching remotes...', async () => {
      for (const remote of remotes) {
        if (!(await gitService.fetchRemote(worktree.path, remote))) {
          return false;
        }
      }
      return true;
    });
    if (!fetched) {
      vscode.window.showErrorMessage('Failed to fetch from remotes. Check your network or credentials.');
      return;
    }

    // The branch's own remote copies are not rebase targets.
    const currentBranch = gitService.getCurrentBranch(worktree.path);
    const ownCopies = new Set(remotes.map((remote) => `${remote}/${currentBranch}`));
    const branches = remotes
      .flatMap((remote) => gitService.getRemoteBranches(worktree.path, remote))
      .filter((branch) => !ownCopies.has(branch));
    if (branches.length === 0) {
      vscode.window.showErrorMessage('No remote branches found.');
      return;
    }
    const recommended = recommendedRebaseTarget(branches);
    branches.sort((a, b) => Number(b === recommended) - Number(a === recommended) || a.localeCompare(b));
    const selected = await vscode.window.showQuickPick(
      branches.map((branch) => ({
        label: branch === recommended ? `$(star) ${branch}` : branch,
        description: branch === recommended ? '(Recommended)' : undefined,
        branch,
      })),
      { placeHolder: `Select branch to rebase "${worktree.name}" onto` }
    );
    if (!selected) {
      return;
    }
    const target = selected.branch;

    if (gitService.isUpToDate(worktree.path, target)) {
      vscode.window.showInformationMessage(`"${worktree.name}" is already up to date with ${target}.`);
      return;
    }

    const conflicts = gitService.checkRebaseConflicts(worktree.path, target);
    const uncommitted =
      gitService.getStagedChanges(worktree.path).length + gitService.getUnstagedChanges(worktree.path).length;
    const details = [
      conflicts.hasConflicts
        ? `${conflicts.conflictingFiles.length} conflicting file(s): ${conflicts.conflictingFiles.join(', ')}`
        : 'No conflicts detected',
    ];
    if (uncommitted > 0) {
      details.push(`${uncommitted} uncommitted change(s) will be auto-stashed`);
    }
    const proceed = await vscode.window.showQuickPick(
      [
        { label: '$(check) Proceed with Rebase', description: details.join(' · '), proceed: true },
        { label: '$(close) Cancel', proceed: false },
      ],
      {
        placeHolder: conflicts.hasConflicts
          ? `Conflicts detected rebasing onto ${target}`
          : `Rebase "${worktree.name}" onto ${target}`,
      }
    );
    if (!proceed?.proceed) {
      return;
    }

    const result = await withProgress(`Rebasing ${worktree.name} onto ${target}...`, () =>
      gitService.rebase(worktree.path, target)
    );
    if (result.success) {
      vscode.window.showInformationMessage(`Successfully rebased "${worktree.name}" onto ${target}`);
      refreshTree();
    } else if (gitService.isRebaseInProgress(worktree.path)) {
      vscode.window.showWarningMessage(
        'Rebase paused due to conflicts. Resolve conflicts and use the rebase controls in the Changes panel.'
      );
    } else {
      vscode.window.showErrorMessage(`Rebase failed: ${result.error || 'Unknown error'}`);
    }
    void vscode.commands.executeCommand('agntree.refreshChanges');
  });

  register('agntree.openPRInBrowser', async (item?: WorkspaceTreeItem) => {
    const worktree = worktreeRow(item);
    if (!worktree) {
      return;
    }
    const url = workspacesProvider.getPRUrl(worktree);
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } else {
      vscode.window.showInformationMessage('No PR found for this branch.');
    }
  });

  register('agntree.checkoutPR', async (item?: WorkspaceTreeItem) => {
    const repo = await resolveGitRepository(item, 'Select repository to checkout PR from');
    if (!repo) {
      return;
    }
    if (!(await gitHubService.isGhAvailable())) {
      vscode.window.showErrorMessage(
        'GitHub CLI (gh) is not installed or not authenticated. Install it from https://cli.github.com'
      );
      return;
    }

    const prs = await withProgress('Fetching open PRs...', () => gitHubService.listPRs(repo.rootPath));
    const selected = await vscode.window.showQuickPick(
      [
        {
          label: '$(edit) Enter PR number or URL manually...',
          detail: prs.length === 0 ? 'No open PRs found — enter a PR number or URL' : undefined,
          pr: undefined,
        },
        ...prs.map((pr) => ({
          label: `#${pr.number} ${pr.title}`,
          description: pr.headRefName ?? '',
          detail: pr.isDraft ? 'Draft' : undefined,
          pr,
        })),
      ],
      { placeHolder: 'Select a PR to checkout', matchOnDescription: true }
    );
    if (!selected) {
      return;
    }

    let pr = selected.pr;
    if (!pr) {
      const input = await vscode.window.showInputBox({
        prompt: 'Enter PR number or GitHub PR URL',
        placeHolder: '123 or https://github.com/owner/repo/pull/123',
        validateInput: (value) => (value.trim() ? undefined : 'PR number or URL is required'),
      });
      if (!input) {
        return;
      }
      pr = (await withProgress('Fetching PR details...', () => gitHubService.fetchPRDetails(repo.rootPath, input.trim()))) ?? undefined;
      if (!pr) {
        vscode.window.showErrorMessage(`Could not find PR: ${input}`);
        return;
      }
    }
    if (!pr.headRefName) {
      vscode.window.showErrorMessage('Could not determine branch name for this PR.');
      return;
    }

    // A pr-<number> branch cannot collide with the contributor's branch name.
    const localBranch = `pr-${pr.number}`;
    if (gitService.listWorktrees(repo.rootPath, repo.id).some((w) => w.branch === localBranch)) {
      vscode.window.showInformationMessage(`PR #${pr.number} already has a worktree.`);
      return;
    }

    const { number, headRefName } = pr;
    const created = await withProgress(`Checking out PR #${number}...`, async () =>
      (await gitHubService.fetchPRBranch(repo.rootPath, number, localBranch)) &&
      gitService.createWorktree(repo.rootPath, localBranch, defaultWorktreePath(repo, headRefName))
    );
    if (!created) {
      vscode.window.showErrorMessage(
        `Failed to checkout PR #${number}. The PR may not exist or fetching from the remote failed.`
      );
      return;
    }
    const worktree = gitService.listWorktrees(repo.rootPath, repo.id).find((w) => w.branch === localBranch);
    if (worktree) {
      storageService.setPRWorktree(worktree.id, number);
    }
    vscode.window.showInformationMessage(`Checked out PR #${number}: ${headRefName}`);
    refreshTree();
  });
}
