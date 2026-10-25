import * as vscode from 'vscode';
import { StorageService } from './services/StorageService';
import { GitService } from './services/GitService';
import { TerminalManager } from './services/TerminalManager';
import { ClaudeSessionService } from './services/ClaudeSessionService';
import { ClaudeSessionWatcher } from './services/ClaudeSessionWatcher';
import { OpencodeSessionWatcher } from './services/OpencodeSessionWatcher';
import { CodexSessionWatcher } from './services/CodexSessionWatcher';
import { HarnessWatcherRegistry } from './services/HarnessWatcherRegistry';
import { ClaudeHarness } from './harnesses/ClaudeHarness';
import { OpencodeHarness } from './harnesses/OpencodeHarness';
import { CodexHarness } from './harnesses/CodexHarness';
import { HarnessRegistry } from './harnesses/HarnessRegistry';
import { WorkspacesTreeProvider } from './providers/WorkspacesTreeProvider';
import { ChangesTreeProvider } from './providers/ChangesTreeProvider';
import { FilesTreeProvider } from './providers/FilesTreeProvider';
import { registerRepositoryCommands } from './commands/repository';
import { registerWorktreeCommands } from './commands/worktree';
import { registerChatCommands } from './commands/chat';
import { registerFileCommands } from './commands/files';
import { NotificationService } from './services/NotificationService';
import { SessionAttentionService } from './services/SessionAttentionService';
import { disposeOperationLog } from './services/OperationLog';

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('Agntree extension is activating...');

  // Initialize services
  const storageService = new StorageService(context);
  const gitService = new GitService();

  const opencodeHarness = new OpencodeHarness();
  const codexHarness = new CodexHarness();
  const claudeSessionService = new ClaudeSessionService();
  const harnessRegistry = new HarnessRegistry([
    new ClaudeHarness({ sessionService: claudeSessionService }),
    opencodeHarness,
    codexHarness,
  ]);
  const harnessWatcherRegistry = new HarnessWatcherRegistry([
    new ClaudeSessionWatcher(storageService, claudeSessionService),
    new OpencodeSessionWatcher(storageService, opencodeHarness),
    new CodexSessionWatcher(storageService, codexHarness),
  ]);

  const terminalManager = new TerminalManager(
    storageService,
    harnessRegistry,
    harnessWatcherRegistry
  );

  // Start watching for new sessions from every harness
  harnessWatcherRegistry.startAll();

  // Gate harness-specific menus on installation.
  void (async () => {
    const installed = await Promise.all(
      harnessRegistry.all().map(async (adapter) => {
        const isInstalled = await harnessRegistry.isInstalled(adapter.id);
        await vscode.commands.executeCommand(
          'setContext',
          `agntree.${adapter.id}Installed`,
          isInstalled
        );
        return isInstalled;
      })
    );
    await vscode.commands.executeCommand(
      'setContext',
      'agntree.anyHarnessInstalled',
      installed.some(Boolean)
    );
  })();

  // Initialize tree providers
  const workspacesProvider = new WorkspacesTreeProvider(
    storageService,
    gitService,
    terminalManager,
    harnessRegistry,
    context.extensionUri
  );

  // Reconcile terminals that survived a reload or a quit. Adoption is bounded
  // and must finish before a click can open a chat, so activation waits for it.
  // Resuming revived tabs asks the harness whether each session still exists;
  // that native call can outlast startup, so it runs after the views and
  // commands exist.
  const restore = terminalManager.beginRestoreSync((worktreeId) =>
    workspacesProvider.getWorktreeById(worktreeId)
  );
  await restore.adopted;
  void restore.complete.catch((error) => {
    console.error('Agntree: restoring terminals failed', error);
  });

  const changesProvider = new ChangesTreeProvider(
    storageService,
    gitService,
    (id) => workspacesProvider.getWorktreeById(id)
  );

  const filesProvider = new FilesTreeProvider();

  // Helper function to refresh the tree
  const refreshTree = () => {
    workspacesProvider.refresh();
  };

  // Register tree views
  const workspacesTreeView = vscode.window.createTreeView('agntree.workspacesView', {
    treeDataProvider: workspacesProvider,
    showCollapseAll: true,
  });

  const changesTreeView = vscode.window.createTreeView('agntree.changesView', {
    treeDataProvider: changesProvider,
    showCollapseAll: false,
  });

  const filesTreeView = vscode.window.createTreeView('agntree.filesView', {
    treeDataProvider: filesProvider,
    showCollapseAll: true,
  });

  context.subscriptions.push(workspacesTreeView);
  context.subscriptions.push(changesTreeView);
  context.subscriptions.push(filesTreeView);

  // Helper to update view titles with active worktree and repo name
  const updateViewTitles = (worktree: import('./types').Worktree | undefined) => {
    if (worktree) {
      const repo = storageService.getRepository(worktree.repoId);
      const repoName = repo?.name || '';
      const suffix = repoName ? `${worktree.name} ~ ${repoName}` : worktree.name;
      changesTreeView.title = `Changes (${suffix})`;
      filesTreeView.title = `All Files (${suffix})`;
    } else {
      changesTreeView.title = 'Changes';
      filesTreeView.title = 'All Files';
    }
  };

  // Point every worktree-scoped panel at one worktree.
  const applyActiveWorktree = (worktree: import('./types').Worktree) => {
    changesProvider.setActiveWorktree(worktree);
    filesProvider.setActiveWorktree(worktree);
    updateViewTitles(worktree);
    storageService.setActiveWorktreeId(worktree.id);
  };

  // Notifications for sessions that stop working: a finished turn, or a
  // session waiting on the user.
  const openChatFromNotification = (chatId: string) => {
    const chat = storageService.getChat(chatId);
    if (!chat) {
      return;
    }

    const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
    if (worktree) {
      applyActiveWorktree(worktree);
    }

    terminalManager.focusChat(chatId);

    if (workspacesTreeView.visible) {
      workspacesTreeView.reveal(workspacesProvider.getChatTreeItem(chat), {
        select: true,
        focus: false,
        expand: true,
      });
    }
  };

  const notificationService = new NotificationService(
    openChatFromNotification,
    (chatId) => {
      const terminal = terminalManager.getTerminal(chatId);
      return Boolean(terminal) && terminal === vscode.window.activeTerminal;
    }
  );

  const attentionService = new SessionAttentionService(
    storageService,
    terminalManager,
    harnessRegistry,
    notificationService,
    (worktreeId) => workspacesProvider.getWorktreeById(worktreeId),
    // Turn changes swap the row icon between the beating mark and green dot.
    () => workspacesProvider.softRefresh()
  );
  attentionService.start();
  workspacesProvider.setTurnStateProvider((chatId) =>
    attentionService.getTurnState(chatId)
  );
  context.subscriptions.push({ dispose: () => attentionService.dispose() });

  // Register commands
  registerRepositoryCommands(context, storageService, gitService, refreshTree);
  registerWorktreeCommands(
    context,
    storageService,
    gitService,
    refreshTree,
    (worktreeId) => workspacesProvider.getPRUrl(worktreeId)
  );
  registerChatCommands(
    context,
    storageService,
    gitService,
    terminalManager,
    workspacesProvider,
    changesProvider,
    harnessRegistry,
    harnessWatcherRegistry,
    refreshTree
  );
  registerFileCommands(context, filesProvider);

  // Auto-switch workspace setting commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.disableAutoSwitch', async () => {
      const config = vscode.workspace.getConfiguration('agntree');
      await config.update('autoSwitchWorkspaceFolder', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Auto-switch workspace folder disabled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.enableAutoSwitch', async () => {
      const config = vscode.workspace.getConfiguration('agntree');
      await config.update('autoSwitchWorkspaceFolder', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Auto-switch workspace folder enabled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.disableFocusOnStartup', async () => {
      const cfg = vscode.workspace.getConfiguration('agntree');
      await cfg.update('focusOnStartup', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Focus on startup disabled');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.enableFocusOnStartup', async () => {
      const cfg = vscode.workspace.getConfiguration('agntree');
      await cfg.update('focusOnStartup', true, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('Focus on startup enabled');
    })
  );

  // Refresh tree when chat names are auto-updated
  context.subscriptions.push(
    harnessWatcherRegistry.onChatNameUpdated(() => {
      workspacesProvider.softRefresh();
    })
  );

  // On activation, expand only the worktree matching the current VS Code workspace folder
  const currentFolderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const activeWorktree = currentFolderPath
    ? workspacesProvider.findWorktreeByPath(currentFolderPath)
    : undefined;

  if (activeWorktree) {
    applyActiveWorktree(activeWorktree);

    const revealActive = () => {
      const item = workspacesProvider.getWorktreeTreeItem(activeWorktree);
      workspacesTreeView.reveal(item, { select: true, focus: false, expand: true });
    };

    if (workspacesTreeView.visible) {
      setTimeout(revealActive, 100);
    } else {
      const d = workspacesTreeView.onDidChangeVisibility((e) => {
        if (e.visible) { d.dispose(); setTimeout(revealActive, 100); }
      });
      context.subscriptions.push(d);
    }
  }

  // Listen for tree view selection changes to update changes view and switch workspace
  context.subscriptions.push(
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

        // Point the Changes and Files panels at this worktree.
        // The active worktree ID is persisted so an extension-host restart
        // (auto-switch) restores the same selection.
        applyActiveWorktree(worktree);

        // Switch VS Code workspace folder if enabled in settings
        const config = vscode.workspace.getConfiguration('agntree');
        const autoSwitch = config.get<boolean>('autoSwitchWorkspaceFolder', false);

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
    })
  );

  // Listen for terminal focus changes to select corresponding chat in tree
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      if (!terminal) return;

      // The retitle pass activates restored tabs to rename them. That is
      // background work, not a user focus change, so it must not move the tree
      // selection or the active worktree (and must not trigger auto-switch).
      if (terminalManager.consumeBackgroundActivation(terminal)) return;

      // The manager owns the terminal-to-chat mapping; the title itself is
      // re-applied from inside TerminalManager.
      const chatId = terminalManager.getChatIdForTerminal(terminal);
      if (chatId) {
        const chat = storageService.getChat(chatId);

        if (chat) {
          // Update active chat and worktree
          storageService.setActiveChatId(chat.id);

          const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
          if (worktree) {
            applyActiveWorktree(worktree);
          }

          // Reveal and select the chat in tree view. A newly created chat may
          // not be in the tree yet (refresh is debounced), so this is
          // best-effort and must not surface as an unhandled rejection.
          const chatItem = workspacesProvider.getChatTreeItem(chat);
          void workspacesTreeView
            .reveal(chatItem, { select: true, focus: false, expand: true })
            .then(undefined, () => undefined);
        }
      }
    })
  );

  // Dispose resources on deactivation
  context.subscriptions.push({
    dispose: () => {
      terminalManager.dispose();
      changesProvider.dispose();
      filesProvider.dispose();
      workspacesProvider.dispose();
      harnessWatcherRegistry.dispose();
      harnessRegistry.dispose();
    },
  });

  const config = vscode.workspace.getConfiguration('agntree');
  if (config.get<boolean>('focusOnStartup', false)) {
    vscode.commands.executeCommand('workbench.view.extension.agntree');
  }

  console.log('Agntree extension activated successfully!');
}

/**
 * Extension deactivation
 */
export function deactivate() {
  disposeOperationLog();
  console.log('Agntree extension deactivated');
}
