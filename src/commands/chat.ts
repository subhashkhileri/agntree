import * as vscode from 'vscode';
import * as path from 'path';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessWatcherRegistry } from '../services/HarnessWatcherRegistry';
import { SessionImportService } from '../services/SessionImportService';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { ChangesTreeProvider, ChangeTreeItem, ChangeSectionItem } from '../providers/ChangesTreeProvider';
import { ChatSession, HarnessId, Worktree, generateId } from '../types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import {
  ForkResult,
  HarnessAdapter,
  HarnessSession,
  NativeUiCapability,
  NativeUiOpenResult,
  NativeUiUnavailable,
  SessionMetadata,
} from '../harnesses/types';
import { harnessIconPath } from '../harnesses/treeIcons';
import {
  chatPrimarySessionId,
  harnessSessionKey,
  lastExchange,
  sessionDisplayName,
  sessionUsageLine,
} from '../harnesses/sessionUtils';
import {
  clampInlineText,
  errorMessage,
  formatRelativeTime,
  nextForkName,
} from '../utils/text';
import { isStrictlyWithin, isWithin } from '../utils/paths';
import { logOperation } from '../services/OperationLog';

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
  harnessRegistry: HarnessRegistry,
  harnessWatcherRegistry: HarnessWatcherRegistry,
  sessionImporter: SessionImportService,
  activateChat: (chat: ChatSession) => void,
  refreshTree: () => void
): void {
  type SessionSurface = 'terminal' | 'ui';

  const defaultSessionSurface = (): SessionSurface =>
    vscode.workspace
      .getConfiguration('agntree')
      .get<SessionSurface>('defaultSessionSurface', 'terminal');

  const registerSessionCommand = (
    command: string,
    harness: HarnessId,
    surface?: SessionSurface
  ) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, (item?: WorkspaceTreeItem) =>
        createSession(item, harness, surface)
      )
    );
  };

  const pickWorktree = async (
    placeHolder: string
  ): Promise<Worktree | undefined> => {
    const repos = storageService.getRepositories();
    const allWorktrees: { label: string; description: string; worktree: Worktree }[] = [];

    for (const repo of repos) {
      const { isGit, worktrees } = gitService.listRepositoryWorktrees(
        repo.rootPath,
        repo.id
      );
      for (const wt of worktrees) {
        allWorktrees.push({
          // A plain folder is both the repository and its only worktree, so
          // showing "name / name" would just repeat itself.
          label: isGit ? `${repo.name} / ${wt.name}` : repo.name,
          description: wt.path,
          worktree: wt,
        });
      }
    }

    if (allWorktrees.length === 0) {
      vscode.window.showErrorMessage('No worktrees available. Add a folder first.');
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(allWorktrees, { placeHolder });
    return selected?.worktree;
  };

  /**
   * Persist a pending native ID when the harness accepts a chosen one and the
   * chat has none, then register the chat with its harness watcher. This also
   * migrates chats created before pending IDs existed; the minting branch can
   * be deleted once such chats are no longer expected.
   */
  const registerPendingSession = (
    chat: ChatSession,
    worktree: Worktree,
    pendingSessionId?: string
  ): ChatSession => {
    if (chat.harnessSessionId) {
      return chat;
    }

    // A chat that was waiting for a UI-created session is now starting in a
    // terminal; the importer must not claim a different session for it.
    let target = chat;
    if (chat.pendingUiLaunch) {
      sessionImporter.cancelExpectation(chat.id);
      target =
        storageService.updateChat(chat.id, { pendingUiLaunch: false }) ?? chat;
    }

    const chosenId =
      pendingSessionId ??
      target.pendingHarnessSessionId ??
      (harnessRegistry.get(target.harness).capabilities.newSessionId
        ? generateId()
        : undefined);
    const updated =
      chosenId && chosenId !== target.pendingHarnessSessionId
        ? storageService.updateChat(target.id, {
            pendingHarnessSessionId: chosenId,
          }) ?? target
        : target;

    harnessWatcherRegistry.registerPendingChat(
      updated.harness,
      updated.id,
      worktree.path
    );
    return updated;
  };

  /** Open a chat's terminal and make it the active row. */
  const launchTerminal = async (
    chat: ChatSession,
    worktree: Worktree
  ): Promise<void> => {
    await terminalManager.openChat(chat, worktree);
    changesProvider.setActiveChat(chat.id, worktree);
    storageService.touchChat(chat.id);
    refreshTree();
  };

  /**
   * Open a chat in its terminal. An existing terminal is focused; otherwise a
   * new one is launched (and registered for linkage when the harness assigns
   * its session ID later).
   */
  const openInTerminal = async (
    chat: ChatSession,
    worktree: Worktree
  ): Promise<void> => {
    const prepared = terminalManager.isActive(chat.id)
      ? chat
      : registerPendingSession(chat, worktree);
    await launchTerminal(prepared, worktree);
  };

  /**
   * Start a new session in the agent's VS Code UI. The extension assigns the
   * session ID and writes the transcript on the first prompt, so the chat is
   * created now and the importer links it when the native session appears.
   */
  const startSessionInNativeUi = async (
    worktree: Worktree,
    harness: HarnessId,
    nativeUi: NativeUiCapability
  ): Promise<void> => {
    const baseCommit = gitService.getCurrentCommit(worktree.path);
    const chat =
      storageService.createChat(
        worktree.id,
        'New Session',
        baseCommit,
        harness
      );
    storageService.updateChat(chat.id, { pendingUiLaunch: true });
    await sessionImporter.expectChat(chat.id, worktree.path, {
      bindSurface: true,
    });

    changesProvider.setActiveChat(chat.id, worktree);
    storageService.touchChat(chat.id);
    refreshTree();

    let result: NativeUiOpenResult;
    try {
      result = await nativeUi.openNewSession(worktree.path);
    } catch (error) {
      result = { kind: 'failed', message: errorMessage(error) };
    }

    if (result.kind === 'opened') {
      vscode.window.showInformationMessage(
        `Opened a new ${nativeUi.displayName} conversation for ${worktree.name}. Send your first prompt there; Agntree will link the session.`
      );
      return;
    }

    // The conversation never opened. Drop the placeholder rather than leaving
    // an unlinked row behind: as a closed terminal would, and so it cannot
    // reserve (or later be renamed from) a session the user did not start.
    sessionImporter.cancelExpectation(chat.id);
    storageService.deleteChat(chat.id, { rememberSession: false });
    if (storageService.getActiveChatId() === chat.id) {
      storageService.setActiveChatId(undefined);
      changesProvider.setActiveChat(undefined);
    }
    refreshTree();
    if (result.kind === 'failed') {
      vscode.window.showErrorMessage(
        `Could not open the ${nativeUi.displayName}: ${result.message}`
      );
    } else {
      await explainNativeUiUnavailable(
        nativeUi.displayName,
        worktree.path,
        result,
        nativeUi.extensionId
      );
    }
  };

  const createSession = async (
    item: WorkspaceTreeItem | undefined,
    harness: HarnessId,
    surface?: SessionSurface
  ): Promise<void> => {
    // Only the explicit "In Terminal"/"In UI" commands name a surface; the
    // plain New Session command follows the configured default.
    const explicit = surface !== undefined;
    let worktree: Worktree | undefined =
      workspacesProvider.getWorktreeForItem(item);

    if (!worktree) {
      worktree = await pickWorktree('Select worktree for new session');
    }

    if (!worktree) {
      return;
    }

    const target = surface ?? defaultSessionSurface();
    if (target === 'ui') {
      const adapter = harnessRegistry.get(harness);
      const nativeUi = adapter.nativeUi;
      if (!nativeUi) {
        if (explicit) {
          vscode.window.showInformationMessage(
            `${adapter.displayName} sessions do not have a VS Code UI.`
          );
          return;
        }
      } else {
        const availability = nativeUi.checkNewSessionAvailability(
          worktree.path
        );
        if (availability.kind === 'available') {
          await startSessionInNativeUi(worktree, harness, nativeUi);
          return;
        }

        if (explicit) {
          await explainNativeUiUnavailable(
            nativeUi.displayName,
            worktree.path,
            availability,
            nativeUi.extensionId
          );
          return;
        }
        // The default surface is a preference: when the UI cannot start this
        // worktree, keep the action useful by launching the terminal.
      }
    }

    const adapter = harnessRegistry.get(harness);
    if (!(await adapter.isInstalled())) {
      vscode.window.showErrorMessage(noHarnessInstalledMessage());
      return;
    }

    // Get current commit for change tracking
    const baseCommit = gitService.getCurrentCommit(worktree.path);

    // Create the chat immediately with a temporary name
    // The name will be auto-updated when a summary or first prompt is available
    const chat = storageService.createChat(
      worktree.id,
      'New Session',
      baseCommit,
      harness
    );

    // A harness that accepts a chosen ID gets one now, so the transcript is
    // linked deterministically when the first prompt creates it.
    const preparedChat = registerPendingSession(chat, worktree);

    await launchTerminal(preparedChat, worktree);
  };

  const openForkedSession = async (
    forkedChat: ChatSession,
    worktree: Worktree,
    sourceSessionId: string,
    fork: ForkResult
  ): Promise<void> => {
    if (fork.kind === 'linked') {
      const linkedChat =
        storageService.updateChat(forkedChat.id, {
          harnessSessionId: fork.sessionId,
        }) ?? forkedChat;
      await terminalManager.openChat(linkedChat, worktree);
      return;
    }

    // The harness forks in the terminal under the chosen ID; its watcher links
    // the transcript once the native session is written. Keep the source so a
    // reopen before the first prompt repeats the fork.
    const forked =
      storageService.updateChat(forkedChat.id, {
        forkedFromSessionId: sourceSessionId,
      }) ?? forkedChat;
    const pendingChat = registerPendingSession(
      forked,
      worktree,
      fork.pendingSessionId
    );
    await terminalManager.openChat(pendingChat, worktree);
  };

  const noHarnessInstalledMessage = (): string =>
    `No supported harnesses detected. Install one of: ${harnessRegistry
      .all()
      .map((adapter) => adapter.displayName)
      .join(', ')}.`;

  /** Resolve a chat from a tree row, or from the last selected chat. */
  const resolveChat = (item?: WorkspaceTreeItem): ChatSession | undefined => {
    if (item?.itemType === 'chat') {
      return item.data as ChatSession;
    }
    const activeId = storageService.getActiveChatId();
    return activeId ? storageService.getChat(activeId) : undefined;
  };

  /**
   * Reveal a chat that is already open in its native UI, so a row click
   * focuses that panel instead of launching a second agent process. Returns
   * true when the click was handled, including when the reveal was reported
   * as an error: a CLI must not start while the panel is still open.
   *
   * A live terminal stays the surface a row click focuses; the panel can stay
   * open beside it without a second process.
   */
  const revealOpenNativeUi = async (
    chat: ChatSession,
    worktree: Worktree
  ): Promise<boolean> => {
    const nativeUi = harnessRegistry.get(chat.harness).nativeUi;
    const sessionId = chatPrimarySessionId(chat);
    if (
      !nativeUi ||
      !sessionId ||
      !nativeUi.surfaces?.isOpen(sessionId) ||
      terminalManager.isActive(chat.id)
    ) {
      return false;
    }

    let result: NativeUiOpenResult;
    try {
      result = await nativeUi.openSession(sessionId, worktree.path);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Could not focus the ${nativeUi.displayName}: ${errorMessage(error)}`
      );
      return true;
    }

    if (result.kind === 'opened') {
      return true;
    }
    if (result.kind === 'failed') {
      vscode.window.showErrorMessage(
        `Could not focus the ${nativeUi.displayName}: ${result.message}`
      );
      return true;
    }
    await explainNativeUiUnavailable(
      nativeUi.displayName,
      worktree.path,
      result,
      nativeUi.extensionId
    );
    return true;
  };

  registerSessionCommand('agntree.newClaudeChat', 'claude');
  registerSessionCommand('agntree.newClaudeChatInTerminal', 'claude', 'terminal');
  registerSessionCommand('agntree.newClaudeChatInUi', 'claude', 'ui');
  registerSessionCommand('agntree.newOpencodeChat', 'opencode');
  registerSessionCommand('agntree.newCodexChat', 'codex');
  registerSessionCommand('agntree.newCodexChatInTerminal', 'codex', 'terminal');
  registerSessionCommand('agntree.newCodexChatInUi', 'codex', 'ui');
  // Backwards-compatible alias; hidden from menus.
  registerSessionCommand('agntree.newChat', 'claude');

  // Open Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openChat',
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

        await openChatPrimary(chat, worktree);
      }
    )
  );

  /**
   * Whether a row click can hand this chat to its native UI. A pending chat
   * has no session to open, and a live or starting terminal keeps priority.
   */
  const canOpenInNativeUi = (
    chat: ChatSession,
    worktree: Worktree
  ): boolean => {
    const adapter = harnessRegistry.get(chat.harness);
    const nativeUi = adapter.nativeUi;
    if (!nativeUi || !chat.harnessSessionId) {
      return false;
    }
    if (
      terminalManager.isActive(chat.id) ||
      terminalManager.isResuming(chat.id)
    ) {
      return false;
    }
    if (!nativeUi.isInstalled()) {
      return false;
    }
    return nativeUi.checkAvailability(worktree.path).kind === 'available';
  };

  /**
   * Hand an existing session to its harness's native UI. Shared by the
   * explicit Open in ... commands, the row-click default, and the terminal
   * command's reverse handoff.
   *
   * Returns true when the click was handled, including when the handoff
   * explained why it could not proceed: a CLI must not start while the panel
   * is still open.
   */
  const openChatInNativeUi = async (
    chat: ChatSession,
    worktree: Worktree
  ): Promise<void> => {
    const adapter = harnessRegistry.get(chat.harness);
    const nativeUi = adapter.nativeUi;
    const surfaces = nativeUi?.surfaces;
    if (!nativeUi) {
      return;
    }

    if (!nativeUi.isInstalled()) {
      await explainNativeUiUnavailable(
        nativeUi.displayName,
        worktree.path,
        { kind: 'not-installed' },
        nativeUi.extensionId
      );
      return;
    }

    // The UI extensions cannot adopt a chosen ID, so the handoff only covers a
    // session that already exists natively.
    const sessionId = chatPrimarySessionId(chat);
    if (!sessionId) {
      vscode.window.showInformationMessage(
        chat.pendingUiLaunch
          ? `This session is starting in ${nativeUi.displayName}. Send your first prompt there and Agntree will link it.`
          : `Start this session in the terminal first. ${nativeUi.displayName} can open it after its first prompt creates the session.`
      );
      return;
    }

    // Revealing a session that is already open needs neither a resume check
    // nor a terminal close.
    let open = surfaces?.isOpen(sessionId) ?? false;
    if (!open && terminalManager.isResuming(chat.id)) {
      vscode.window.showInformationMessage(
        'This session is still starting. Try again in a moment.'
      );
      return;
    }

    if (!open) {
      const resumable = await adapter.isSessionResumable(
        sessionId,
        worktree.path
      );
      // The panel may have opened while the native check was in flight. An
      // open panel is itself proof that the session exists.
      open = surfaces?.isOpen(sessionId) ?? false;
      if (!resumable && !open) {
        if (chat.harnessSessionId) {
          vscode.window.showWarningMessage(
            `The ${adapter.displayName} session no longer exists. It may have been removed.`
          );
        } else {
          vscode.window.showInformationMessage(
            `This session has no transcript yet. Send a prompt in the terminal first, then open it in ${nativeUi.displayName}.`
          );
        }
        return;
      }
    }

    // Preflight the extension and its folder before stopping a terminal: a
    // mismatch must not cost the user a running process.
    const availability = nativeUi.checkAvailability(worktree.path);
    if (availability.kind !== 'available') {
      await explainNativeUiUnavailable(
        nativeUi.displayName,
        worktree.path,
        availability,
        nativeUi.extensionId
      );
      return;
    }

    if (!open && terminalManager.isActive(chat.id)) {
      const confirm = await vscode.window.showWarningMessage(
        `Close the terminal for "${chat.name}"?\n\nThe running ${adapter.displayName} process stops. The conversation is preserved and will open in ${nativeUi.displayName}.`,
        { modal: true },
        'Close and Open'
      );
      if (confirm !== 'Close and Open') {
        return;
      }

      const closed = terminalManager.waitForChatClosed(chat.id);
      terminalManager.closeChat(chat.id);
      if (!(await closed)) {
        vscode.window.showErrorMessage(
          'Could not close the terminal for this session. Close it and try again.'
        );
        return;
      }
    }

    // Claude's tab carries only the title, so this expectation is what binds
    // the tab it creates. Codex's tab carries the thread ID; there the
    // expectation only helps bind the active tab after the command resolves.
    surfaces?.expect(sessionId, chat.name);
    let result: NativeUiOpenResult;
    try {
      result = await nativeUi.openSession(sessionId, worktree.path);
    } catch (error) {
      surfaces?.cancelExpect(sessionId);
      vscode.window.showErrorMessage(
        `Could not open the ${nativeUi.displayName}: ${errorMessage(error)}`
      );
      return;
    }

    if (result.kind === 'opened') {
      surfaces?.settle(sessionId, { allowActiveFallback: true });
      storageService.touchChat(chat.id);
      changesProvider.setActiveChat(chat.id, worktree);
      activateChat(chat);
      refreshTree();
      return;
    }
    surfaces?.cancelExpect(sessionId);
    if (result.kind === 'failed') {
      vscode.window.showErrorMessage(
        `Could not open the ${nativeUi.displayName}: ${result.message}`
      );
      return;
    }
    await explainNativeUiUnavailable(
      nativeUi.displayName,
      worktree.path,
      result,
      nativeUi.extensionId
    );
  };

  /**
   * Open a chat the way a row click does: focus its open native-UI panel, use
   * the configured UI default when it can, and otherwise keep it in the
   * terminal. Shared by the row click and the starred-session picker so both
   * obey the same "never two agent processes for one session" rule.
   */
  const openChatPrimary = async (
    chat: ChatSession,
    worktree: Worktree
  ): Promise<void> => {
    // A session already running in its agent's VS Code UI is focused, not
    // duplicated in a terminal. Without this, a click would start a CLI
    // process beside the open panel.
    if (await revealOpenNativeUi(chat, worktree)) {
      changesProvider.setActiveChat(chat.id, worktree);
      storageService.touchChat(chat.id);
      refreshTree();
      return;
    }

    // A UI-started chat has no native ID until the first prompt. Clicking it
    // must not launch a second agent beside the open conversation.
    if (chat.pendingUiLaunch && !terminalManager.isActive(chat.id)) {
      const nativeUi = harnessRegistry.get(chat.harness).nativeUi;
      vscode.window.showInformationMessage(
        nativeUi
          ? `This session is starting in ${nativeUi.displayName}. Send your first prompt there and Agntree will link it.`
          : 'This session is starting in its VS Code UI.'
      );
      return;
    }

    // The configured default is a preference: use the native UI when it can
    // open this session, otherwise keep the action useful.
    if (defaultSessionSurface() === 'ui' && canOpenInNativeUi(chat, worktree)) {
      await openChatInNativeUi(chat, worktree);
      return;
    }

    await openInTerminal(chat, worktree);
  };

  /**
   * Hand an existing session to its harness's native UI. The Claude and Codex
   * commands share this flow; only the command name and expected harness
   * differ.
   */
  const openNativeUi = async (
    item: WorkspaceTreeItem | undefined,
    expectedHarness: HarnessId
  ): Promise<void> => {
    const chat = resolveChat(item);
    if (!chat) {
      vscode.window.showInformationMessage('Select a session first.');
      return;
    }
    if (chat.harness !== expectedHarness) {
      vscode.window.showInformationMessage(
        `This is not a ${harnessRegistry.get(expectedHarness).displayName} session.`
      );
      return;
    }

    const adapter = harnessRegistry.get(chat.harness);
    if (!adapter.nativeUi) {
      vscode.window.showInformationMessage(
        `${adapter.displayName} sessions do not have a VS Code UI.`
      );
      return;
    }

    const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
    if (!worktree) {
      vscode.window.showErrorMessage(
        'Could not find worktree for this session.'
      );
      return;
    }

    await openChatInNativeUi(chat, worktree);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openClaudeUi',
      (item?: WorkspaceTreeItem) => openNativeUi(item, 'claude')
    ),
    vscode.commands.registerCommand(
      'agntree.openCodexUi',
      (item?: WorkspaceTreeItem) => openNativeUi(item, 'codex')
    )
  );

  /**
   * Explicitly open a session in its terminal. If the session is open in its
   * agent's UI, close that tab first so two agent processes cannot run.
   */
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.openChatInTerminal',
      async (item?: WorkspaceTreeItem) => {
        const chat = resolveChat(item);
        if (!chat) {
          vscode.window.showInformationMessage('Select a session first.');
          return;
        }

        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (!worktree) {
          vscode.window.showErrorMessage(
            'Could not find worktree for this session.'
          );
          return;
        }

        if (terminalManager.isActive(chat.id)) {
          await launchTerminal(chat, worktree);
          return;
        }

        if (chat.pendingUiLaunch) {
          const confirm = await vscode.window.showWarningMessage(
            `"${chat.name}" is starting in its VS Code UI. Starting it in a terminal may create two sessions.`,
            { modal: true },
            'Start in Terminal'
          );
          if (confirm !== 'Start in Terminal') {
            return;
          }
        }

        const adapter = harnessRegistry.get(chat.harness);
        const nativeUi = adapter.nativeUi;
        const sessionId = chatPrimarySessionId(chat);
        if (nativeUi && sessionId && nativeUi.surfaces?.isOpen(sessionId)) {
          const confirm = await vscode.window.showWarningMessage(
            `Close the ${nativeUi.displayName} tab for "${chat.name}"?\n\nThe UI session stops running. The conversation will resume in a terminal.`,
            { modal: true },
            'Close and Open'
          );
          if (confirm !== 'Close and Open') {
            return;
          }
          const closed = await nativeUi.surfaces.closeSurface(sessionId);
          if (!closed) {
            vscode.window.showErrorMessage(
              `Could not close the ${nativeUi.displayName} tab. Close it and try again.`
            );
            return;
          }
        }

        await openInTerminal(chat, worktree);
      }
    )
  );

  // Rename Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.renameChat',
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

        storageService.updateChat(chat.id, {
          name: newName,
          customName: true,
        });
        refreshTree();
      }
    )
  );

  // Close the running terminal for a chat (keeps it in the list)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.closeChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }
        const chat = item.data as ChatSession;
        terminalManager.closeChat(chat.id);
        refreshTree();
      }
    )
  );

  // Remove Chat from list (does not delete harness session data)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.deleteChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;
        const harnessName = harnessRegistry.get(chat.harness).displayName;

        const confirm = await vscode.window.showWarningMessage(
          `Remove "${chat.name}" from the list?\n\nThe session in ${harnessName} is preserved and can be re-imported later.`,
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

  // Clear All Sessions for Worktree
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.clearWorktreeSessions',
      async (item?: WorkspaceTreeItem) => {
        const worktree = workspacesProvider.getWorktreeForItem(item);
        if (!worktree) {
          return;
        }

        const chats = storageService.getChatsByWorktree(worktree.id);

        if (chats.length === 0) {
          vscode.window.showInformationMessage(`No sessions to clear for "${worktree.name}".`);
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Clear all ${chats.length} session(s) from "${worktree.name}"?\n\nThe harness sessions are preserved and can be re-imported later.`,
          { modal: true },
          'Clear All'
        );

        if (confirm !== 'Clear All') {
          return;
        }

        // Close any active terminals for these chats
        for (const chat of chats) {
          terminalManager.closeChat(chat.id);
        }

        // Delete all chats for this worktree
        const deletedIds = storageService.deleteChatsByWorktree(worktree.id);

        // Clear changes view if the active chat was in this worktree
        const activeChatId = storageService.getActiveChatId();
        if (activeChatId && deletedIds.includes(activeChatId)) {
          changesProvider.setActiveChat(undefined);
        }

        vscode.window.showInformationMessage(`Cleared ${deletedIds.length} session(s) from "${worktree.name}".`);
        refreshTree();
      }
    )
  );

  // Refresh Changes
  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.refreshChanges', () => {
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
      'agntree.openDiff',
      async (item?: ChangeTreeItem) => {
        if (!item || !(item instanceof ChangeTreeItem)) {
          return;
        }

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
            const existsInHead = gitService.existsInHead(
              item.worktreePath,
              item.change.path
            );

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
      'agntree.forkChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        // Must have a session ID to fork
        if (!chat.harnessSessionId) {
          vscode.window.showErrorMessage('Cannot fork a session that has not been started yet. Start the session first.');
          return;
        }

        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this session.');
          return;
        }

        const adapter = harnessRegistry.get(chat.harness);
        let fork: ForkResult;
        try {
          fork = await adapter.forkSession(
            chat.harnessSessionId,
            worktree.path
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to fork ${adapter.displayName} session: ${errorMessage(error)}`
          );
          return;
        }

        // Create a numbered fork name, unique within this worktree.
        const forkName = nextForkName(
          chat.name,
          storageService.getChatsByWorktree(worktree.id).map((entry) => entry.name)
        );
        const baseCommit = gitService.getCurrentCommit(worktree.path);
        const forkedChat = storageService.createChat(
          worktree.id,
          forkName,
          baseCommit,
          chat.harness
        );

        await openForkedSession(
          forkedChat,
          worktree,
          chat.harnessSessionId,
          fork
        );

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
      'agntree.forkChatWithChanges',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        // Must have a session ID to fork
        if (!chat.harnessSessionId) {
          vscode.window.showErrorMessage('Cannot fork a session that has not been started yet. Start the session first.');
          return;
        }

        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this session.');
          return;
        }

        if (!workspacesProvider.isGitWorktree(worktree)) {
          vscode.window.showInformationMessage(
            'This session lives in a plain folder, so there is no branch to fork into a worktree. Use Fork Session to fork it in the same folder.'
          );
          return;
        }

        const repo = storageService.getRepository(worktree.repoId);
        if (!repo) {
          vscode.window.showErrorMessage('Could not find repository for this worktree.');
          return;
        }

        const adapter = harnessRegistry.get(chat.harness);
        // Validate the source before prompting and creating a worktree; a
        // missing transcript would otherwise leave a new worktree behind and
        // fail only after the fork.
        if (
          !(await adapter.isSessionResumable(
            chat.harnessSessionId,
            worktree.path
          ))
        ) {
          vscode.window.showErrorMessage(
            `The ${adapter.displayName} session no longer exists.`
          );
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

        // Prepare the fork in the destination worktree. Claude forks into the
        // destination on the first prompt; opencode forks and moves the new
        // session; Codex forks into the destination cwd.
        let fork: ForkResult;
        try {
          fork = await adapter.prepareForkToNewWorktree(
            chat.harnessSessionId,
            worktree.path,
            worktreePath
          );
        } catch (error) {
          vscode.window.showErrorMessage(
            `Failed to fork the ${adapter.displayName} session into the new worktree: ${errorMessage(error)}`
          );
          return;
        }

        // Create a numbered fork name, unique within the new worktree.
        const forkName = nextForkName(
          chat.name,
          storageService.getChatsByWorktree(newWorktree.id).map((entry) => entry.name)
        );
        const forkedChat = storageService.createChat(
          newWorktree.id,
          forkName,
          currentCommit,
          chat.harness
        );

        await openForkedSession(
          forkedChat,
          newWorktree,
          chat.harnessSessionId,
          fork
        );

        // Update changes view
        changesProvider.setActiveChat(forkedChat.id, newWorktree);

        vscode.window.showInformationMessage(`Forked session to new worktree "${newBranchName}"`);
        refreshTree();
      }
    )
  );

  // Import Existing Sessions
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.importSessions',
      async (item?: WorkspaceTreeItem) => {
        let worktree: Worktree | undefined =
          workspacesProvider.getWorktreeForItem(item);

        if (!worktree) {
          worktree = await pickWorktree('Select worktree to import sessions for');
        }

        if (!worktree) {
          return;
        }
        const targetWorktree = worktree;

        const adapters = await harnessRegistry.getInstalled();
        if (adapters.length === 0) {
          vscode.window.showErrorMessage(noHarnessInstalledMessage());
          return;
        }

        const allSessions = await collectSessions(adapters, (adapter) =>
          adapter.listSessionsForWorktree(targetWorktree.path)
        );

        if (allSessions.length === 0) {
          vscode.window.showInformationMessage(
            `No existing sessions found for ${targetWorktree.name}.`
          );
          return;
        }

        // Filter out already imported sessions
        const existingChats = storageService.getChatsByWorktree(targetWorktree.id);
        const existingKeys = new Set(
          existingChats
            .filter((chat) => chat.harnessSessionId)
            .map((chat) => harnessSessionKey(chat.harness, chat.harnessSessionId!))
        );

        const availableSessions = allSessions.filter(
          ({ harness, session }) =>
            !existingKeys.has(harnessSessionKey(harness, session.sessionId))
        );

        if (availableSessions.length === 0) {
          vscode.window.showInformationMessage('All existing sessions have already been imported.');
          return;
        }

        // Show picker for sessions to import
        const sessionItems = availableSessions.map(({ harness, session }) => {
          const adapter = harnessRegistry.get(harness);
          const descParts = [adapter.displayName];
          if (session.gitBranch) {
            descParts.push(session.gitBranch);
          }
          const detailParts: string[] = [];
          if (session.lastUpdated) {
            detailParts.push(`Last updated: ${session.lastUpdated.toLocaleString()}`);
          }
          if (session.messageCount > 0) {
            detailParts.push(`${session.messageCount} messages`);
          }

          return {
            label: sessionDisplayName(session),
            description: descParts.join(' · '),
            detail: detailParts.join(' • ') || undefined,
            harness,
            session,
            picked: false,
          };
        });

        const selectedSessions = await vscode.window.showQuickPick(sessionItems, {
          placeHolder: 'Select sessions to import (multi-select with Space)',
          canPickMany: true,
        });

        if (!selectedSessions || selectedSessions.length === 0) {
          return;
        }

        // Import selected sessions
        let imported = 0;
        for (const selected of selectedSessions) {
          const { harness, session } = selected;
          const name = sessionDisplayName(session, 'Imported: ');

          storageService.createChatFromSession(
            targetWorktree.id,
            harness,
            name,
            session.sessionId,
            {
              createdAt: session.lastUpdated?.getTime() || Date.now(),
            }
          );
          // A manual import is the user undoing an earlier removal.
          storageService.forgetRemovedSession(harness, session.sessionId);

          imported++;
        }

        vscode.window.showInformationMessage(
          `Imported ${imported} session(s) for ${targetWorktree.name}`
        );
        refreshTree();
      }
    )
  );

  // Search Sessions (repository-level)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.searchSessions',
      async (item?: WorkspaceTreeItem) => {
        let repo: { id: string; name: string; rootPath: string } | undefined;

        if (item && item.itemType === 'repository') {
          repo = item.data as { id: string; name: string; rootPath: string };
        } else {
          // Show picker for repository
          const repos = storageService.getRepositories();
          if (repos.length === 0) {
            vscode.window.showErrorMessage('No repositories available. Add a repository first.');
            return;
          }

          if (repos.length === 1) {
            repo = repos[0];
          } else {
            const selected = await vscode.window.showQuickPick(
              repos.map(r => ({ label: r.name, description: r.rootPath, repo: r })),
              { placeHolder: 'Select repository to search sessions for' }
            );
            if (!selected) {
              return;
            }
            repo = selected.repo;
          }
        }

        // Gather all worktrees for this repository, including a plain folder
        // root so sessions started there are searchable too.
        const worktrees = gitService.listRepositoryWorktrees(
          repo.rootPath,
          repo.id
        ).worktrees;
        const worktreePaths = worktrees.map(wt => wt.path);

        const adapters = await harnessRegistry.getInstalled();
        if (adapters.length === 0) {
          vscode.window.showErrorMessage(noHarnessInstalledMessage());
          return;
        }

        // Find all sessions with progress indicator
        const allSessions = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Searching for agent sessions...',
          },
          () =>
            collectSessions(adapters, (adapter) =>
              adapter.listSessionsForRepository(repo!.rootPath, worktreePaths)
            )
        );

        if (allSessions.length === 0) {
          vscode.window.showInformationMessage(
            `No sessions found for "${repo.name}".`
          );
          return;
        }

        // Collect all existing sessions across all worktrees for this repo
        const existingKeys = new Set<string>();
        for (const wt of worktrees) {
          const chats = storageService.getChatsByWorktree(wt.id);
          for (const chat of chats) {
            if (chat.harnessSessionId) {
              existingKeys.add(harnessSessionKey(chat.harness, chat.harnessSessionId));
            }
          }
        }
        const isImported = ({ harness, session }: HarnessSessionEntry): boolean =>
          existingKeys.has(harnessSessionKey(harness, session.sessionId));

        // Match each session to a worktree by comparing cwd
        const matchSessionToWorktree = (session: { cwd: string }): Worktree => {
          const sessionCwd = path.resolve(session.cwd);
          // Find the worktree whose path best matches (longest match wins)
          let bestMatch: Worktree | undefined;
          let bestMatchLen = 0;
          for (const wt of worktrees) {
            const wtPath = path.resolve(wt.path);
            if (isWithin(sessionCwd, wtPath)) {
              if (wtPath.length > bestMatchLen) {
                bestMatch = wt;
                bestMatchLen = wtPath.length;
              }
            }
          }
          // Default to main worktree if no match
          return bestMatch || worktrees.find(wt => wt.isMain) || worktrees[0];
        };

        // Group ALL sessions by worktree (including already-imported)
        const sessionsByWorktree = new Map<string, { worktree: Worktree; entries: HarnessSessionEntry[] }>();
        for (const entry of allSessions) {
          const wt = matchSessionToWorktree(entry.session);
          if (!sessionsByWorktree.has(wt.id)) {
            sessionsByWorktree.set(wt.id, { worktree: wt, entries: [] });
          }
          sessionsByWorktree.get(wt.id)!.entries.push(entry);
        }

        // Build QuickPick items with separators grouped by worktree
        interface SessionQuickPickItem extends vscode.QuickPickItem {
          harness?: HarnessId;
          session?: HarnessSession;
          worktree?: Worktree;
          isImported?: boolean;
        }

        // Rows stay compact: name, recency, and size. The highlighted row
        // expands into a short brief instead of repeating five prompts under
        // every row (which made the list several screens tall).
        const harnessIcon = (adapter: HarnessAdapter): vscode.IconPath =>
          harnessIconPath(context.extensionUri, adapter, 'closed');

        const quickPickItems: SessionQuickPickItem[] = [];
        const groups = [...sessionsByWorktree.values()].sort((a, b) => {
          if (a.worktree.isMain !== b.worktree.isMain) {
            return a.worktree.isMain ? -1 : 1;
          }
          return a.worktree.name.localeCompare(b.worktree.name);
        });

        for (const { worktree: wt, entries } of groups) {
          quickPickItems.push({
            label: `${wt.name}${wt.isMain ? ' (main)' : ''}`,
            kind: vscode.QuickPickItemKind.Separator,
          });

          for (const entry of entries) {
            const { harness, session } = entry;
            const imported = isImported(entry);

            // The group header already names the branch, and the mark carries
            // the harness, so the row only needs recency and size.
            const description: string[] = [];
            if (session.lastUpdated) {
              description.push(formatRelativeTime(session.lastUpdated, { absoluteAfterDays: 30 }));
            }
            if (session.messageCount > 0) {
              description.push(`${session.messageCount} msgs`);
            }

            quickPickItems.push({
              label: `${imported ? '$(check) ' : ''}${sessionDisplayName(session)}`,
              description: description.join(' · '),
              iconPath: harnessIcon(harnessRegistry.get(harness)),
              harness,
              session,
              worktree: wt,
              isImported: imported,
            });
          }
        }

        // Create enhanced QuickPick (single-select)
        const quickPick = vscode.window.createQuickPick<SessionQuickPickItem>();
        quickPick.items = quickPickItems;
        quickPick.placeholder =
          'Select a session to import — highlight a row for details';
        quickPick.title = `Search Sessions — ${repo.name}`;
        quickPick.matchOnDescription = true;
        // Detail is only populated for the highlighted row, so matching on it
        // would hide every row the user has not visited yet.
        quickPick.matchOnDetail = false;

        const detailCache = new Map<string, string | undefined>();
        const detailRequests = new Set<string>();
        let expandedItem: SessionQuickPickItem | undefined;
        let suppressActiveEvent = false;
        let disposed = false;

        const paintDetail = (
          item: SessionQuickPickItem,
          detail: string | undefined
        ): void => {
          if (expandedItem === item && item.detail === detail) {
            return;
          }
          if (expandedItem && expandedItem !== item) {
            expandedItem.detail = undefined;
          }
          item.detail = detail;
          expandedItem = detail ? item : undefined;

          // Detail text is painted from the item list, not from mutating the
          // object alone, so replace the array (same items and order).
          suppressActiveEvent = true;
          quickPick.items = [...quickPick.items];
          suppressActiveEvent = false;
        };

        const buildDetail = (
          adapter: HarnessAdapter,
          session: HarnessSession,
          meta: SessionMetadata | null
        ): string | undefined => {
          const lines: string[] = [];
          const { lastAsk, lastReply } = lastExchange(meta);

          if (lastAsk) {
            lines.push(`You: ${clampInlineText(lastAsk.text, 160)}`);
            if (lastReply) {
              lines.push(
                `${adapter.displayName}: ${clampInlineText(lastReply.text, 160)}`
              );
            }
          }

          const usage = sessionUsageLine(meta, session);
          if (usage) {
            lines.push(usage);
          }

          return lines.length > 0 ? lines.join('\n') : undefined;
        };

        const loadDetail = async (item: SessionQuickPickItem): Promise<void> => {
          const session = item.session;
          const harness = item.harness;
          if (!session || !harness) {
            return;
          }
          const key = harnessSessionKey(harness, session.sessionId);
          if (detailCache.has(key) || detailRequests.has(key)) {
            return;
          }

          detailRequests.add(key);
          const adapter = harnessRegistry.get(harness);
          try {
            let meta = await adapter.getSessionMetadata(session.sessionId, session.cwd);
            // opencode builds previews from an export; fetch it once, then
            // re-read the metadata so the reply/message count come along.
            if (
              meta &&
              meta.preview.length === 0 &&
              adapter.capabilities.preview === 'lazy'
            ) {
              await adapter.getPreview(session.sessionId, 3);
              meta =
                (await adapter.getSessionMetadata(session.sessionId, session.cwd)) ??
                meta;
            }
            const detail = buildDetail(adapter, session, meta);
            detailCache.set(key, detail);
            if (!disposed && quickPick.activeItems[0] === item) {
              paintDetail(item, detail);
            }
          } catch {
            // A broken session still needs a selectable row; don't retry on
            // every highlight.
            detailCache.set(key, undefined);
          } finally {
            detailRequests.delete(key);
          }
        };

        quickPick.onDidChangeActive((activeItems) => {
          if (disposed || suppressActiveEvent) {
            return;
          }
          const active = activeItems[0];
          if (!active?.session || !active.harness) {
            return;
          }

          const key = harnessSessionKey(active.harness, active.session.sessionId);
          if (detailCache.has(key)) {
            paintDetail(active, detailCache.get(key));
            return;
          }

          // Collapse the previous row now; the new row expands when its
          // metadata (and, for opencode, the export) is ready.
          if (expandedItem && expandedItem !== active) {
            paintDetail(expandedItem, undefined);
          }
          void loadDetail(active);
        });

        const selected = await new Promise<SessionQuickPickItem | undefined>(resolve => {
          quickPick.onDidAccept(() => {
            resolve(quickPick.activeItems[0]);
            quickPick.dispose();
          });
          quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
          });
          quickPick.show();
        });
        disposed = true;

        if (!selected) {
          return;
        }

        if (
          selected.isImported ||
          !selected.session ||
          !selected.worktree ||
          !selected.harness
        ) {
          vscode.window.showInformationMessage('That session is already imported.');
          return;
        }

        const session = selected.session;
        const harness = selected.harness;
        const targetWorktree = selected.worktree;
        const name = sessionDisplayName(session, 'Imported: ');

        storageService.createChatFromSession(
          targetWorktree.id,
          harness,
          name,
          session.sessionId,
          {
            createdAt: session.lastUpdated?.getTime() || Date.now(),
          }
        );
        // A manual import is the user undoing an earlier removal, exactly as
        // **Import Existing Sessions** treats it.
        storageService.forgetRemovedSession(harness, session.sessionId);

        vscode.window.showInformationMessage(
          `Imported session to ${targetWorktree.name}`
        );
        refreshTree();
      }
    )
  );

  // Stage File
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.stageFile',
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
      'agntree.unstageFile',
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
      'agntree.discardFile',
      async (item?: ChangeTreeItem) => {
        if (!item || !(item instanceof ChangeTreeItem)) {
          return;
        }

        const fullPath = path.resolve(item.worktreePath, item.change.path);
        if (!isStrictlyWithin(fullPath, item.worktreePath)) {
          vscode.window.showErrorMessage('Refusing to discard a path outside the worktree.');
          logOperation(`Refused discard outside worktree: ${fullPath}`);
          return;
        }

        // Untracked files are deleted, not restored, so they get a clear
        // confirmation and go to the Trash instead of vanishing.
        const tracked = gitService.isTracked(item.worktreePath, item.change.path);
        const confirm = await vscode.window.showWarningMessage(
          tracked
            ? `Discard changes to "${item.change.path}"? This cannot be undone.`
            : `Move untracked file "${item.change.path}" to the Trash?`,
          { modal: true },
          'Discard'
        );

        if (confirm !== 'Discard') {
          return;
        }

        let success: boolean;
        if (tracked) {
          success = gitService.discardFile(item.worktreePath, item.change.path);
        } else {
          try {
            await vscode.workspace.fs.delete(vscode.Uri.file(fullPath), {
              useTrash: true,
            });
            success = true;
          } catch {
            success = false;
          }
        }

        if (success) {
          logOperation(
            tracked
              ? `Discarded changes: ${item.change.path}`
              : `Moved untracked file to Trash: ${item.change.path}`
          );
          changesProvider.refresh();
        } else {
          logOperation(`Discard failed: ${item.change.path}`);
          vscode.window.showErrorMessage(`Failed to discard changes to ${item.change.path}`);
        }
      }
    )
  );

  // Discard All Changes
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.discardAll',
      async (item?: ChangeSectionItem) => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          return;
        }

        // Spell out what `git clean` is about to delete; untracked files do
        // not go to the Trash.
        const summary = gitService.getDiscardSummary(worktree.path);
        const counts: string[] = [];
        if (summary.tracked > 0) {
          counts.push(
            `${summary.tracked} modified file${summary.tracked === 1 ? '' : 's'}`
          );
        }
        if (summary.untracked.length > 0) {
          counts.push(
            `${summary.untracked.length} untracked file${summary.untracked.length === 1 ? '' : 's'} or folder${summary.untracked.length === 1 ? '' : 's'}`
          );
        }

        const message =
          counts.length > 0
            ? `Discard ${counts.join(' and ')} in "${worktree.name}"?\n\nUntracked files and folders are permanently deleted. This cannot be undone.`
            : `Discard all unstaged changes in "${worktree.name}"? This cannot be undone.`;

        const confirm = await vscode.window.showWarningMessage(
          message,
          { modal: true },
          'Discard All'
        );

        if (confirm !== 'Discard All') {
          return;
        }

        const success = gitService.discardAll(worktree.path);
        if (success) {
          const preview = summary.untracked.slice(0, 20).join(', ');
          const suffix =
            summary.untracked.length > 20
              ? `${preview}, … (${summary.untracked.length - 20} more)`
              : preview;
          logOperation(
            `Discarded ${summary.tracked} tracked change(s) in ${worktree.path}` +
              (summary.untracked.length > 0
                ? `; deleted untracked: ${suffix}`
                : '')
          );
          changesProvider.refresh();
        } else {
          logOperation(`Discard-all failed in ${worktree.path}`);
          vscode.window.showErrorMessage('Failed to discard all changes');
        }
      }
    )
  );

  // Stage All Changes
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.stageAll',
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
      'agntree.unstageAll',
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

  // Rebase Continue
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.rebaseContinue',
      async () => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          vscode.window.showErrorMessage('No active worktree selected.');
          return;
        }

        if (!gitService.isRebaseInProgress(worktree.path)) {
          vscode.window.showInformationMessage('No rebase in progress.');
          return;
        }

        const result = gitService.rebaseContinue(worktree.path);
        if (result.success) {
          if (gitService.isRebaseInProgress(worktree.path)) {
            vscode.window.showWarningMessage(
              'Rebase continued but more conflicts were encountered. Resolve and continue.'
            );
          } else {
            vscode.window.showInformationMessage('Rebase completed successfully.');
            refreshTree();
          }
        } else {
          vscode.window.showErrorMessage(
            `Failed to continue rebase: ${result.error || 'Unknown error'}`
          );
        }
        changesProvider.refresh();
      }
    )
  );

  // Rebase Abort
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.rebaseAbort',
      async () => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          vscode.window.showErrorMessage('No active worktree selected.');
          return;
        }

        if (!gitService.isRebaseInProgress(worktree.path)) {
          vscode.window.showInformationMessage('No rebase in progress.');
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          'Abort the current rebase? This will restore the branch to its original state.',
          { modal: true },
          'Abort Rebase'
        );

        if (confirm !== 'Abort Rebase') {
          return;
        }

        const success = gitService.rebaseAbort(worktree.path);
        if (success) {
          vscode.window.showInformationMessage('Rebase aborted.');
          refreshTree();
        } else {
          vscode.window.showErrorMessage('Failed to abort rebase.');
        }
        changesProvider.refresh();
      }
    )
  );

  // Rebase Skip
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.rebaseSkip',
      async () => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          vscode.window.showErrorMessage('No active worktree selected.');
          return;
        }

        if (!gitService.isRebaseInProgress(worktree.path)) {
          vscode.window.showInformationMessage('No rebase in progress.');
          return;
        }

        const result = gitService.rebaseSkip(worktree.path);
        if (result.success) {
          if (gitService.isRebaseInProgress(worktree.path)) {
            vscode.window.showWarningMessage(
              'Commit skipped but rebase is still in progress.'
            );
          } else {
            vscode.window.showInformationMessage('Rebase completed after skipping.');
            refreshTree();
          }
        } else {
          vscode.window.showErrorMessage(
            `Failed to skip: ${result.error || 'Unknown error'}`
          );
        }
        changesProvider.refresh();
      }
    )
  );

  // Toggle Star on Session
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.toggleStarChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }
        const chat = item.data as ChatSession;
        storageService.toggleStar(chat.id);
        refreshTree();
      }
    )
  );

  // Show Starred Sessions (global QuickPick)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.showStarredSessions',
      async () => {
        const starredChats = storageService.getStarredChats();

        if (starredChats.length === 0) {
          vscode.window.showInformationMessage('No starred sessions. Star a session from the tree view to bookmark it.');
          return;
        }

        // Group chats by repository
        const repos = storageService.getRepositories(true);
        const multiHarness = await harnessRegistry.hasMultipleInstalled();

        // Build worktree lookup: worktreeId → { worktree, repo }
        const worktreeLookup = new Map<string, { worktree: Worktree; repoName: string }>();
        for (const repo of repos) {
          const { worktrees } = gitService.listRepositoryWorktrees(
            repo.rootPath,
            repo.id
          );
          for (const wt of worktrees) {
            worktreeLookup.set(wt.id, { worktree: wt, repoName: repo.name });
          }
        }

        // Group starred chats by repo
        const groupedByRepo = new Map<string, { repoName: string; chats: { chat: ChatSession; worktreeName: string }[] }>();

        for (const chat of starredChats) {
          const info = worktreeLookup.get(chat.worktreeId);
          const repoName = info?.repoName || 'Unknown';
          const worktreeName = info?.worktree.name || 'unknown';
          const repoKey = info?.worktree.repoId || 'unknown';

          if (!groupedByRepo.has(repoKey)) {
            groupedByRepo.set(repoKey, { repoName, chats: [] });
          }
          groupedByRepo.get(repoKey)!.chats.push({ chat, worktreeName });
        }

        // Build QuickPick items with separators
        interface StarredQuickPickItem extends vscode.QuickPickItem {
          chatId?: string;
        }

        const items: StarredQuickPickItem[] = [];

        for (const [, group] of groupedByRepo) {
          items.push({
            label: group.repoName,
            kind: vscode.QuickPickItemKind.Separator,
          });

          // Sort by lastAccessedAt descending within each group
          group.chats.sort((a, b) => b.chat.lastAccessedAt - a.chat.lastAccessedAt);

          for (const { chat, worktreeName } of group.chats) {
            const relativeTime = formatRelativeTime(chat.lastAccessedAt, { absoluteAfterDays: 30 });
            const harnessLabel = multiHarness
              ? ` · ${harnessRegistry.get(chat.harness).displayName}`
              : '';
            items.push({
              label: `$(star-full) ${chat.name}`,
              description: `${relativeTime} · ${worktreeName}${harnessLabel}`,
              chatId: chat.id,
            });
          }
        }

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select a starred session to open',
          matchOnDescription: true,
        });

        if (!selected?.chatId) {
          return;
        }

        const chat = storageService.getChat(selected.chatId);
        if (!chat) {
          return;
        }

        const worktreeInfo = worktreeLookup.get(chat.worktreeId);
        if (!worktreeInfo) {
          vscode.window.showErrorMessage('Worktree for this session no longer exists.');
          return;
        }

        // Open the session the way a row click does, so an open UI panel is
        // focused instead of launching a second agent beside it.
        await openChatPrimary(chat, worktreeInfo.worktree);
        storageService.touchChat(chat.id);
        refreshTree();
      }
    )
  );

}

interface HarnessSessionEntry {
  harness: HarnessId;
  session: HarnessSession;
}

/**
 * Query every installed harness in parallel and flatten the results.
 * A harness that throws is logged and skipped so one bad adapter cannot
 * break session import/search.
 */
async function collectSessions(
  adapters: HarnessAdapter[],
  listFor: (adapter: HarnessAdapter) => Promise<HarnessSession[]>
): Promise<HarnessSessionEntry[]> {
  const entries: HarnessSessionEntry[] = [];
  await Promise.all(
    adapters.map(async (adapter) => {
      try {
        const sessions = await listFor(adapter);
        for (const session of sessions) {
          entries.push({ harness: adapter.id, session });
        }
      } catch (error) {
        console.error(`Failed to list ${adapter.displayName} sessions:`, error);
      }
    })
  );
  entries.sort(
    (a, b) =>
      (b.session.lastUpdated?.getTime() ?? 0) -
      (a.session.lastUpdated?.getTime() ?? 0)
  );
  return entries;
}

/**
 * Explain why a native-UI handoff cannot proceed. A worktree mismatch offers
 * to open that worktree in a new window, where it becomes the first folder and
 * the handoff is safe.
 */
async function explainNativeUiUnavailable(
  displayName: string,
  worktreePath: string,
  result: NativeUiUnavailable,
  extensionId: string
): Promise<void> {
  switch (result.kind) {
    case 'not-installed': {
      const choice = await vscode.window.showInformationMessage(
        `The ${displayName} extension is not installed. Install it to use the ${displayName}.`,
        'Find Extension'
      );
      if (choice === 'Find Extension') {
        try {
          await vscode.commands.executeCommand(
            'workbench.extensions.search',
            `@id:${extensionId}`
          );
        } catch {
          // The Extensions view is unavailable in some hosts; the message
          // above still tells the user what to install.
        }
      }
      return;
    }
    case 'no-workspace':
      vscode.window.showInformationMessage(
        `Open a folder in VS Code before using ${displayName}.`
      );
      return;
    case 'workspace-mismatch':
    case 'workspace-multi-root': {
      const message =
        result.kind === 'workspace-mismatch'
          ? `${displayName} runs in the first folder open in VS Code:\n${result.uiCwd}\n\nThis session belongs to:\n${worktreePath}\n\nOpen that worktree in a new window, where ${displayName} can use it.`
          : `${displayName} starts new sessions in the whole VS Code workspace, not one folder.\n\nOpen this worktree as the only folder in a window:\n${worktreePath}`;
      const choice = await vscode.window.showWarningMessage(
        message,
        'Open in New Window'
      );
      if (choice === 'Open in New Window') {
        await openWorktreeInNewWindow(worktreePath);
      }
      return;
    }
  }
}

async function openWorktreeInNewWindow(worktreePath: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(worktreePath),
      { forceNewWindow: true }
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Could not open the worktree in a new window: ${errorMessage(error)}`
    );
  }
}

