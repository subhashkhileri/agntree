import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { TerminalManager } from '../services/TerminalManager';
import { ClaudeSessionService } from '../services/ClaudeSessionService';
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

        // Get chat name
        const chatName = await vscode.window.showInputBox({
          prompt: 'Enter a name for this chat session',
          placeHolder: 'Bug fix, Feature work, etc.',
          validateInput: (value) => {
            if (!value || value.trim().length === 0) {
              return 'Chat name is required';
            }
            return undefined;
          },
        });

        if (!chatName) {
          return;
        }

        // Get current commit for change tracking
        const baseCommit = gitService.getCurrentCommit(worktree.path);

        // Create the chat
        const chat = storageService.createChat(worktree.id, chatName, baseCommit);

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

  // Delete Chat
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'claude-workspaces.deleteChat',
      async (item?: WorkspaceTreeItem) => {
        if (!item || item.itemType !== 'chat') {
          return;
        }

        const chat = item.data as ChatSession;

        const confirm = await vscode.window.showWarningMessage(
          `Delete chat "${chat.name}"? This cannot be undone.`,
          { modal: true },
          'Delete'
        );

        if (confirm !== 'Delete') {
          return;
        }

        // Close terminal if active
        terminalManager.closeChat(chat.id);

        // Delete from storage
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
