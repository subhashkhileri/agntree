import * as vscode from 'vscode';
import { StorageService } from './services/StorageService';
import { GitService } from './services/GitService';
import { TerminalManager } from './services/TerminalManager';
import { SessionWatcher } from './services/SessionWatcher';
import { WorkspacesTreeProvider } from './providers/WorkspacesTreeProvider';
import { ChangesTreeProvider } from './providers/ChangesTreeProvider';
import { QuickActionsTreeProvider } from './providers/QuickActionsTreeProvider';
import { registerRepositoryCommands } from './commands/repository';
import { registerWorktreeCommands } from './commands/worktree';
import { registerChatCommands } from './commands/chat';
import { registerQuickActionCommands } from './commands/quickActions';

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

  const quickActionsProvider = new QuickActionsTreeProvider();

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

  const quickActionsTreeView = vscode.window.createTreeView('quickActionsView', {
    treeDataProvider: quickActionsProvider,
    showCollapseAll: false,
  });

  context.subscriptions.push(workspacesTreeView);
  context.subscriptions.push(changesTreeView);
  context.subscriptions.push(quickActionsTreeView);

  // Helper to update view titles with active worktree and repo name
  const updateViewTitles = (worktree: import('./types').Worktree | undefined) => {
    if (worktree) {
      const repo = storageService.getRepository(worktree.repoId);
      const repoName = repo?.name || '';
      const suffix = repoName ? `${worktree.name} ~ ${repoName}` : worktree.name;
      changesTreeView.title = `Changes (${suffix})`;
      quickActionsTreeView.title = `Quick Actions (${suffix})`;
    } else {
      changesTreeView.title = 'Changes';
      quickActionsTreeView.title = 'Quick Actions';
    }
  };

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
  registerQuickActionCommands(context, changesProvider, quickActionsProvider);

  // Auto-switch workspace setting commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-workspaces.disableAutoSwitch', async () => {
      const config = vscode.workspace.getConfiguration('claude-workspaces');
      await config.update('autoSwitchWorkspaceFolder', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Auto-switch workspace folder disabled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-workspaces.enableAutoSwitch', async () => {
      const config = vscode.workspace.getConfiguration('claude-workspaces');
      await config.update('autoSwitchWorkspaceFolder', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Auto-switch workspace folder enabled');
    })
  );

  // Refresh tree when chat names are auto-updated
  sessionWatcher.onChatNameUpdated(() => {
    refreshTree();
  });

  // Refresh quick actions view when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claude-workspaces.quickActions')) {
        quickActionsProvider.refresh();
      }
    })
  );

  // Restore active selection from storage on activation
  // This runs after extension host restart (e.g., after workspace folder switch)
  const savedWorktreeId = storageService.getActiveWorktreeId();
  const savedChatId = storageService.getActiveChatId();

  if (savedWorktreeId) {
    const worktree = workspacesProvider.getWorktreeById(savedWorktreeId);
    if (worktree) {
      changesProvider.setActiveWorktree(worktree);
      quickActionsProvider.setActiveWorktreePath(worktree.path);
      updateViewTitles(worktree);

      // Reveal and select in tree view once it becomes visible
      const revealSelection = () => {
        // If a chat was selected, reveal the chat; otherwise reveal the worktree
        if (savedChatId) {
          const chat = storageService.getChat(savedChatId);
          if (chat && chat.worktreeId === savedWorktreeId) {
            const chatItem = workspacesProvider.getChatTreeItem(chat);
            workspacesTreeView.reveal(chatItem, { select: true, focus: false, expand: true });
            return;
          }
        }
        // Fall back to revealing the worktree
        const worktreeItem = workspacesProvider.getWorktreeTreeItem(worktree);
        workspacesTreeView.reveal(worktreeItem, { select: true, focus: false, expand: true });
      };

      // Wait for tree view to be visible before revealing
      if (workspacesTreeView.visible) {
        setTimeout(revealSelection, 100);
      } else {
        const visibilityDisposable = workspacesTreeView.onDidChangeVisibility((e) => {
          if (e.visible) {
            visibilityDisposable.dispose();
            setTimeout(revealSelection, 100);
          }
        });
        context.subscriptions.push(visibilityDisposable);
      }
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

      // Update the Quick Actions panel with the selected worktree path
      quickActionsProvider.setActiveWorktreePath(worktree.path);

      // Update view titles with worktree and repo name
      updateViewTitles(worktree);

      // Save active worktree ID to storage (persists across extension host restarts)
      storageService.setActiveWorktreeId(worktree.id);

      // Switch VS Code workspace folder if enabled in settings
      const config = vscode.workspace.getConfiguration('claude-workspaces');
      const autoSwitch = config.get<boolean>('autoSwitchWorkspaceFolder', true);

      if (autoSwitch) {
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
    }
  });

  // Listen for terminal focus changes to select corresponding chat in tree
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;

      // Parse the chat ID from the terminal name
      const shortId = TerminalManager.parseChatIdFromTerminalName(terminal.name);

      if (shortId) {
        // Find the chat by ID prefix
        const chats = storageService.getChats();
        const chat = chats.find((c) => c.id.startsWith(shortId));

        if (chat) {
          // Update active chat and worktree
          storageService.setActiveChatId(chat.id);
          storageService.setActiveWorktreeId(chat.worktreeId);

          const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
          if (worktree) {
            changesProvider.setActiveWorktree(worktree);
            quickActionsProvider.setActiveWorktreePath(worktree.path);
            updateViewTitles(worktree);
          }

          // Reveal and select the chat in tree view
          const chatItem = workspacesProvider.getChatTreeItem(chat);
          workspacesTreeView.reveal(chatItem, { select: true, focus: false, expand: true });
        }
      }
    })
  );

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
