import * as os from 'os';
import * as vscode from 'vscode';
import { ChatSession, Worktree } from './types';
import { StorageService } from './services/StorageService';
import { WorktreeCatalog } from './services/WorktreeCatalog';
import { GitService } from './services/GitService';
import { GitHubService } from './services/GitHubService';
import { TerminalManager } from './services/TerminalManager';
import { ClaudeSessionService } from './services/ClaudeSessionService';
import { ClaudeSessionWatcher } from './services/ClaudeSessionWatcher';
import { OpencodeSessionWatcher } from './services/OpencodeSessionWatcher';
import { CodexSessionWatcher } from './services/CodexSessionWatcher';
import { HarnessWatcherRegistry } from './services/HarnessWatcherRegistry';
import { SessionImportService } from './services/SessionImportService';
import { NotificationService } from './services/NotificationService';
import { SessionAttentionService } from './services/SessionAttentionService';
import { SessionSearchService } from './services/SessionSearchService';
import { disposeOperationLog } from './services/OperationLog';
import { ClaudeHarness } from './harnesses/ClaudeHarness';
import { OpencodeHarness } from './harnesses/OpencodeHarness';
import { CodexHarness } from './harnesses/CodexHarness';
import { HarnessRegistry } from './harnesses/HarnessRegistry';
import { chatNativeSessionIds } from './harnesses/sessionUtils';
import { WorkspacesTreeProvider } from './providers/WorkspacesTreeProvider';
import { ChangesTreeProvider } from './providers/ChangesTreeProvider';
import { FilesTreeProvider } from './providers/FilesTreeProvider';
import { SessionSearchTreeProvider } from './providers/SessionSearchTreeProvider';
import { registerRepositoryCommands } from './commands/repository';
import { registerWorktreeCommands } from './commands/worktree';
import { registerChatCommands } from './commands/chat';
import { registerChangesCommands } from './commands/changes';
import { registerSessionImportCommands } from './commands/sessionImport';
import { registerFileCommands } from './commands/files';
import { SESSION_SEARCH_VIEW, registerSessionSearchCommands } from './commands/sessionSearch';
import { commandRegistrar } from './commands/common';
import { debounce } from './utils/debounce';

/** Panels re-read the worktree this long after its files stop changing. */
const FILE_CHANGE_DEBOUNCE_MS = 300;

