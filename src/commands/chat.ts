import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessWatcherRegistry } from '../services/HarnessWatcherRegistry';
import { SessionImportService } from '../services/SessionImportService';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { ChatSession, HarnessId, Worktree, generateId } from '../types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import {
  ForkResult,
  NativeUiCapability,
  NativeUiOpenResult,
  NativeUiUnavailable,
} from '../harnesses/types';
import { DEFAULT_CHAT_NAME, chatPrimarySessionId } from '../harnesses/sessionUtils';
import { errorMessage, formatRelativeTime, nextForkName } from '../utils/text';
import { canonicalPath } from '../utils/paths';
import {
  commandRegistrar,
  defaultWorktreePath,
  noHarnessInstalledMessage,
  pickWorktree,
  promptNewBranchName,
} from './common';

type SessionSurface = 'terminal' | 'ui';
type LinkedChat = ChatSession & { harnessSessionId: string };

export interface ChatCommandDeps {
  storageService: StorageService;
  gitService: GitService;
  terminalManager: TerminalManager;
  workspacesProvider: Pick<
    WorkspacesTreeProvider,
    'getWorktreeById' | 'getWorktreeForItem' | 'isGitWorktree'
  >;
  harnessRegistry: HarnessRegistry;
  harnessWatcherRegistry: Pick<HarnessWatcherRegistry, 'registerPendingChat'>;
  sessionImporter: Pick<SessionImportService, 'expectChat' | 'cancelExpectation'>;
  /** Select a chat's row and point the worktree panels at it. */
  activateChat: (chat: ChatSession) => void;
  /** Point the Changes and Files panels at a worktree. */
  showWorktree: (worktree: Worktree) => void;
  /** Close chats' terminals, delete their rows, and clear the selection if it was one of them. */
  removeChats: (chatIds: string[], options?: { rememberSession?: boolean }) => string[];
  refreshTree: () => void;
}

/**
 * Register the session commands: create, open (terminal or native UI),
 * rename, close, remove, fork, and star.
 *
 * Commands stay harness-agnostic. Per-harness commands are derived from the
 * registry, and behavior that differs by harness comes from the adapter.
 */
