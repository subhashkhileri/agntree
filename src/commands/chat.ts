import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { ClaudeSessionService } from '../services/ClaudeSessionService';
import { SessionWatcher } from '../services/SessionWatcher';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { ChangesTreeProvider, ChangeTreeItem } from '../providers/ChangesTreeProvider';
import { ChatSession, Worktree } from '../types';

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
  sessionWatcher: SessionWatcher,
  refreshTree: () => void
): void {
  // New Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.newChat',
      async (item?: WorkspaceTreeItem) => {
        let worktree: Worktree | undefined;

        if (item && item.itemType === 'worktree') {
          worktree = item.data as Worktree;
        } else {
          // Need to show picker - gather all worktrees from all repos
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
            return;
          }

          const selected = await vscode.window.showQuickPick(allWorktrees, {
            placeHolder: 'Select worktree for new chat',
          });

          if (!selected) {
            return;
          }

          worktree = selected.worktree;
        }

        // Get current commit for change tracking
        const baseCommit = gitService.getCurrentCommit(worktree.path);

        // Create the chat immediately with a temporary name
        // The name will be auto-updated when a summary or first prompt is available
        const chat = storageService.createChat(worktree.id, 'New Chat', baseCommit);

        // Register for session detection and auto-naming
        sessionWatcher.registerPendingChat(chat.id, worktree);

        // Open in terminal
        terminalManager.openChat(chat, worktree);

        // Update changes view
        changesProvider.setActiveChat(chat.id, worktree);

        refreshTree();
      }
    )
  );

  // Open Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.openChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;
        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);

        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this chat.');
          return;
        }

        // Open or focus the terminal
        terminalManager.openChat(chat, worktree);

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
      'claude-workspaces.renameChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        const newName = await vscode.window.showInputBox({
          prompt: 'Enter new name for this chat',
          value: chat.name,
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Chat name is required';
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

  // Remove Chat from list (does not delete Claude session files)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.deleteChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        const confirm = await vscode.window.showWarningMessage(
          `Remove "${chat.name}" from the list?\n\nThe Claude session in ~/.claude/ is preserved and can be re-imported later.`,
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

  // Refresh Changes
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-workspaces.refreshChanges', () => {
      changesProvider.refresh();
    })
  );

  // Open Diff
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.openDiff',
      async (item?: ChangeTreeItem) => {
        if (!item || !(item instanceof ChangeTreeItem)) {
          return;
        }

        const fullPath = `${item.worktreePath}/${item.change.path}`;
        const filePath = vscode.Uri.file(fullPath);

        // For added files, just open the file (no previous version to diff against)
        if (item.change.status === 'added') {
          await vscode.window.showTextDocument(filePath);
          return;
        }

        // Use VS Code's built-in git openChange command for side-by-side diff
        try {
          await vscode.commands.executeCommand('git.openChange', filePath);
        } catch {
          // Fallback: just open the file
          await vscode.window.showTextDocument(filePath);
        }
      }
    )
  );

  // Fork Chat (same worktree)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.forkChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        // Must have a session ID to fork
        if (!chat.claudeSessionId) {
          vscode.window.showErrorMessage('Cannot fork a chat that has no session yet. Start the chat first.');
          return;
        }

        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this chat.');
          return;
        }

        // Create new chat with fork name
        const forkName = `Fork of ${chat.name}`;
        const baseCommit = gitService.getCurrentCommit(worktree.path);
        const forkedChat = storageService.createChat(worktree.id, forkName, baseCommit);

        // Register for session detection BEFORE opening terminal
        // (the forked session will have a new ID that we need to capture)
        sessionWatcher.registerPendingChat(forkedChat.id, worktree);

        // Open in terminal with fork flag
        terminalManager.openChat(forkedChat, worktree, chat.claudeSessionId);

        // Update changes view
        changesProvider.setActiveChat(forkedChat.id, worktree);

        vscode.window.showInformationMessage(`Forked chat "${chat.name}"`);
        refreshTree();
      }
    )
  );

  // Fork Chat with Changes (creates new worktree and copies changes)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.forkChatWithChanges',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        // Must have a session ID to fork
        if (!chat.claudeSessionId) {
          vscode.window.showErrorMessage('Cannot fork a chat that has no session yet. Start the chat first.');
          return;
        }

        const worktree = workspacesProvider.getWorktreeById(chat.worktreeId);
        if (!worktree) {
          vscode.window.showErrorMessage('Could not find worktree for this chat.');
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

        // Copy the session file to the new worktree's project folder
        // This is required because Claude Code stores sessions per-directory
        const sessionService = new ClaudeSessionService();
        const sessionCopied = sessionService.copySessionToWorktree(
          chat.claudeSessionId,
          worktree.path,
          worktreePath
        );

        if (!sessionCopied) {
          vscode.window.showWarningMessage('Worktree created but session file could not be copied. The fork may not have conversation history.');
        }

        // Create forked chat in the new worktree
        const forkName = `Fork of ${chat.name}`;
        const forkedChat = storageService.createChat(newWorktree.id, forkName, currentCommit);

        // Register for session detection BEFORE opening terminal
        // (the forked session will have a new ID that we need to capture)
        sessionWatcher.registerPendingChat(forkedChat.id, newWorktree);

        // Open in terminal with fork flag
        terminalManager.openChat(forkedChat, newWorktree, chat.claudeSessionId);

        // Update changes view
        changesProvider.setActiveChat(forkedChat.id, newWorktree);

        vscode.window.showInformationMessage(`Forked chat to new worktree "${newBranchName}"`);
        refreshTree();
      }
    )
  );

  // Import Existing Sessions
  const claudeSessionService = new ClaudeSessionService();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.importSessions',
      async (item?: WorkspaceTreeItem) => {
        let worktree: Worktree | undefined;

        if (item && item.itemType === 'worktree') {
          worktree = item.data as Worktree;
        } else {
          // Show picker for worktree
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
            return;
          }

          const selected = await vscode.window.showQuickPick(allWorktrees, {
            placeHolder: 'Select worktree to import sessions for',
          });

          if (!selected) {
            return;
          }

          worktree = selected.worktree;
        }

        // Find existing Claude sessions for this worktree
        const sessions = await claudeSessionService.findSessionsForWorktree(worktree.path);

        if (sessions.length === 0) {
          vscode.window.showInformationMessage(
            `No existing Claude sessions found for ${worktree.name}. Sessions are stored in ~/.claude/projects/`
          );
          return;
        }

        // Filter out already imported sessions
        const existingChats = storageService.getChatsByWorktree(worktree.id);
        const existingSessionIds = new Set(existingChats.map(c => c.claudeSessionId).filter(Boolean));

        const availableSessions = sessions.filter(s => !existingSessionIds.has(s.sessionId));

        if (availableSessions.length === 0) {
          vscode.window.showInformationMessage('All existing sessions have already been imported.');
          return;
        }

        // Show picker for sessions to import
        const sessionItems = availableSessions.map(s => ({
          label: s.summary || `Session ${s.sessionId.substring(0, 8)}`,
          description: s.gitBranch ? `Branch: ${s.gitBranch}` : undefined,
          detail: s.lastUpdated
            ? `Last updated: ${s.lastUpdated.toLocaleString()} • ${s.messageCount} messages`
            : undefined,
          session: s,
          picked: false,
        }));

        const selectedSessions = await vscode.window.showQuickPick(sessionItems, {
          placeHolder: 'Select sessions to import (multi-select with Space)',
          canPickMany: true,
        });

        if (!selectedSessions || selectedSessions.length === 0) {
          return;
        }

        // Import selected sessions
        let imported = 0;
        for (const item of selectedSessions) {
          const session = item.session;
          const name = session.summary || `Imported: ${session.sessionId.substring(0, 8)}`;

          // Create chat with the existing Claude session ID
          const chat = storageService.createChat(worktree.id, name, null);
          storageService.updateChat(chat.id, {
            claudeSessionId: session.sessionId,
            createdAt: session.lastUpdated?.getTime() || Date.now(),
          });

          imported++;
        }

        vscode.window.showInformationMessage(`Imported ${imported} session(s) for ${worktree.name}`);
        refreshTree();
      }
    )
  );
}
