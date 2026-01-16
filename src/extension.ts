import * as vscode from 'vscode';
import { StorageService } from './services/StorageService';
import { GitService } from './services/GitService';
import { TerminalManager } from './services/TerminalManager';
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

  // Sync terminal manager with any existing state
  terminalManager.syncWithExistingTerminals();

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
    refreshTree
  );

  // Listen for tree view selection changes to update changes view
  workspacesTreeView.onDidChangeSelection((event) => {
    if (event.selection.length > 0) {
      const selected = event.selection[0];
      if (selected.itemType === 'chat') {
        const chat = selected.data;
        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        changesProvider.setActiveChat(chat.id, worktree);
        storageService.setActiveChatId(chat.id);
      }
    }
  });

  // Dispose terminal manager on deactivation
  context.subscriptions.push({
    dispose: () => {
      terminalManager.dispose();
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
