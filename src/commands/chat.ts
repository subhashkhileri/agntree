import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { HarnessWatcherRegistry } from '../services/HarnessWatcherRegistry';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { ChangesTreeProvider, ChangeTreeItem, ChangeSectionItem } from '../providers/ChangesTreeProvider';
import { ChatSession, HarnessId, Worktree } from '../types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessAdapter, HarnessSession } from '../harnesses/types';
import { harnessSessionKey, sessionDisplayName } from '../harnesses/sessionUtils';

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
  refreshTree: () => void
): void {
  const registerSessionCommand = (command: string, harness: HarnessId) => {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, (item?: WorkspaceTreeItem) =>
        createSession(item, harness)
      )
    );
  };

  const pickWorktree = async (
    placeHolder: string
  ): Promise<Worktree | undefined> => {
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
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(allWorktrees, { placeHolder });
    return selected?.worktree;
  };

  const createSession = async (
    item: WorkspaceTreeItem | undefined,
    harness: HarnessId
  ): Promise<void> => {
    let worktree: Worktree | undefined;

    if (item && item.itemType === 'worktree') {
      worktree = item.data as Worktree;
    } else {
      worktree = await pickWorktree('Select worktree for new session');
    }

    if (!worktree) {
      return;
    }

    // Get current commit for change tracking
    const baseCommit = gitService.getCurrentCommit(worktree.path);

    // Create the chat immediately with a temporary name
    // The name will be auto-updated when a summary or first prompt is available
    const chat = storageService.createChat(worktree.id, 'New Session', baseCommit, harness);

    // Register for session detection and auto-naming
    harnessWatcherRegistry.registerPendingChat(harness, chat.id, worktree.path);

    // Open in terminal
    await terminalManager.openChat(chat, worktree);

    // Update changes view
    changesProvider.setActiveChat(chat.id, worktree);

    refreshTree();
  };

  registerSessionCommand('agntree.newClaudeChat', 'claude');
  registerSessionCommand('agntree.newOpencodeChat', 'opencode');
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

        // Open or focus the terminal
        await terminalManager.openChat(chat, worktree);

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

        storageService.renameChat(chat.id, newName);
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
        if (!item || item.itemType !== 'worktree') {
          return;
        }

        const worktree = item.data as Worktree;
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
        let forkSessionId: string | undefined;
        try {
          const result = await adapter.forkSession(
            chat.harnessSessionId,
            worktree.path
          );
          forkSessionId = result.sessionId;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(`Failed to fork ${adapter.displayName} session: ${message}`);
          return;
        }

        // Create new chat with unique fork name (short hash suffix)
        const shortHash = Math.random().toString(36).substring(2, 6);
        const forkName = `Fork of ${chat.name} (${shortHash})`;
        const baseCommit = gitService.getCurrentCommit(worktree.path);
        const forkedChat = storageService.createChat(
          worktree.id,
          forkName,
          baseCommit,
          chat.harness
        );

        if (forkSessionId) {
          // The harness created the fork for us; resume it directly.
          const linkedChat = storageService.updateChat(forkedChat.id, {
            harnessSessionId: forkSessionId,
          });
          await terminalManager.openChat(linkedChat ?? forkedChat, worktree);
        } else {
          // Claude forks in the terminal; the watcher captures the new ID.
          harnessWatcherRegistry.registerPendingChat(
            chat.harness,
            forkedChat.id,
            worktree.path
          );
          await terminalManager.openChat(
            forkedChat,
            worktree,
            chat.harnessSessionId
          );
        }

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

        // Prepare the fork in the destination worktree. Claude copies its
        // session files; opencode forks and moves the new session.
        const adapter = harnessRegistry.get(chat.harness);
        let forkSessionId: string | undefined;
        try {
          const result = await adapter.prepareForkToNewWorktree(
            chat.harnessSessionId,
            worktree.path,
            worktreePath
          );
          forkSessionId = result.sessionId ?? chat.harnessSessionId;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            `Failed to fork the ${adapter.displayName} session into the new worktree: ${message}`
          );
          return;
        }

        // Create forked chat in the new worktree linked to the forked session
        const shortHash = Math.random().toString(36).substring(2, 6);
        const forkName = `Fork of ${chat.name} (${shortHash})`;
        const forkedChat = storageService.createChat(
          newWorktree.id,
          forkName,
          currentCommit,
          chat.harness
        );
        // Open in terminal - just resume since the fork is ready
        const linkedChat =
          storageService.updateChat(forkedChat.id, {
            harnessSessionId: forkSessionId,
          }) ?? forkedChat;
        await terminalManager.openChat(linkedChat, newWorktree);

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
        let worktree: Worktree | undefined;

        if (item && item.itemType === 'worktree') {
          worktree = item.data as Worktree;
        } else {
          worktree = await pickWorktree('Select worktree to import sessions for');
        }

        if (!worktree) {
          return;
        }
        const targetWorktree = worktree;

        const adapters = await harnessRegistry.getInstalled();
        if (adapters.length === 0) {
          vscode.window.showErrorMessage('No supported harnesses detected. Install Claude Code or opencode first.');
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

          const chat = storageService.createChat(
            targetWorktree.id,
            name,
            null,
            harness
          );
          storageService.updateChat(chat.id, {
            harnessSessionId: session.sessionId,
            createdAt: session.lastUpdated?.getTime() || Date.now(),
          });

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

        // Gather all worktrees for this repository
        const worktrees = gitService.listWorktrees(repo.rootPath, repo.id);
        const worktreePaths = worktrees.map(wt => wt.path);

        const adapters = await harnessRegistry.getInstalled();
        if (adapters.length === 0) {
          vscode.window.showErrorMessage('No supported harnesses detected. Install Claude Code or opencode first.');
          return;
        }
        const multiHarness = await harnessRegistry.hasMultipleInstalled();

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
        const path = await import('path');
        const matchSessionToWorktree = (session: { cwd: string }): Worktree => {
          const sessionCwd = path.resolve(session.cwd);
          // Find the worktree whose path best matches (longest match wins)
          let bestMatch: Worktree | undefined;
          let bestMatchLen = 0;
          for (const wt of worktrees) {
            const wtPath = path.resolve(wt.path);
            if (sessionCwd === wtPath || sessionCwd.startsWith(wtPath + '/')) {
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

        // Claude previews are cheap (local JSONL); opencode exports spawn a
        // process, so those are fetched lazily when a row is highlighted.
        const previewCache = new Map<string, string[]>();
        for (const entry of allSessions) {
          if (harnessRegistry.get(entry.harness).capabilities.preview === 'lazy') {
            continue;
          }
          try {
            const messages = await harnessRegistry
              .get(entry.harness)
              .getPreview(entry.session.sessionId, 5);
            previewCache.set(
              harnessSessionKey(entry.harness, entry.session.sessionId),
              messages.map((message) => message.text)
            );
          } catch {
            // Preview is optional; the row still works without it.
          }
        }

        const quickPickItems: SessionQuickPickItem[] = [];
        for (const [, { worktree: wt, entries }] of sessionsByWorktree) {
          // Add separator for this worktree
          quickPickItems.push({
            label: `${wt.name}${wt.isMain ? ' (main)' : ''}`,
            kind: vscode.QuickPickItemKind.Separator,
          });

          for (const entry of entries) {
            const { harness, session } = entry;
            const adapter = harnessRegistry.get(harness);
            const imported = isImported(entry);
            const label = `${imported ? '$(check) ' : ''}${sessionDisplayName(session)}`;

            // Description: harness · time · message count · branch
            const descParts: string[] = [];
            if (imported) {
              descParts.push('imported');
            }
            if (multiHarness) {
              descParts.push(adapter.displayName);
            }
            if (session.lastUpdated) {
              descParts.push(formatRelativeTime(session.lastUpdated));
            }
            if (session.messageCount > 0) {
              descParts.push(`${session.messageCount} msgs`);
            }
            if (session.gitBranch) {
              descParts.push(session.gitBranch);
            }

            // Detail: show up to 5 user prompts, each on its own line
            const preview =
              previewCache.get(harnessSessionKey(harness, session.sessionId)) || [];
            const detail = preview.length > 0
              ? preview.map((m, i) => `${i + 1}. ${m}`).join('\n')
              : undefined;

            quickPickItems.push({
              label,
              description: descParts.join(' · '),
              detail,
              harness: imported ? undefined : harness,
              session: imported ? undefined : session,
              worktree: imported ? undefined : wt,
              isImported: imported,
            });
          }
        }

        // Create enhanced QuickPick (single-select)
        const quickPick = vscode.window.createQuickPick<SessionQuickPickItem>();
        quickPick.items = quickPickItems;
        quickPick.placeholder = 'Select a session to import';
        quickPick.title = `Search Sessions — ${repo.name}`;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;

        let disposed = false;
        quickPick.onDidChangeActive((activeItems) => {
          const active = activeItems[0];
          if (disposed || !active?.session || !active.harness) {
            return;
          }
          const adapter = harnessRegistry.get(active.harness);
          if (adapter.capabilities.preview !== 'lazy') {
            return;
          }
          const key = harnessSessionKey(active.harness, active.session.sessionId);
          if (previewCache.has(key)) {
            return;
          }

          // Mark as in-flight so rapid highlight changes don't spawn exports.
          previewCache.set(key, []);
          const entry = active.session;
          void adapter
            .getPreview(entry.sessionId, 5)
            .then((messages) => {
              const preview = messages.map((message) => message.text);
              previewCache.set(key, preview);
              if (disposed || preview.length === 0) {
                return;
              }
              active.detail = preview.map((m, i) => `${i + 1}. ${m}`).join('\n');
              quickPick.items = [...quickPick.items];
            })
            .catch(() => {
              previewCache.delete(key);
            });
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

        if (!selected.session || !selected.worktree || !selected.harness) {
          vscode.window.showInformationMessage('That session is already imported.');
          return;
        }

        const session = selected.session;
        const harness = selected.harness;
        const targetWorktree = selected.worktree;
        const name = sessionDisplayName(session, 'Imported: ');

        const chat = storageService.createChat(
          targetWorktree.id,
          name,
          null,
          harness
        );
        storageService.updateChat(chat.id, {
          harnessSessionId: session.sessionId,
          createdAt: session.lastUpdated?.getTime() || Date.now(),
        });

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

  // Discard All Changes
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.discardAll',
      async (item?: ChangeSectionItem) => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          'Discard all unstaged changes? This cannot be undone.',
          { modal: true },
          'Discard All'
        );

        if (confirm !== 'Discard All') {
          return;
        }

        const success = gitService.discardAll(worktree.path);
        if (success) {
          changesProvider.refresh();
        } else {
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
          const worktrees = gitService.listWorktrees(repo.rootPath, repo.id);
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
            const relativeTime = formatRelativeTime(chat.lastAccessedAt);
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

        // Open the session
        await terminalManager.openChat(chat, worktreeInfo.worktree);
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

function formatRelativeTime(timestamp: number | Date): string {
  const value = typeof timestamp === 'number' ? timestamp : timestamp.getTime();
  const diff = Date.now() - value;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(value).toLocaleDateString();
}
