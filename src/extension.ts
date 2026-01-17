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

  // Listen for tree view selection changes to update changes view and switch workspace
  workspacesTreeView.onDidChangeSelection((event) => {
    if (event.selection.length > 0) {
      const selected = event.selection[0];
      let worktreePath: string | undefined;

      if (selected.itemType === 'worktree') {
        // Worktree selected - switch to its folder and show changes
        const worktree = selected.data as import('./types').Worktree;
        worktreePath = worktree.path;
        changesProvider.setActiveWorktree(worktree);
      } else if (selected.itemType === 'chat') {
        // Chat selected - switch to parent worktree's folder and show changes
        const chat = selected.data as import('./types').ChatSession;
        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (worktree) {
          worktreePath = worktree.path;
          changesProvider.setActiveWorktree(worktree);
        }
        storageService.setActiveChatId(chat.id);
      }

      // Switch VS Code workspace to the worktree folder (without reload)
      if (worktreePath) {
        const currentFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        // Only switch if it's a different folder
        if (currentFolder !== worktreePath) {
          const folderCount = vscode.workspace.workspaceFolders?.length || 0;
          vscode.workspace.updateWorkspaceFolders(
            0,           // Start at index 0
            folderCount, // Remove all existing folders
            { uri: vscode.Uri.file(worktreePath) } // Add new folder
          );

          // Force git extension to reinitialize after folder switch
          setTimeout(() => {
            vscode.commands.executeCommand('git.refresh');
          }, 300);
        }
      }
    }
  });

  // Dispose resources on deactivation
  context.subscriptions.push({
    dispose: () => {
      terminalManager.dispose();
      changesProvider.dispose();
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
