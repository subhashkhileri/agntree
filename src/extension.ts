import * as vscode from 'vscode';
import { StorageService } from './services/StorageService';
import { GitService } from './services/GitService';
import { TerminalManager } from './services/TerminalManager';
import { SessionWatcher } from './services/SessionWatcher';
import { WorkspacesTreeProvider } from './providers/WorkspacesTreeProvider';
import { ChangesTreeProvider } from './providers/ChangesTreeProvider';
import { registerRepositoryCommands } from './commands/repository';
import { registerWorktreeCommands } from './commands/worktree';
import { registerChatCommands } from './commands/chat';

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('Claude Workspaces extension is activating...');

  // Initialize services
  const storageService = new StorageService(context);
  const gitService = new GitService();
  const terminalManager = new TerminalManager(storageService);
  const sessionWatcher = new SessionWatcher(storageService);

  // Sync terminal manager with any existing state
  terminalManager.syncWithExistingTerminals();

  // Start watching for new Claude sessions
  sessionWatcher.startWatching();

  // Initialize tree providers
  const workspacesProvider = new WorkspacesTreeProvider(
    storageService,
    gitService,
    terminalManager
  );

  const changesProvider = new ChangesTreeProvider(
    storageService,
    gitService,
    (id) => workspacesProvider.getWorktreeById(id)
  );

  // Helper function to refresh the tree
  const refreshTree = () => {
    workspacesProvider.refresh();
  };

  // Register tree views
  const workspacesTreeView = vscode.window.createTreeView('workspacesView', {
    treeDataProvider: workspacesProvider,
    showCollapseAll: true,
  });

  const changesTreeView = vscode.window.createTreeView('changesView', {
    treeDataProvider: changesProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(workspacesTreeView);
  context.subscriptions.push(changesTreeView);

  // Register commands
  registerRepositoryCommands(context, storageService, gitService, refreshTree);
  registerWorktreeCommands(context, storageService, gitService, refreshTree);
  registerChatCommands(
    context,
    storageService,
    gitService,
    terminalManager,
    workspacesProvider,
    changesProvider,
    sessionWatcher,
    refreshTree
  );

  // Refresh tree when chat names are auto-updated
  sessionWatcher.onChatNameUpdated(() => {
    refreshTree();
  });

  // Restore active worktree from storage on activation
  // This runs after extension host restart (e.g., after workspace folder switch)
  const savedWorktreeId = storageService.getActiveWorktreeId();
  if (savedWorktreeId) {
    const worktree = workspacesProvider.getWorktreeById(savedWorktreeId);
    if (worktree) {
      changesProvider.setActiveWorktree(worktree);
    }
  }

  // Listen for tree view selection changes to update changes view and switch workspace
  workspacesTreeView.onDidChangeSelection((event) => {
    if (event.selection.length > 0) {
      const selected = event.selection[0];
      let worktree: import('./types').Worktree | undefined;

      if (selected.itemType === 'worktree') {
        // Worktree selected - show its changes
        worktree = selected.data as import('./types').Worktree;
      } else if (selected.itemType === 'chat') {
        // Chat selected - show parent worktree's changes
        const chat = selected.data as import('./types').ChatSession;
        worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        storageService.setActiveChatId(chat.id);
      }

      if (!worktree) {
        return;
      }

      // Update the Changes panel with the selected worktree
      changesProvider.setActiveWorktree(worktree);

      // Save active worktree ID to storage (persists across extension host restarts)
      storageService.setActiveWorktreeId(worktree.id);

      // Switch VS Code workspace folder if needed
      const worktreePath = worktree.path;
      const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      if (currentFolder !== worktreePath) {
        const folderCount = vscode.workspace.workspaceFolders?.length || 0;
        vscode.workspace.updateWorkspaceFolders(
          0,           // Start at index 0
          folderCount, // Remove all existing folders
          { uri: vscode.Uri.file(worktreePath) } // Add new folder
        );
        // Extension host will restart, but active worktree ID is saved in storage
        // and will be restored on next activation
      }
    }
  });

  // Dispose resources on deactivation
  context.subscriptions.push({
    dispose: () => {
      terminalManager.dispose();
      changesProvider.dispose();
      sessionWatcher.dispose();
    },
  });

  console.log('Claude Workspaces extension activated successfully!');
}

/**
 * Extension deactivation
 */
export function deactivate() {
  console.log('Claude Workspaces extension deactivated');
}
