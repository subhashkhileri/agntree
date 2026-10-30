import * as vscode from 'vscode';
import { StorageService } from './services/StorageService';
import { GitService } from './services/GitService';
import { TerminalManager } from './services/TerminalManager';
import { ClaudeSessionService } from './services/ClaudeSessionService';
import { ClaudeSessionWatcher } from './services/ClaudeSessionWatcher';
import { OpencodeSessionWatcher } from './services/OpencodeSessionWatcher';
import { CodexSessionWatcher } from './services/CodexSessionWatcher';
import { HarnessWatcherRegistry } from './services/HarnessWatcherRegistry';
import { SessionImportService } from './services/SessionImportService';
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
import { chatNativeSessionIds } from './harnesses/sessionUtils';

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

  /** A chat is open in a native UI when one of its sessions has a mapped tab. */
  const hasOpenNativeUi = (chat: import('./types').ChatSession): boolean => {
    const surfaces = harnessRegistry.get(chat.harness).nativeUi?.surfaces;
    if (!surfaces) {
      return false;
    }
    return chatNativeSessionIds(chat).some((sessionId) =>
      surfaces.isOpen(sessionId)
    );
  };

  /** The chat whose native-UI tab is the active editor tab, if any. */
  const activeNativeUiChatId = (): string | undefined => {
    const activeSessionByHarness = new Map<string, string>();
    for (const adapter of harnessRegistry.all()) {
      const sessionId = adapter.nativeUi?.surfaces?.activeSessionId();
      if (sessionId) {
        activeSessionByHarness.set(adapter.id, sessionId);
      }
    }
    if (activeSessionByHarness.size === 0) {
      return undefined;
    }
    for (const chat of storageService.getChats()) {
      const sessionId = activeSessionByHarness.get(chat.harness);
      if (sessionId && chatNativeSessionIds(chat).includes(sessionId)) {
        return chat.id;
      }
    }
    return undefined;
  };

  const terminalManager = new TerminalManager(
    storageService,
    harnessRegistry,
    harnessWatcherRegistry
  );

  /**
   * One definition of an open chat. The tree, attention tick, and importer all
   * use it; a caller that needs the resuming state adds it explicitly.
   */
  const isChatOpen = (chat: import('./types').ChatSession): boolean =>
    terminalManager.isActive(chat.id) || hasOpenNativeUi(chat);

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

  // Gate native-UI menu entries on the UI extension, which is separate from
  // the CLI-installed keys above. Re-check when extensions are installed or
  // removed so the menu does not need a reload.
  const updateNativeUiContexts = (): void => {
    let anyInstalled = false;
    for (const adapter of harnessRegistry.all()) {
      if (!adapter.nativeUi) {
        continue;
      }
      const installed = adapter.nativeUi.isInstalled();
      anyInstalled = anyInstalled || installed;
      void vscode.commands.executeCommand(
        'setContext',
        `agntree.${adapter.id}UiInstalled`,
        installed
      );
    }
    void vscode.commands.executeCommand(
      'setContext',
      'agntree.anyNativeUiInstalled',
      anyInstalled
    );
  };
  updateNativeUiContexts();
  context.subscriptions.push(
    vscode.extensions.onDidChange(updateNativeUiContexts)
  );

  // Initialize tree providers
  const workspacesProvider = new WorkspacesTreeProvider(
    storageService,
    gitService,
    terminalManager,
    harnessRegistry,
    context.extensionUri
  );
  workspacesProvider.setChatOpenProvider(isChatOpen);

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
    (id) => workspacesProvider.getWorktreeById(id),
    (worktree) => workspacesProvider.isGitWorktree(worktree)
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

  // Reconcile native sessions with the tree. Exact-ID watchers still link a
  // session Agntree launched; this service covers sessions started in an
  // agent's VS Code UI or outside Agntree, and ages out old auto-imports.
  const sessionImporter = new SessionImportService(
    storageService,
    gitService,
    harnessRegistry,
    {
      // Retention must also keep a chat whose terminal is still resuming.
      isChatOpen: (chat) =>
        isChatOpen(chat) || terminalManager.isResuming(chat.id),
      // The slow discovery pass is skipped while nobody can see the rows; a
      // launch that is still linking always scans.
      isVisible: () => workspacesTreeView.visible,
      onChatsChanged: (event) => {
        workspacesProvider.softRefresh();
        if (event.removed.length > 0) {
          const activeId = storageService.getActiveChatId();
          if (activeId && event.removed.includes(activeId)) {
            storageService.setActiveChatId(undefined);
            changesProvider.setActiveChat(undefined);
          }
        }
      },
    }
  );
  context.subscriptions.push(sessionImporter);
  sessionImporter.start();

  // The importer pauses its discovery pass while the sidebar is hidden; catch
  // up as soon as the rows are visible again.
  context.subscriptions.push(
    workspacesTreeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        sessionImporter.wake();
      }
    })
  );

  // Helper to update view titles with active worktree and repo name
  const updateViewTitles = (worktree: import('./types').Worktree | undefined) => {
    if (worktree) {
      const repo = storageService.getRepository(worktree.repoId);
      const repoName = repo?.name || '';
      const suffix =
        repoName && worktree.name !== repoName
          ? `${worktree.name} ~ ${repoName}`
          : worktree.name;
      changesTreeView.title = `Changes (${suffix})`;
      filesTreeView.title = `All Files (${suffix})`;
    } else {
      changesTreeView.title = 'Changes';
      filesTreeView.title = 'All Files';
    }
  };

  // Point every worktree-scoped panel at one worktree. Re-applying the same
  // worktree would dispose and recreate its file watchers for nothing, so only
  // the panel switch and the persisted id run when the worktree changes.
  let appliedWorktreeId: string | undefined;
  const applyActiveWorktree = (worktree: import('./types').Worktree) => {
    if (appliedWorktreeId !== worktree.id) {
      appliedWorktreeId = worktree.id;
      changesProvider.setActiveWorktree(worktree);
      filesProvider.setActiveWorktree(worktree);
      storageService.setActiveWorktreeId(worktree.id);
    }
    updateViewTitles(worktree);
  };

  /**
   * Select a chat in the tree and point the worktree panels at it. Shared by
   * terminal focus, notifications, and native-UI tab tracking.
   */
  const activateChat = (chat: import('./types').ChatSession): void => {
    if (storageService.getActiveChatId() !== chat.id) {
      storageService.setActiveChatId(chat.id);
    }
    const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
    if (worktree) {
      applyActiveWorktree(worktree);
    }
    const chatItem = workspacesProvider.getChatTreeItem(chat);
    void workspacesTreeView
      .reveal(chatItem, { select: true, focus: false, expand: true })
      .then(undefined, () => undefined);
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
      return (
        (Boolean(terminal) && terminal === vscode.window.activeTerminal) ||
        activeNativeUiChatId() === chatId
      );
    }
  );

  const attentionService = new SessionAttentionService(
    storageService,
    terminalManager,
    harnessRegistry,
    notificationService,
    (worktreeId) => workspacesProvider.getWorktreeById(worktreeId),
    // Turn changes swap the row icon between the beating mark and green dot.
    () => workspacesProvider.softRefresh(),
    isChatOpen
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
    workspacesProvider,
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
    sessionImporter,
    activateChat,
    refreshTree
  );
  registerFileCommands(context, filesProvider);

  /**
   * Select the chat that owns the active editor tab. An editor terminal is a
   * tab, and switching back from a Claude UI tab may not change
   * `activeTerminal` (it was already that terminal), so resolve the terminal
   * from the tab title as a fallback.
   */
  const activateActiveEditorChat = (): void => {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
      return;
    }

    if (activeTab.input instanceof vscode.TabInputTerminal) {
      const terminal = vscode.window.activeTerminal;
      const chatId =
        (terminal ? terminalManager.getChatIdForTerminal(terminal) : undefined) ??
        terminalManager.getChatIdForTerminalName(activeTab.label);
      const chat = chatId ? storageService.getChat(chatId) : undefined;
      if (chat) {
        activateChat(chat);
      }
      return;
    }

    const chatId = activeNativeUiChatId();
    const chat = chatId ? storageService.getChat(chatId) : undefined;
    if (chat) {
      activateChat(chat);
    }
  };

  // A mapped native-UI tab opening or closing changes the row icon.
  for (const adapter of harnessRegistry.all()) {
    const surfaces = adapter.nativeUi?.surfaces;
    if (!surfaces) {
      continue;
    }
    context.subscriptions.push(
      surfaces.onDidChange(() => workspacesProvider.softRefresh())
    );
  }

  // Follow every editor-tab focus change, not only native-UI changes. This is
  // what makes returning from a Claude tab to a CLI terminal tab select the
  // terminal's chat even when the active terminal itself did not change.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(activateActiveEditorChat),
    vscode.window.tabGroups.onDidChangeTabGroups(activateActiveEditorChat)
  );

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
      // A plain folder's root worktree renders as its folder row; a git
      // worktree renders as its own row. Reveal is best-effort because the
      // tree may not have rendered the row yet.
      const item = workspacesProvider.getTreeItemForWorktree(activeWorktree);
      void workspacesTreeView
        .reveal(item, { select: true, focus: false, expand: true })
        .then(undefined, () => undefined);
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

        if (selected.itemType === 'chat') {
          // Chat selected - show parent worktree's changes
          const chat = selected.data as import('./types').ChatSession;
          worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
          storageService.setActiveChatId(chat.id);
        } else {
          // A worktree row is its own worktree; a plain folder row stands in
          // for its root worktree. A git repository row has neither.
          worktree = workspacesProvider.getWorktreeForItem(selected);
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
          activateChat(chat);
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
