import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessAdapter, HarnessSession } from '../harnesses/types';
import { harnessSessionKey, sessionDisplayName } from '../harnesses/sessionUtils';
import { HarnessId, Worktree } from '../types';
import { WorktreeCatalog } from '../services/WorktreeCatalog';
import { commandRegistrar, importNativeSession, noHarnessInstalledMessage, pickWorktree } from './common';

interface HarnessSessionEntry {
  harness: HarnessId;
  session: HarnessSession;
}

/** Register **Import Existing Sessions**, the manual import for one worktree. */
export function registerSessionImportCommands(
  context: vscode.ExtensionContext,
  storageService: StorageService,
  gitService: GitService,
  worktreeCatalog: WorktreeCatalog,
  workspacesProvider: Pick<WorkspacesTreeProvider, 'getWorktreeForItem'>,
  harnessRegistry: HarnessRegistry,
  refreshTree: () => void
): void {
  const register = commandRegistrar(context);

  const importedKeys = (worktrees: Worktree[]): Set<string> => {
    const keys = new Set<string>();
    for (const worktree of worktrees) {
      for (const chat of storageService.getChatsByWorktree(worktree.id)) {
        if (chat.harnessSessionId) {
          keys.add(harnessSessionKey(chat.harness, chat.harnessSessionId));
        }
      }
    }
    return keys;
  };

  const installedAdapters = async (): Promise<HarnessAdapter[] | undefined> => {
    const adapters = await harnessRegistry.getInstalled();
    if (adapters.length === 0) {
      vscode.window.showErrorMessage(noHarnessInstalledMessage(harnessRegistry));
      return undefined;
    }
    return adapters;
  };

  register('agntree.importSessions', async (item?: WorkspaceTreeItem) => {
    const worktree =
      workspacesProvider.getWorktreeForItem(item) ??
      (await pickWorktree(storageService, gitService, 'Select worktree to import sessions for'));
    if (!worktree) {
      return;
    }
    const adapters = await installedAdapters();
    if (!adapters) {
      return;
    }

    // A workspace root nested inside this worktree imports its own sessions.
    const sessions = (
      await collectSessions(adapters, (adapter) => adapter.listSessionsForWorktree(worktree.path))
    ).filter(({ session }) => worktreeCatalog.owns(worktree.path, session.cwd));
    if (sessions.length === 0) {
      vscode.window.showInformationMessage(`No existing sessions found for ${worktree.name}.`);
      return;
    }

    const imported = importedKeys([worktree]);
    const available = sessions.filter(
      ({ harness, session }) => !imported.has(harnessSessionKey(harness, session.sessionId))
    );
    if (available.length === 0) {
      vscode.window.showInformationMessage('All existing sessions have already been imported.');
      return;
    }

    const items = available.map(({ harness, session }) => {
      const description = [harnessRegistry.get(harness).displayName];
      if (session.gitBranch) {
        description.push(session.gitBranch);
      }
      const detail: string[] = [];
      if (session.lastUpdated) {
        detail.push(`Last updated: ${session.lastUpdated.toLocaleString()}`);
      }
      if (session.messageCount > 0) {
        detail.push(`${session.messageCount} messages`);
      }
      return {
        label: sessionDisplayName(session),
        description: description.join(' · '),
        detail: detail.join(' • ') || undefined,
        harness,
        session,
      };
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select sessions to import (multi-select with Space)',
      canPickMany: true,
    });
    if (!selected || selected.length === 0) {
      return;
    }

    for (const entry of selected) {
      importNativeSession(storageService, worktree, entry.harness, entry.session);
    }
    vscode.window.showInformationMessage(
      `Imported ${selected.length} session(s) for ${worktree.name}`
    );
    refreshTree();
  });

}

/**
 * Query every installed harness in parallel and flatten the results, newest
 * first. A harness that throws is logged and skipped so one bad adapter cannot
 * break import.
 */
async function collectSessions(
  adapters: HarnessAdapter[],
  listFor: (adapter: HarnessAdapter) => Promise<HarnessSession[]>
): Promise<HarnessSessionEntry[]> {
  const listings = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return (await listFor(adapter)).map((session) => ({ harness: adapter.id, session }));
      } catch (error) {
        console.error(`Failed to list ${adapter.displayName} sessions:`, error);
        return [];
      }
    })
  );
  return listings
    .flat()
    .sort(
      (a, b) =>
        (b.session.lastUpdated?.getTime() ?? 0) - (a.session.lastUpdated?.getTime() ?? 0)
    );
}
