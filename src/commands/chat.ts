import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { ClaudeSessionService } from '../services/ClaudeSessionService';
import { SessionWatcher } from '../services/SessionWatcher';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { ChangesTreeProvider, ChangeTreeItem, ChangeSectionItem } from '../providers/ChangesTreeProvider';
import { ChatSession, Worktree } from '../types';

/**
 * Register chat-related commands
 */
export function registerChatCommands(
  context: vscode.ExtensionContext,
  storageService: StorageService,
  gitService: GitService,
  terminalManager: TerminalManager,
  workspacesProvider: WorkspacesTreeProvider,
  changesProvider: ChangesTreeProvider,
  sessionWatcher: SessionWatcher,
  refreshTree: () => void
): void {
  // New Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.newChat',
      async (item?: WorkspaceTreeItem) => {
        let worktree: Worktree | undefined;

        if (item && item.itemType === 'worktree') {
          worktree = item.data as Worktree;
        } else {
          // Need to show picker - gather all worktrees from all repos
          const repos = storageService.getRepositories();
          const allWorktrees: { label: string; description: string; worktree: Worktree }[] = [];

          for (const repo of repos) {
            const worktrees = gitService.listWorktrees(repo.rootPath, repo.id);
            for (const wt of worktrees) {
              allWorktrees.push({
                label: `${repo.name} / ${wt.name}`,
                description: wt.path,
                worktree: wt,
              });
            }
          }

          if (allWorktrees.length === 0) {
            vscode.window.showErrorMessage('No worktrees available. Add a repository first.');
            return;
          }

          const selected = await vscode.window.showQuickPick(allWorktrees, {
            placeHolder: 'Select worktree for new session',
          });

          if (!selected) {
            return;
          }

          worktree = selected.worktree;
        }

        // Get current commit for change tracking
        const baseCommit = gitService.getCurrentCommit(worktree.path);

        // Create the chat immediately with a temporary name
        // The name will be auto-updated when a summary or first prompt is available
        const chat = storageService.createChat(worktree.id, 'New Session', baseCommit);

        // Register for session detection and auto-naming
        sessionWatcher.registerPendingChat(chat.id, worktree);

        // Open in terminal
        terminalManager.openChat(chat, worktree);

        // Update changes view
        changesProvider.setActiveChat(chat.id, worktree);

        refreshTree();
      }
    )
  );

  // Open Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.openChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;
        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);

        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this session.');
          return;
        }

        // Open or focus the terminal
        terminalManager.openChat(chat, worktree);

        // Update changes view
        changesProvider.setActiveChat(chat.id, worktree);

        // Update last accessed
        storageService.touchChat(chat.id);

        refreshTree();
      }
    )
  );

  // Rename Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.renameChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        const newName = await vscode.window.showInputBox({
          prompt: 'Enter new name for this session',
          value: chat.name,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Session name is required';
            }
            return undefined;
          },
        });

        if (!newName || newName === chat.name) {
          return;
        }

        storageService.renameChat(chat.id, newName);
        refreshTree();
      }
    )
  );

  // Remove Chat from list (does not delete Claude session files)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.deleteChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        const confirm = await vscode.window.showWarningMessage(
          `Remove "${chat.name}" from the list?\n\nThe Claude session in ~/.claude/ is preserved and can be re-imported later.`,
          { modal: true },
          'Remove'
        );

        if (confirm !== 'Remove') {
          return;
        }

        // Close terminal if active
        terminalManager.closeChat(chat.id);

        // Remove from extension's storage (Claude session files are preserved)
        storageService.deleteChat(chat.id);

        // Clear changes view if this was the active chat
        if (storageService.getActiveChatId() === chat.id) {
          changesProvider.setActiveChat(undefined);
        }

        refreshTree();
      }
    )
  );

  // Refresh Changes
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-workspaces.refreshChanges', () => {
      changesProvider.refresh();
    })
  );

  // Track currently open diff for single-file behavior
  let currentDiffPath: string | null = null;

  // Helper to close any diff/file we opened from Changes panel
  async function closeCurrentDiff(): Promise<void> {
    if (!currentDiffPath) return;

    // Find and close the tab showing the current diff path
    for (const tabGroup of vscode.window.tabGroups.all) {
      for (const tab of tabGroup.tabs) {
        let shouldClose = false;

        // Check if it's a diff tab (modified files)
        if (tab.input instanceof vscode.TabInputTextDiff) {
          const diffInput = tab.input as vscode.TabInputTextDiff;
          if (diffInput.modified.fsPath === currentDiffPath) {
            shouldClose = true;
          }
        }
        // Check if it's a regular text tab (added files)
        else if (tab.input instanceof vscode.TabInputText) {
          const textInput = tab.input as vscode.TabInputText;
          if (textInput.uri.fsPath === currentDiffPath) {
            shouldClose = true;
          }
        }

        if (shouldClose) {
          try {
            await vscode.window.tabGroups.close(tab);
          } catch {
            // Tab might already be closed
          }
          return;
        }
      }
    }
  }

  // Helper to create git URI for different refs
  const createGitUri = (filePath: string, ref: string): vscode.Uri => {
    return vscode.Uri.from({
      scheme: 'git',
      path: filePath,
      query: JSON.stringify({ path: filePath, ref: ref }),
    });
  };

  // Open Diff
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.openDiff',
      async (item?: ChangeTreeItem) => {
        if (!item || !(item instanceof ChangeTreeItem)) {
          return;
        }

        const path = await import('path');
        const fullPath = `${item.worktreePath}/${item.change.path}`;
        const fileName = path.basename(item.change.path);
        const fileUri = vscode.Uri.file(fullPath);

        // Toggle: if same file is clicked, close it
        if (currentDiffPath === fullPath) {
          await closeCurrentDiff();
          currentDiffPath = null;
          return;
        }

        // Close any previously opened diff before opening new one
        await closeCurrentDiff();
        currentDiffPath = fullPath;

        // Force inline diff mode (up/down view instead of side-by-side)
        const config = vscode.workspace.getConfiguration('diffEditor');
        await config.update('renderSideBySide', false, vscode.ConfigurationTarget.Global);

        // Ensure the repository is opened in VS Code's Git extension
        // This allows the git: scheme to work for repos outside the workspace
        try {
          await vscode.commands.executeCommand('git.openRepository', item.worktreePath);
        } catch {
          // Ignore if git extension is not available
        }

        // Focus the second editor group first
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');

        // For added files (new/untracked), just open the file
        if (item.change.status === 'added') {
          await vscode.window.showTextDocument(fileUri, {
            viewColumn: vscode.ViewColumn.Two,
            preview: true,
            preserveFocus: false,
          });
          // Lock the editor group to prevent other files from taking over
          await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
          return;
        }

        try {
          if (item.isStaged) {
            // Check if file exists in HEAD (for newly added staged files, it won't)
            const { execSync } = await import('child_process');
            let existsInHead = true;
            try {
              execSync(`git cat-file -e HEAD:"${item.change.path}"`, {
                cwd: item.worktreePath,
                stdio: ['pipe', 'pipe', 'pipe'],
              });
            } catch {
              existsInHead = false;
            }

            if (!existsInHead) {
              // New file staged - just show the staged content from index
              const indexUri = createGitUri(fullPath, '~');
              await vscode.window.showTextDocument(indexUri, {
                viewColumn: vscode.ViewColumn.Two,
                preview: true,
                preserveFocus: false,
              });
              await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
              return;
            } else {
              // Staged diff: show index vs HEAD
              // Left = HEAD (original), Right = Index (staged changes)
              const headUri = createGitUri(fullPath, 'HEAD');
              const indexUri = createGitUri(fullPath, '~');
              await vscode.commands.executeCommand(
                'vscode.diff',
                headUri,
                indexUri,
                `${fileName} (Staged)`,
                { viewColumn: vscode.ViewColumn.Two, preview: true }
              );
            }
          } else {
            // Unstaged diff: show working tree vs index/HEAD
            // Left = Index or HEAD, Right = Working tree
            const baseUri = createGitUri(fullPath, '~');
            await vscode.commands.executeCommand(
              'vscode.diff',
              baseUri,
              fileUri,
              `${fileName}`,
              { viewColumn: vscode.ViewColumn.Two, preview: true }
            );
          }
          // Lock the editor group to prevent other files from taking over
          await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        } catch {
          // Fallback: use git.openChange or just open the file
          try {
            await vscode.commands.executeCommand('git.openChange', fileUri);
          } catch {
            await vscode.window.showTextDocument(fileUri, {
              viewColumn: vscode.ViewColumn.Two,
              preview: true,
            });
          }
        }
      }
    )
  );

  // Fork Chat (same worktree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.forkChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        // Must have a session ID to fork
        if (!chat.claudeSessionId) {
          vscode.window.showErrorMessage('Cannot fork a session that has not been started yet. Start the session first.');
          return;
        }

        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this session.');
          return;
        }

        // Create new chat with unique fork name (short hash suffix)
        const shortHash = Math.random().toString(36).substring(2, 6);
        const forkName = `Fork of ${chat.name} (${shortHash})`;
        const baseCommit = gitService.getCurrentCommit(worktree.path);
        const forkedChat = storageService.createChat(worktree.id, forkName, baseCommit);

        // Register for session detection BEFORE opening terminal
        // (the forked session will have a new ID that we need to capture)
        sessionWatcher.registerPendingChat(forkedChat.id, worktree);

        // Open in terminal with fork flag
        terminalManager.openChat(forkedChat, worktree, chat.claudeSessionId);

        // Update changes view
        changesProvider.setActiveChat(forkedChat.id, worktree);

        vscode.window.showInformationMessage(`Forked session "${chat.name}"`);
        refreshTree();
      }
    )
  );

  // Fork Chat with Changes (creates new worktree and copies changes)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.forkChatWithChanges',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        // Must have a session ID to fork
        if (!chat.claudeSessionId) {
          vscode.window.showErrorMessage('Cannot fork a session that has not been started yet. Start the session first.');
          return;
        }

        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this session.');
          return;
        }

        const repo = storageService.getRepository(worktree.repoId);
        if (!repo) {
          vscode.window.showErrorMessage('Could not find repository for this worktree.');
          return;
        }

        // Get new branch name from user
        const existingBranches = gitService.getBranches(repo.rootPath);
        const suggestedBranchName = `${worktree.name}-fork`;

        const newBranchName = await vscode.window.showInputBox({
          prompt: 'Enter branch name for the new worktree',
          value: suggestedBranchName,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Branch name is required';
            }
            if (existingBranches.includes(value)) {
              return 'Branch already exists';
            }
            if (!/^[\w\-\/\.]+$/.test(value)) {
              return 'Invalid branch name. Use only letters, numbers, hyphens, slashes, and dots.';
            }
            return undefined;
          },
        });

        if (!newBranchName) {
          return;
        }

        // Determine worktree path
        const path = await import('path');
        const parentDir = path.dirname(repo.rootPath);
        const defaultWorktreePath = path.join(parentDir, `${repo.name}-${newBranchName.replace(/\//g, '-')}`);

        const worktreePath = await vscode.window.showInputBox({
          prompt: 'Enter path for the new worktree directory',
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

        // Create the new worktree from current HEAD
        const currentCommit = gitService.getCurrentCommit(worktree.path);
        const success = gitService.createWorktreeWithNewBranch(
          repo.rootPath,
          newBranchName,
          worktreePath,
          currentCommit || 'HEAD'
        );

        if (!success) {
          vscode.window.showErrorMessage('Failed to create worktree.');
          return;
        }

        // Copy uncommitted changes to the new worktree
        const hasChanges = gitService.hasUncommittedChanges(worktree.path);
        if (hasChanges) {
          const copied = gitService.copyUncommittedChanges(worktree.path, worktreePath);
          if (!copied) {
            vscode.window.showWarningMessage('Worktree created but some changes may not have been copied.');
          }
        }

        // Refresh to get the new worktree
        refreshTree();

        // Find the new worktree
        const newWorktrees = gitService.listWorktrees(repo.rootPath, repo.id);
        const newWorktree = newWorktrees.find(w => w.path === worktreePath);

        if (!newWorktree) {
          vscode.window.showErrorMessage('Worktree created but could not find it in the list.');
          return;
        }

        // Copy the session file to the new worktree's project folder
        // This is required because Claude Code stores sessions per-directory
        const sessionService = new ClaudeSessionService();
        const sessionCopied = sessionService.copySessionToWorktree(
          chat.claudeSessionId,
          worktree.path,
          worktreePath
        );

        if (!sessionCopied) {
          vscode.window.showWarningMessage('Worktree created but session file could not be copied. The fork may not have conversation history.');
        }

        // Create forked chat in the new worktree with the same session ID
        // (since we copied the session files, we can just resume the same session)
        const shortHash = Math.random().toString(36).substring(2, 6);
        const forkName = `Fork of ${chat.name} (${shortHash})`;
        const forkedChat = storageService.createChat(newWorktree.id, forkName, currentCommit);
        forkedChat.claudeSessionId = chat.claudeSessionId;
        storageService.updateChat(forkedChat.id, { claudeSessionId: chat.claudeSessionId });

        // Open in terminal - just resume since session files were copied
        terminalManager.openChat(forkedChat, newWorktree);

        // Update changes view
        changesProvider.setActiveChat(forkedChat.id, newWorktree);

        vscode.window.showInformationMessage(`Forked session to new worktree "${newBranchName}"`);
        refreshTree();
      }
    )
  );

  // Import Existing Sessions
  const claudeSessionService = new ClaudeSessionService();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.importSessions',
      async (item?: WorkspaceTreeItem) => {
        let worktree: Worktree | undefined;

        if (item && item.itemType === 'worktree') {
          worktree = item.data as Worktree;
        } else {
          // Show picker for worktree
          const repos = storageService.getRepositories();
          const allWorktrees: { label: string; description: string; worktree: Worktree }[] = [];

          for (const repo of repos) {
            const worktrees = gitService.listWorktrees(repo.rootPath, repo.id);
            for (const wt of worktrees) {
              allWorktrees.push({
                label: `${repo.name} / ${wt.name}`,
                description: wt.path,
                worktree: wt,
              });
            }
          }

          if (allWorktrees.length === 0) {
            vscode.window.showErrorMessage('No worktrees available. Add a repository first.');
            return;
          }

          const selected = await vscode.window.showQuickPick(allWorktrees, {
            placeHolder: 'Select worktree to import sessions for',
          });

          if (!selected) {
            return;
          }

          worktree = selected.worktree;
        }

        // Find existing Claude sessions for this worktree
        const sessions = await claudeSessionService.findSessionsForWorktree(worktree.path);

        if (sessions.length === 0) {
          vscode.window.showInformationMessage(
            `No existing Claude sessions found for ${worktree.name}. Sessions are stored in ~/.claude/projects/`
          );
          return;
        }

        // Filter out already imported sessions
        const existingChats = storageService.getChatsByWorktree(worktree.id);
        const existingSessionIds = new Set(existingChats.map(c => c.claudeSessionId).filter(Boolean));

        const availableSessions = sessions.filter(s => !existingSessionIds.has(s.sessionId));

        if (availableSessions.length === 0) {
          vscode.window.showInformationMessage('All existing sessions have already been imported.');
          return;
        }

        // Show picker for sessions to import
        const sessionItems = availableSessions.map(s => ({
          label: s.summary || `Session ${s.sessionId.substring(0, 8)}`,
          description: s.gitBranch ? `Branch: ${s.gitBranch}` : undefined,
          detail: s.lastUpdated
            ? `Last updated: ${s.lastUpdated.toLocaleString()} • ${s.messageCount} messages`
            : undefined,
          session: s,
          picked: false,
        }));

        const selectedSessions = await vscode.window.showQuickPick(sessionItems, {
          placeHolder: 'Select sessions to import (multi-select with Space)',
          canPickMany: true,
        });

        if (!selectedSessions || selectedSessions.length === 0) {
          return;
        }

        // Import selected sessions
        let imported = 0;
        for (const item of selectedSessions) {
          const session = item.session;
          const name = session.summary || `Imported: ${session.sessionId.substring(0, 8)}`;

          // Create chat with the existing Claude session ID
          const chat = storageService.createChat(worktree.id, name, null);
          storageService.updateChat(chat.id, {
            claudeSessionId: session.sessionId,
            createdAt: session.lastUpdated?.getTime() || Date.now(),
          });

          imported++;
        }

        vscode.window.showInformationMessage(`Imported ${imported} session(s) for ${worktree.name}`);
        refreshTree();
      }
    )
  );

  // Stage File
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.stageFile',
      async (item?: ChangeTreeItem) => {
        if (!item || !(item instanceof ChangeTreeItem)) {
          return;
        }

        const success = gitService.stageFile(item.worktreePath, item.change.path);
        if (success) {
          changesProvider.refresh();
        } else {
          vscode.window.showErrorMessage(`Failed to stage ${item.change.path}`);
        }
      }
    )
  );

  // Unstage File
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.unstageFile',
      async (item?: ChangeTreeItem) => {
        if (!item || !(item instanceof ChangeTreeItem)) {
          return;
        }

        const success = gitService.unstageFile(item.worktreePath, item.change.path);
        if (success) {
          changesProvider.refresh();
        } else {
          vscode.window.showErrorMessage(`Failed to unstage ${item.change.path}`);
        }
      }
    )
  );

  // Discard File Changes
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.discardFile',
      async (item?: ChangeTreeItem) => {
        if (!item || !(item instanceof ChangeTreeItem)) {
          return;
        }

        // Confirm before discarding
        const confirm = await vscode.window.showWarningMessage(
          `Discard changes to "${item.change.path}"? This cannot be undone.`,
          { modal: true },
          'Discard'
        );

        if (confirm !== 'Discard') {
          return;
        }

        const success = gitService.discardFile(item.worktreePath, item.change.path);
        if (success) {
          changesProvider.refresh();
        } else {
          vscode.window.showErrorMessage(`Failed to discard changes to ${item.change.path}`);
        }
      }
    )
  );

  // Stage All Changes
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.stageAll',
      async (item?: ChangeSectionItem) => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          return;
        }

        const success = gitService.stageAll(worktree.path);
        if (success) {
          changesProvider.refresh();
        } else {
          vscode.window.showErrorMessage('Failed to stage all changes');
        }
      }
    )
  );

  // Unstage All Changes
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.unstageAll',
      async (item?: ChangeSectionItem) => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          return;
        }

        const success = gitService.unstageAll(worktree.path);
        if (success) {
          changesProvider.refresh();
        } else {
          vscode.window.showErrorMessage('Failed to unstage all changes');
        }
      }
    )
  );
}