export async function activate(context: vscode.ExtensionContext) {
  const config = () => vscode.workspace.getConfiguration('agntree');
  const register = commandRegistrar(context);
  const setContext = (key: string, value: unknown) =>
    void vscode.commands.executeCommand('setContext', key, value);

  // Services and harnesses
  const storageService = new StorageService(context);
  const gitService = new GitService();
  const worktreeCatalog = new WorktreeCatalog(storageService, gitService);
  const gitHubService = new GitHubService();
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
    new OpencodeSessionWatcher(storageService, opencodeHarness, worktreeCatalog),
    new CodexSessionWatcher(storageService, codexHarness, worktreeCatalog),
  ]);
  const terminalManager = new TerminalManager(storageService, harnessRegistry, harnessWatcherRegistry);

  const hasOpenNativeUi = (chat: ChatSession): boolean => {
    const surfaces = harnessRegistry.get(chat.harness).nativeUi?.surfaces;
    return Boolean(surfaces && chatNativeSessionIds(chat).some((id) => surfaces.isOpen(id)));
  };
  /**
   * The one definition of an open chat: a live terminal or a mapped
   * native-UI tab. The tree, attention tick, and importer all use it.
   */
  const isChatOpen = (chat: ChatSession): boolean => terminalManager.isActive(chat.id) || hasOpenNativeUi(chat);

  /** The chat whose native-UI tab is the active editor tab, if any. */
  const activeNativeUiChatId = (): string | undefined => {
    const activeSessions = new Map(
      harnessRegistry.all().flatMap((adapter) => {
        const sessionId = adapter.nativeUi?.surfaces?.activeSessionId();
        return sessionId ? [[adapter.id, sessionId] as const] : [];
      })
    );
    if (activeSessions.size === 0) {
      return undefined;
    }
    return storageService.getChats().find((chat) => {
      const sessionId = activeSessions.get(chat.harness);
      return sessionId !== undefined && chatNativeSessionIds(chat).includes(sessionId);
    })?.id;
  };

  harnessWatcherRegistry.startAll();

  // Menu gating: a harness entry needs its CLI; a UI entry needs the agent's
  // extension, re-checked when extensions change so no reload is needed.
  void Promise.all(
    harnessRegistry.all().map(async (adapter) => {
      const installed = await harnessRegistry.isInstalled(adapter.id);
      setContext(`agntree.${adapter.id}Installed`, installed);
      return installed;
    })
  ).then((installed) => setContext('agntree.anyHarnessInstalled', installed.some(Boolean)));
  const updateNativeUiContexts = (): void => {
    let anyInstalled = false;
    for (const adapter of harnessRegistry.all()) {
      if (adapter.nativeUi) {
        const installed = adapter.nativeUi.isInstalled();
        anyInstalled ||= installed;
        setContext(`agntree.${adapter.id}UiInstalled`, installed);
      }
    }
    setContext('agntree.anyNativeUiInstalled', anyInstalled);
  };
  updateNativeUiContexts();
  context.subscriptions.push(vscode.extensions.onDidChange(updateNativeUiContexts));

  // Views
  const workspacesProvider = new WorkspacesTreeProvider(
    storageService,
    gitService,
    terminalManager,
    harnessRegistry,
    gitHubService,
    context.extensionUri
  );
  workspacesProvider.setChatOpenProvider(isChatOpen);

  // Reconcile terminals that survived a reload or a quit (ADR 0009). Adoption
  // must finish before a click can open a chat; resuming revived tabs asks
  // the harness whether each session still exists, so it continues after the
  // views and commands exist.
  const restore = terminalManager.beginRestoreSync((id) => workspacesProvider.getWorktreeById(id));
  await restore.adopted;
  void restore.complete.catch((error) => console.error('Agntree: restoring terminals failed', error));

  const changesProvider = new ChangesTreeProvider(gitService, (worktree) => workspacesProvider.isGitWorktree(worktree));
  const filesProvider = new FilesTreeProvider();
  const workspacesTreeView = vscode.window.createTreeView('agntree.workspacesView', {
    treeDataProvider: workspacesProvider,
    showCollapseAll: true,
  });
  const changesTreeView = vscode.window.createTreeView('agntree.changesView', { treeDataProvider: changesProvider });
  const filesTreeView = vscode.window.createTreeView('agntree.filesView', {
    treeDataProvider: filesProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(workspacesTreeView, changesTreeView, filesTreeView);
  const refreshTree = () => workspacesProvider.refresh();

  // The worktree the Changes and Files panels show, and one watcher on its
  // files that refreshes both.
  let shownWorktree: Worktree | undefined;
  let worktreeWatcher: vscode.FileSystemWatcher | undefined;
  const refreshPanels = debounce(() => {
    changesProvider.refresh();
    filesProvider.refresh();
  }, FILE_CHANGE_DEBOUNCE_MS);
  const showWorktree = (worktree: Worktree | undefined): void => {
    if (worktree?.id !== shownWorktree?.id) {
      shownWorktree = worktree;
      worktreeWatcher?.dispose();
      worktreeWatcher = undefined;
      if (worktree) {
        worktreeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(worktree.path, '**/*'));
        worktreeWatcher.onDidChange(refreshPanels);
        worktreeWatcher.onDidCreate(refreshPanels);
        worktreeWatcher.onDidDelete(refreshPanels);
      }
      changesProvider.setActiveWorktree(worktree);
      filesProvider.setActiveWorktree(worktree);
    }
    const repoName = worktree && storageService.getRepository(worktree.repoId)?.name;
    const suffix = !worktree
      ? ''
      : repoName && worktree.name !== repoName
        ? ` (${worktree.name} ~ ${repoName})`
        : ` (${worktree.name})`;
    changesTreeView.title = `Changes${suffix}`;
    filesTreeView.title = `All Files${suffix}`;
  };

  /** Close chats' terminals and delete their rows; a removed selection is cleared. */
  const removeChats = (chatIds: string[], options?: { rememberSession?: boolean }): string[] => {
    chatIds.forEach((id) => terminalManager.closeChat(id));
    const removed = storageService.deleteChats(chatIds, options);
    const activeId = storageService.getActiveChatId();
    if (activeId && removed.includes(activeId)) {
      storageService.setActiveChatId(undefined);
      showWorktree(undefined);
    }
    return removed;
  };

  /**
   * Forget worktrees that are gone from Agntree. Their chats are removed
   * without tombstones, so the sessions can be imported again later.
   */
  const forgetWorktrees = (worktrees: Worktree[]): void => {
    const ids = new Set(worktrees.map((worktree) => worktree.id));
    removeChats(
      storageService.getChats().filter((chat) => ids.has(chat.worktreeId)).map((chat) => chat.id),
      { rememberSession: false }
    );
    if (shownWorktree && ids.has(shownWorktree.id)) {
      showWorktree(undefined);
    }
  };

  const switchWorkspaceFolder = (folderPath: string): void => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders[0]?.uri.fsPath !== folderPath) {
      vscode.workspace.updateWorkspaceFolders(0, folders.length, { uri: vscode.Uri.file(folderPath) });
    }
  };

  /** Select a chat's row and point the panels at its worktree. */
  const activateChat = (chat: ChatSession, options: { revealIfHidden?: boolean } = { revealIfHidden: true }) => {
    if (storageService.getActiveChatId() !== chat.id) {
      storageService.setActiveChatId(chat.id);
    }
    const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
    if (worktree) {
      showWorktree(worktree);
    }
    if (options.revealIfHidden || workspacesTreeView.visible) {
      void workspacesTreeView
        .reveal(workspacesProvider.getChatTreeItem(chat), { select: true, focus: false, expand: true })
        .then(undefined, () => undefined);
    }
  };

  // Native sessions started outside an exact-ID launch: a UI launch, or a
  // session started outside Agntree. Also ages out quiet auto-imports.
  const sessionImporter = new SessionImportService(storageService, worktreeCatalog, harnessRegistry, {
    // Retention must also keep a chat whose terminal is still resuming.
    isChatOpen: (chat) => isChatOpen(chat) || terminalManager.isResuming(chat.id),
    isVisible: () => workspacesTreeView.visible,
    onChatsChanged: (event) => {
      workspacesProvider.softRefresh();
      const activeId = storageService.getActiveChatId();
      if (activeId && event.removed.includes(activeId)) {
        storageService.setActiveChatId(undefined);
        showWorktree(undefined);
      }
    },
  });
  context.subscriptions.push(sessionImporter);
  sessionImporter.start();

  const notificationService = new NotificationService(
    (chatId) => {
      const chat = storageService.getChat(chatId);
      if (chat) {
        terminalManager.focusChat(chatId);
        activateChat(chat, { revealIfHidden: false });
      }
    },
    (chatId) => {
      const terminal = terminalManager.getTerminal(chatId);
      return (terminal !== undefined && terminal === vscode.window.activeTerminal) || activeNativeUiChatId() === chatId;
    }
  );
  const attentionService = new SessionAttentionService(
    storageService,
    harnessRegistry,
    notificationService,
    (worktreeId) => workspacesProvider.getWorktreeById(worktreeId),
    // Turn changes swap the row mark between the beating mark and green dot.
    () => workspacesProvider.softRefresh(),
    isChatOpen
  );
  attentionService.start();
  workspacesProvider.setTurnStateProvider((chatId) => attentionService.getTurnState(chatId));

  // Commands
  registerRepositoryCommands(context, { storageService, gitService, forgetWorktrees, refreshTree });
  registerWorktreeCommands(context, {
    storageService,
    gitService,
    gitHubService,
    workspacesProvider,
    forgetWorktrees,
    switchWorkspaceFolder,
    refreshTree,
  });
  registerChatCommands(context, {
    storageService,
    gitService,
    terminalManager,
    workspacesProvider,
    harnessRegistry,
    harnessWatcherRegistry,
    sessionImporter,
    activateChat,
    showWorktree,
    removeChats,
    refreshTree,
  });
  registerSessionImportCommands(context, storageService, gitService, worktreeCatalog, workspacesProvider, harnessRegistry, refreshTree);
  registerChangesCommands(context, gitService, changesProvider, refreshTree);
  registerFileCommands(context, filesProvider);

  // Each search runs in a short temp folder of its own, so its leftovers
  // never mix with a real project's sessions.
  const sessionSearch = new SessionSearchService(storageService, harnessRegistry, os.tmpdir());
  const sessionSearchProvider = new SessionSearchTreeProvider(sessionSearch, harnessRegistry, context.extensionUri);
  const sessionSearchTreeView = vscode.window.createTreeView(SESSION_SEARCH_VIEW, {
    treeDataProvider: sessionSearchProvider,
  });
  context.subscriptions.push(sessionSearch, sessionSearchProvider, sessionSearchTreeView);
  registerSessionSearchCommands(context, {
    sessionSearch,
    storageService,
    harnessRegistry,
    worktreeCatalog,
    workspacesProvider,
    activateChat,
    refreshTree,
    isViewVisible: () => sessionSearchTreeView.visible,
  });
  for (const [name, setting, label] of [
    ['AutoSwitch', 'autoSwitchWorkspaceFolder', 'Auto-switch workspace folder'],
    ['FocusOnStartup', 'focusOnStartup', 'Focus on startup'],
  ]) {
    for (const enabled of [true, false]) {
      register(`agntree.${enabled ? 'enable' : 'disable'}${name}`, async () => {
        await config().update(setting, enabled, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`${label} ${enabled ? 'enabled' : 'disabled'}`);
      });
    }
  }

  // Follow focus: a terminal, an editor terminal tab, or a native-UI tab
  // selects its chat. Switching back from a Claude tab to an editor terminal
  // may not change `activeTerminal`, so the tab title is the fallback.
  const activateActiveEditorChat = (): void => {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
      return;
    }
    let chatId: string | undefined;
    if (activeTab.input instanceof vscode.TabInputTerminal) {
      const terminal = vscode.window.activeTerminal;
      chatId =
        (terminal && terminalManager.getChatIdForTerminal(terminal)) ??
        terminalManager.getChatIdForTerminalName(activeTab.label);
    } else {
      chatId = activeNativeUiChatId();
    }
    const chat = chatId ? storageService.getChat(chatId) : undefined;
    if (chat) {
      activateChat(chat);
    }
  };
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(activateActiveEditorChat),
    vscode.window.tabGroups.onDidChangeTabGroups(activateActiveEditorChat),
    vscode.window.onDidChangeActiveTerminal((terminal) => {
      // The retitle pass activates restored tabs to rename them; that is not
      // a user focus change and must not move the selection.
      if (!terminal || terminalManager.consumeBackgroundActivation(terminal)) {
        return;
      }
      const chatId = terminalManager.getChatIdForTerminal(terminal);
      const chat = chatId ? storageService.getChat(chatId) : undefined;
      if (chat) {
        activateChat(chat);
      }
    }),
    harnessWatcherRegistry.onChatNameUpdated(() => workspacesProvider.softRefresh()),
    // The importer pauses its discovery pass while the view is hidden.
    workspacesTreeView.onDidChangeVisibility((event) => {
      if (event.visible) {
        sessionImporter.wake();
      }
    }),
    workspacesTreeView.onDidChangeSelection(({ selection: [selected] }) => {
      if (!selected) {
        return;
      }
      let worktree: Worktree | undefined;
      if (selected.itemType === 'chat') {
        const chat = selected.data as ChatSession;
        storageService.setActiveChatId(chat.id);
        worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
      } else {
        // A plain folder row stands in for its root worktree; a git
        // repository row has none.
        worktree = workspacesProvider.getWorktreeForItem(selected);
      }
      if (!worktree) {
        return;
      }
      showWorktree(worktree);
      // Switching the folder restarts the extension host; activation then
      // restores this worktree from the new first folder.
      if (config().get<boolean>('autoSwitchWorkspaceFolder', false)) {
        switchWorkspaceFolder(worktree.path);
      }
    })
  );
  for (const adapter of harnessRegistry.all()) {
    const surfaces = adapter.nativeUi?.surfaces;
    if (surfaces) {
      context.subscriptions.push(surfaces.onDidChange(() => workspacesProvider.softRefresh()));
    }
  }

  // Start on the worktree that matches the open workspace folder. Reveal is
  // best-effort: the row may not have rendered yet.
  const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const startWorktree = folderPath ? workspacesProvider.findWorktreeByPath(folderPath) : undefined;
  if (startWorktree) {
    showWorktree(startWorktree);
    const reveal = () =>
      setTimeout(() => {
        void workspacesTreeView
          .reveal(workspacesProvider.getTreeItemForWorktree(startWorktree), { select: true, focus: false, expand: true })
          .then(undefined, () => undefined);
      }, 100);
    if (workspacesTreeView.visible) {
      reveal();
    } else {
      const once = workspacesTreeView.onDidChangeVisibility((event) => {
        if (event.visible) {
          once.dispose();
          reveal();
        }
      });
      context.subscriptions.push(once);
    }
  }

  context.subscriptions.push({
    dispose: () => {
      refreshPanels.cancel();
      worktreeWatcher?.dispose();
      attentionService.dispose();
      terminalManager.dispose();
      changesProvider.dispose();
      filesProvider.dispose();
      workspacesProvider.dispose();
      harnessWatcherRegistry.dispose();
      harnessRegistry.dispose();
    },
  });

  if (config().get<boolean>('focusOnStartup', false)) {
    void vscode.commands.executeCommand('workbench.view.extension.agntree');
  }
}

export function deactivate() {
  disposeOperationLog();
}