export function registerChatCommands(
  context: vscode.ExtensionContext,
  deps: ChatCommandDeps
): void {
  const {
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
  } = deps;

  const register = commandRegistrar(context);

  const defaultSessionSurface = (): SessionSurface =>
    vscode.workspace
      .getConfiguration('agntree')
      .get<SessionSurface>('defaultSessionSurface', 'terminal');

  /** The chat on a session row. */
  const rowChat = (item?: WorkspaceTreeItem): ChatSession | undefined =>
    item?.itemType === 'chat' ? (item.data as ChatSession) : undefined;

  /** The chat on a session row, or the selected chat for a palette command. */
  const resolveChat = (item?: WorkspaceTreeItem): ChatSession | undefined => {
    const chat = rowChat(item);
    if (chat) {
      return chat;
    }
    const activeId = storageService.getActiveChatId();
    const active = activeId ? storageService.getChat(activeId) : undefined;
    if (!active) {
      vscode.window.showInformationMessage('Select a session first.');
    }
    return active;
  };

  /** The worktree a chat runs in, or an error when it no longer exists. */
  const chatWorktree = (chat: ChatSession): Worktree | undefined => {
    const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
    if (!worktree) {
      vscode.window.showErrorMessage('Could not find worktree for this session.');
    }
    return worktree;
  };

  /** Make a chat the active row after opening it. */
  const selectChat = (chat: ChatSession, worktree: Worktree): void => {
    showWorktree(worktree);
    storageService.touchChat(chat.id);
    refreshTree();
  };

  /**
   * Persist a pending native ID when the harness accepts a chosen one and the
   * chat has none, then register the chat with its harness watcher. This also
   * gives a chat created before pending IDs existed its ID on first open.
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
      target = storageService.updateChat(chat.id, { pendingUiLaunch: false }) ?? chat;
    }

    const chosenId =
      pendingSessionId ??
      target.pendingHarnessSessionId ??
      (harnessRegistry.get(target.harness).capabilities.newSessionId
        ? generateId()
        : undefined);
    const updated =
      chosenId && chosenId !== target.pendingHarnessSessionId
        ? storageService.updateChat(target.id, { pendingHarnessSessionId: chosenId }) ?? target
        : target;

    harnessWatcherRegistry.registerPendingChat(updated.harness, updated.id, worktree.path);
    return updated;
  };

  /**
   * Open a chat in its terminal. A live terminal is focused; otherwise a new
   * one is launched and registered for linkage when the harness assigns its
   * session ID later.
   */
  const openInTerminal = async (chat: ChatSession, worktree: Worktree): Promise<void> => {
    const prepared = terminalManager.isActive(chat.id)
      ? chat
      : registerPendingSession(chat, worktree);
    await terminalManager.openChat(prepared, worktree);
    selectChat(prepared, worktree);
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
    const chat = storageService.createChat(worktree.id, harness, DEFAULT_CHAT_NAME, { pendingUiLaunch: true });
    await sessionImporter.expectChat(chat.id, worktree.path, { bindSurface: true });
    selectChat(chat, worktree);

    const result = await tryOpen(() => nativeUi.openNewSession(worktree.path));
    if (result.kind === 'opened') {
      vscode.window.showInformationMessage(
        `Opened a new ${nativeUi.displayName} conversation for ${worktree.name}. Send your first prompt there; Agntree will link the session.`
      );
      return;
    }

    // The conversation never opened. Drop the placeholder rather than leave an
    // unlinked row that could reserve (or be renamed from) a session the user
    // did not start.
    sessionImporter.cancelExpectation(chat.id);
    removeChats([chat.id], { rememberSession: false });
    refreshTree();
    await reportNativeUiProblem(nativeUi, worktree.path, result);
  };

  const createSession = async (
    item: WorkspaceTreeItem | undefined,
    harness: HarnessId,
    surface?: SessionSurface
  ): Promise<void> => {
    const worktree =
      workspacesProvider.getWorktreeForItem(item) ??
      (await pickWorktree(storageService, gitService, 'Select worktree for new session'));
    if (!worktree) {
      return;
    }

    const adapter = harnessRegistry.get(harness);
    // Only the explicit "In Terminal"/"In UI" commands name a surface; the
    // plain New Session command follows the configured default.
    const nativeUi = (surface ?? defaultSessionSurface()) === 'ui' ? adapter.nativeUi : undefined;
    if (nativeUi) {
      const availability = nativeUi.checkNewSessionAvailability(worktree.path);
      if (availability.kind === 'available') {
        await startSessionInNativeUi(worktree, harness, nativeUi);
        return;
      }
      if (surface === 'ui') {
        await explainNativeUiUnavailable(nativeUi, worktree.path, availability);
        return;
      }
      // The default surface is a preference: when the UI cannot start this
      // worktree, keep the action useful by launching the terminal.
    }

    if (!(await adapter.isInstalled())) {
      vscode.window.showErrorMessage(noHarnessInstalledMessage(harnessRegistry));
      return;
    }

    // The name updates when the harness or the first prompt provides one. A
    // harness that accepts a chosen ID gets one now, so the transcript is
    // linked deterministically when the first prompt creates it.
    const chat = storageService.createChat(worktree.id, harness, DEFAULT_CHAT_NAME);
    const prepared = registerPendingSession(chat, worktree);
    await terminalManager.openChat(prepared, worktree);
    selectChat(prepared, worktree);
  };

  /**
   * Hand an existing session to its harness's native UI. Shared by the
   * explicit Open in ... commands and the row click (which reveals an open
   * panel, or follows a UI default). Every refusal is explained, and a running
   * terminal is closed only after the user confirms and the UI is known to be
   * able to open the session, so two agent processes never share a session.
   */
  const openChatInNativeUi = async (
    chat: ChatSession,
    worktree: Worktree,
    nativeUi: NativeUiCapability
  ): Promise<void> => {
    const adapter = harnessRegistry.get(chat.harness);
    const surfaces = nativeUi.surfaces;
    if (!nativeUi.isInstalled()) {
      await explainNativeUiUnavailable(nativeUi, worktree.path, { kind: 'not-installed' });
      return;
    }

    // The UI extensions cannot adopt a chosen ID, so the handoff only covers a
    // session that already exists natively.
    const sessionId = chatPrimarySessionId(chat);
    if (!sessionId) {
      vscode.window.showInformationMessage(
        chat.pendingUiLaunch
          ? pendingUiMessage(nativeUi.displayName)
          : `Start this session in the terminal first. ${nativeUi.displayName} can open it after its first prompt creates the session.`
      );
      return;
    }

    // Revealing an open panel needs neither a resume check nor a terminal close.
    let open = surfaces?.isOpen(sessionId) ?? false;
    if (!open && terminalManager.isResuming(chat.id)) {
      vscode.window.showInformationMessage('This session is still starting. Try again in a moment.');
      return;
    }
    if (!open) {
      const resumable = await adapter.isSessionResumable(sessionId, worktree.path);
      // The panel may have opened while the native check was in flight; an
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

    // Preflight the folder before stopping a terminal: a mismatch must not
    // cost the user a running process.
    const availability = nativeUi.checkAvailability(worktree.path);
    if (availability.kind !== 'available') {
      await explainNativeUiUnavailable(nativeUi, worktree.path, availability);
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

    // Claude's tab carries only its title, so the expectation is what binds
    // the tab it creates. A tracker that reads the ID from the tab, or a tab
    // that is already mapped, ignores it.
    surfaces?.expect(sessionId, chat.name);
    const result = await tryOpen(() => nativeUi.openSession(sessionId, worktree.path));
    if (result.kind !== 'opened') {
      surfaces?.cancelExpect(sessionId);
      await reportNativeUiProblem(nativeUi, worktree.path, result);
      return;
    }
    surfaces?.settle(sessionId, { allowActiveFallback: true });
    selectChat(chat, worktree);
    activateChat(chat);
  };

  /**
   * Whether a UI default can open this chat without asking anything: it has a
   * native session, no terminal owns it, and the UI can open its worktree.
   */
  const canOpenInNativeUi = (
    chat: ChatSession,
    worktree: Worktree,
    nativeUi: NativeUiCapability
  ): boolean =>
    Boolean(chat.harnessSessionId) &&
    !terminalManager.isActive(chat.id) &&
    !terminalManager.isResuming(chat.id) &&
    nativeUi.isInstalled() &&
    nativeUi.checkAvailability(worktree.path).kind === 'available';

  /**
   * Open a chat the way a row click does. Shared by the row click and the
   * starred-session picker so both obey "never two agent processes for one
   * session".
   */
  const openChatPrimary = async (chat: ChatSession, worktree: Worktree): Promise<void> => {
    const nativeUi = harnessRegistry.get(chat.harness).nativeUi;
    const sessionId = chatPrimarySessionId(chat);
    const terminalOpen = terminalManager.isActive(chat.id);

    // A session already open in its agent's UI is revealed, not duplicated in
    // a terminal. A live terminal stays the surface a click focuses.
    if (nativeUi && sessionId && nativeUi.surfaces?.isOpen(sessionId) && !terminalOpen) {
      await openChatInNativeUi(chat, worktree, nativeUi);
      return;
    }

    // A UI-started chat has no native ID until its first prompt; a click must
    // not start a second agent beside the open conversation.
    if (chat.pendingUiLaunch && !terminalOpen) {
      vscode.window.showInformationMessage(pendingUiMessage(nativeUi?.displayName));
      return;
    }

    // The configured default is a preference: use the UI when it can open the
    // session, otherwise keep the action useful in the terminal.
    if (
      defaultSessionSurface() === 'ui' &&
      nativeUi &&
      canOpenInNativeUi(chat, worktree, nativeUi)
    ) {
      await openChatInNativeUi(chat, worktree, nativeUi);
      return;
    }

    await openInTerminal(chat, worktree);
  };

  /** Explicit Open in <harness> UI: refuses another harness's session. */
  const openNativeUi = async (
    item: WorkspaceTreeItem | undefined,
    harness: HarnessId,
    nativeUi: NativeUiCapability
  ): Promise<void> => {
    const chat = resolveChat(item);
    if (!chat) {
      return;
    }
    if (chat.harness !== harness) {
      vscode.window.showInformationMessage(
        `This is not a ${harnessRegistry.get(harness).displayName} session.`
      );
      return;
    }
    const worktree = chatWorktree(chat);
    if (worktree) {
      await openChatInNativeUi(chat, worktree, nativeUi);
    }
  };

  /** Create the forked chat and open it. Shared by both fork commands. */
  const openFork = async (source: LinkedChat, worktree: Worktree, fork: ForkResult): Promise<void> => {
    const name = nextForkName(
      source.name,
      storageService.getChatsByWorktree(worktree.id).map((chat) => chat.name)
    );
    if (fork.kind === 'linked') {
      const linked = storageService.createChat(worktree.id, source.harness, name, {
        harnessSessionId: fork.sessionId,
      });
      await terminalManager.openChat(linked, worktree);
    } else {
      // The harness forks in the terminal under the chosen ID and its watcher
      // links the transcript. Keep the source so a reopen before the first
      // prompt repeats the fork.
      const forked = storageService.createChat(worktree.id, source.harness, name, {
        forkedFromSessionId: source.harnessSessionId,
      });
      await terminalManager.openChat(registerPendingSession(forked, worktree, fork.pendingSessionId), worktree);
    }
    showWorktree(worktree);
    refreshTree();
  };

  /** A row's chat that has a native session to fork, and its worktree. */
  const forkSource = (
    item?: WorkspaceTreeItem
  ): { chat: LinkedChat; worktree: Worktree } | undefined => {
    const chat = rowChat(item);
    if (!chat) {
      return undefined;
    }
    if (!chat.harnessSessionId) {
      vscode.window.showErrorMessage(
        'Cannot fork a session that has not been started yet. Start the session first.'
      );
      return undefined;
    }
    const worktree = chatWorktree(chat);
    return worktree ? { chat: chat as LinkedChat, worktree } : undefined;
  };

  // Per-harness commands come from the registry: a harness with a native UI
  // also gets explicit In Terminal / In UI variants and an Open in UI command.
  for (const adapter of harnessRegistry.all()) {
    const name = `${adapter.id[0].toUpperCase()}${adapter.id.slice(1)}`;
    register(`agntree.new${name}Chat`, (item?: WorkspaceTreeItem) =>
      createSession(item, adapter.id)
    );
    const nativeUi = adapter.nativeUi;
    if (nativeUi) {
      register(`agntree.new${name}ChatInTerminal`, (item?: WorkspaceTreeItem) =>
        createSession(item, adapter.id, 'terminal')
      );
      register(`agntree.new${name}ChatInUi`, (item?: WorkspaceTreeItem) =>
        createSession(item, adapter.id, 'ui')
      );
      register(`agntree.open${name}Ui`, (item?: WorkspaceTreeItem) =>
        openNativeUi(item, adapter.id, nativeUi)
      );
    }
  }
  // Backwards-compatible alias; hidden from menus.
  register('agntree.newChat', (item?: WorkspaceTreeItem) => createSession(item, 'claude'));

  register('agntree.openChat', async (item?: WorkspaceTreeItem) => {
    const chat = rowChat(item);
    const worktree = chat && chatWorktree(chat);
    if (chat && worktree) {
      await openChatPrimary(chat, worktree);
    }
  });

  // Explicitly open a session in its terminal. If it is open in its agent's
  // UI, close that tab first so two agent processes cannot run.
  register('agntree.openChatInTerminal', async (item?: WorkspaceTreeItem) => {
    const chat = resolveChat(item);
    const worktree = chat && chatWorktree(chat);
    if (!chat || !worktree) {
      return;
    }

    if (!terminalManager.isActive(chat.id)) {
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

      const nativeUi = harnessRegistry.get(chat.harness).nativeUi;
      const sessionId = chatPrimarySessionId(chat);
      if (nativeUi?.surfaces && sessionId && nativeUi.surfaces.isOpen(sessionId)) {
        const confirm = await vscode.window.showWarningMessage(
          `Close the ${nativeUi.displayName} tab for "${chat.name}"?\n\nThe UI session stops running. The conversation will resume in a terminal.`,
          { modal: true },
          'Close and Open'
        );
        if (confirm !== 'Close and Open') {
          return;
        }
        if (!(await nativeUi.surfaces.closeSurface(sessionId))) {
          vscode.window.showErrorMessage(
            `Could not close the ${nativeUi.displayName} tab. Close it and try again.`
          );
          return;
        }
      }
    }

    await openInTerminal(chat, worktree);
  });

  register('agntree.renameChat', async (item?: WorkspaceTreeItem) => {
    const chat = rowChat(item);
    if (!chat) {
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: 'Enter new name for this session',
      value: chat.name,
      validateInput: (value) =>
        value && value.trim().length > 0 ? undefined : 'Session name is required',
    });
    if (!newName || newName === chat.name) {
      return;
    }
    storageService.updateChat(chat.id, { name: newName, customName: true });
    refreshTree();
  });

  // Close the running terminal; the chat stays in the list.
  register('agntree.closeChat', (item?: WorkspaceTreeItem) => {
    const chat = rowChat(item);
    if (chat) {
      terminalManager.closeChat(chat.id);
      refreshTree();
    }
  });

  // Remove a chat from the list. The harness keeps the session.
  register('agntree.deleteChat', async (item?: WorkspaceTreeItem) => {
    const chat = rowChat(item);
    if (!chat) {
      return;
    }
    const harnessName = harnessRegistry.get(chat.harness).displayName;
    const confirm = await vscode.window.showWarningMessage(
      `Remove "${chat.name}" from the list?\n\nThe session in ${harnessName} is preserved and can be re-imported later.`,
      { modal: true },
      'Remove'
    );
    if (confirm !== 'Remove') {
      return;
    }
    removeChats([chat.id]);
    refreshTree();
  });

  register('agntree.clearWorktreeSessions', async (item?: WorkspaceTreeItem) => {
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

    const deletedIds = removeChats(chats.map((chat) => chat.id));
    vscode.window.showInformationMessage(
      `Cleared ${deletedIds.length} session(s) from "${worktree.name}".`
    );
    refreshTree();
  });

  register('agntree.forkChat', async (item?: WorkspaceTreeItem) => {
    const source = forkSource(item);
    if (!source) {
      return;
    }
    const { chat, worktree } = source;
    const adapter = harnessRegistry.get(chat.harness);
    let fork: ForkResult;
    try {
      fork = await adapter.forkSession(chat.harnessSessionId, worktree.path);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to fork ${adapter.displayName} session: ${errorMessage(error)}`
      );
      return;
    }
    await openFork(chat, worktree, fork);
    vscode.window.showInformationMessage(`Forked session "${chat.name}"`);
  });

  // Fork into a new worktree that starts from the source's HEAD and carries
  // its uncommitted changes.
  register('agntree.forkChatWithChanges', async (item?: WorkspaceTreeItem) => {
    const source = forkSource(item);
    if (!source) {
      return;
    }
    const { chat, worktree } = source;

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

    // Validate the source before prompting and creating a worktree; a missing
    // transcript would otherwise leave a new worktree behind.
    const adapter = harnessRegistry.get(chat.harness);
    if (!(await adapter.isSessionResumable(chat.harnessSessionId, worktree.path))) {
      vscode.window.showErrorMessage(`The ${adapter.displayName} session no longer exists.`);
      return;
    }

    const branch = await promptNewBranchName(gitService.getBranches(repo.rootPath), {
      prompt: 'Enter branch name for the new worktree',
      value: `${worktree.name}-fork`,
    });
    if (!branch) {
      return;
    }
    const worktreePath = await vscode.window.showInputBox({
      prompt: 'Enter path for the new worktree directory',
      value: defaultWorktreePath(repo, branch),
      validateInput: (value) => (value.trim() ? undefined : 'Path is required'),
    });
    if (!worktreePath) {
      return;
    }

    const baseCommit = gitService.getCurrentCommit(worktree.path);
    if (
      !gitService.createWorktreeWithNewBranch(repo.rootPath, branch, worktreePath, baseCommit || 'HEAD')
    ) {
      vscode.window.showErrorMessage('Failed to create worktree.');
      return;
    }
    if (
      gitService.hasUncommittedChanges(worktree.path) &&
      !gitService.copyUncommittedChanges(worktree.path, worktreePath)
    ) {
      vscode.window.showWarningMessage('Worktree created but some changes may not have been copied.');
    }
    refreshTree();

    // Git reports the physical path, which may differ from what was typed.
    const newWorktree = gitService
      .listWorktrees(repo.rootPath, repo.id)
      .find((candidate) => canonicalPath(candidate.path) === canonicalPath(worktreePath));
    if (!newWorktree) {
      vscode.window.showErrorMessage('Worktree created but could not find it in the list.');
      return;
    }

    // Claude forks into the destination on the first prompt; opencode forks
    // and moves the new session; Codex and Pi fork into the destination cwd.
    let fork: ForkResult;
    try {
      fork = await adapter.prepareForkToNewWorktree(chat.harnessSessionId, worktree.path, worktreePath);
    } catch (error) {
      vscode.window.showErrorMessage(
        `Failed to fork the ${adapter.displayName} session into the new worktree: ${errorMessage(error)}`
      );
      return;
    }
    await openFork(chat, newWorktree, fork);
    vscode.window.showInformationMessage(`Forked session to new worktree "${branch}"`);
  });

  register('agntree.toggleStarChat', (item?: WorkspaceTreeItem) => {
    const chat = rowChat(item);
    if (chat) {
      storageService.toggleStar(chat.id);
      refreshTree();
    }
  });

  register('agntree.showStarredSessions', async () => {
    const starredChats = storageService.getStarredChats();
    if (starredChats.length === 0) {
      vscode.window.showInformationMessage(
        'No starred sessions. Star a session from the tree view to bookmark it.'
      );
      return;
    }

    const multiHarness = await harnessRegistry.hasMultipleInstalled();
    const worktreeOf = (chat: ChatSession) => workspacesProvider.getWorktreeById(chat.worktreeId);

    // One separator per repository; newest access first within each.
    const groups = new Map<string, { repoName: string; chats: ChatSession[] }>();
    for (const chat of starredChats) {
      const repoId = worktreeOf(chat)?.repoId;
      const group = groups.get(repoId ?? '') ?? {
        repoName: (repoId && storageService.getRepository(repoId)?.name) || 'Unknown',
        chats: [],
      };
      group.chats.push(chat);
      groups.set(repoId ?? '', group);
    }

    const items: (vscode.QuickPickItem & { chatId?: string })[] = [];
    for (const { repoName, chats } of groups.values()) {
      items.push({ label: repoName, kind: vscode.QuickPickItemKind.Separator });
      chats.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
      for (const chat of chats) {
        const worktreeName = worktreeOf(chat)?.name ?? 'unknown';
        const harnessLabel = multiHarness
          ? ` · ${harnessRegistry.get(chat.harness).displayName}`
          : '';
        items.push({
          label: `$(star-full) ${chat.name}`,
          description: `${formatRelativeTime(chat.lastAccessedAt, { absoluteAfterDays: 30 })} · ${worktreeName}${harnessLabel}`,
          chatId: chat.id,
        });
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a starred session to open',
      matchOnDescription: true,
    });
    const chat = selected?.chatId ? storageService.getChat(selected.chatId) : undefined;
    if (!chat) {
      return;
    }
    const worktree = chatWorktree(chat);
    if (worktree) {
      await openChatPrimary(chat, worktree);
    }
  });
}

function pendingUiMessage(displayName = 'its VS Code UI'): string {
  return `This session is starting in ${displayName}. Send your first prompt there and Agntree will link it.`;
}

/** Run an open call, turning a thrown error into a reportable result. */
async function tryOpen(open: () => Promise<NativeUiOpenResult>): Promise<NativeUiOpenResult> {
  try {
    return await open();
  } catch (error) {
    return { kind: 'failed', message: errorMessage(error) };
  }
}

/** Explain a native-UI open that did not happen. */
async function reportNativeUiProblem(
  nativeUi: Pick<NativeUiCapability, 'displayName' | 'extensionId'>,
  worktreePath: string,
  result: Exclude<NativeUiOpenResult, { kind: 'opened' }>
): Promise<void> {
  if (result.kind === 'failed') {
    vscode.window.showErrorMessage(`Could not open the ${nativeUi.displayName}: ${result.message}`);
    return;
  }
  await explainNativeUiUnavailable(nativeUi, worktreePath, result);
}

/**
 * Explain why a native-UI handoff cannot proceed. A worktree mismatch offers
 * to open that worktree in a new window, where it becomes the first folder and
 * the handoff is safe.
 */
async function explainNativeUiUnavailable(
  nativeUi: Pick<NativeUiCapability, 'displayName' | 'extensionId'>,
  worktreePath: string,
  result: NativeUiUnavailable
): Promise<void> {
  const { displayName, extensionId } = nativeUi;
  switch (result.kind) {
    case 'not-installed': {
      const choice = await vscode.window.showInformationMessage(
        `The ${displayName} extension is not installed. Install it to use the ${displayName}.`,
        'Find Extension'
      );
      if (choice === 'Find Extension') {
        // The Extensions view is unavailable in some hosts; the message above
        // still tells the user what to install.
        await Promise.resolve(
          vscode.commands.executeCommand('workbench.extensions.search', `@id:${extensionId}`)
        ).catch(() => undefined);
      }
      return;
    }
    case 'no-workspace':
      vscode.window.showInformationMessage(`Open a folder in VS Code before using ${displayName}.`);
      return;
    case 'workspace-mismatch':
    case 'workspace-multi-root': {
      const message =
        result.kind === 'workspace-mismatch'
          ? `${displayName} runs in the first folder open in VS Code:\n${result.uiCwd}\n\nThis session belongs to:\n${worktreePath}\n\nOpen that worktree in a new window, where ${displayName} can use it.`
          : `${displayName} starts new sessions in the whole VS Code workspace, not one folder.\n\nOpen this worktree as the only folder in a window:\n${worktreePath}`;
      const choice = await vscode.window.showWarningMessage(message, 'Open in New Window');
      if (choice === 'Open in New Window') {
        try {
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), {
            forceNewWindow: true,
          });
        } catch (error) {
          vscode.window.showErrorMessage(
            `Could not open the worktree in a new window: ${errorMessage(error)}`
          );
        }
      }
      return;
    }
  }
}
