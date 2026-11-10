import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';
import { GitService } from '../services/GitService';
import { WorkspaceTreeItem, WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { HarnessAdapter, HarnessSession, SessionMetadata } from '../harnesses/types';
import { harnessIconPath } from '../harnesses/treeIcons';
import {
  harnessSessionKey,
  lastExchange,
  sessionDisplayName,
  sessionUsageLine,
} from '../harnesses/sessionUtils';
import { HarnessId, Repository, Worktree } from '../types';
import { clampInlineText, formatRelativeTime } from '../utils/text';
import { deepestContainingRoot } from '../utils/paths';
import { commandRegistrar, noHarnessInstalledMessage, pickWorktree, withProgress } from './common';

interface HarnessSessionEntry {
  harness: HarnessId;
  session: HarnessSession;
}

interface SessionQuickPickItem extends vscode.QuickPickItem {
  harness?: HarnessId;
  session?: HarnessSession;
  worktree?: Worktree;
  isImported?: boolean;
}

/**
 * Register the manual import commands: **Import Existing Sessions** for one
 * worktree, and **Search Sessions** across a repository.
 */
export function registerSessionImportCommands(
  context: vscode.ExtensionContext,
  storageService: StorageService,
  gitService: GitService,
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

  /** A manual import is also the user undoing an earlier removal. */
  const importSession = (
    worktree: Worktree,
    { harness, session }: HarnessSessionEntry
  ): void => {
    storageService.createChat(worktree.id, harness, sessionDisplayName(session, 'Imported: '), {
      harnessSessionId: session.sessionId,
      createdAt: session.lastUpdated?.getTime() || Date.now(),
    });
    storageService.forgetRemovedSession(harness, session.sessionId);
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

    const sessions = await collectSessions(adapters, (adapter) =>
      adapter.listSessionsForWorktree(worktree.path)
    );
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
      importSession(worktree, entry);
    }
    vscode.window.showInformationMessage(
      `Imported ${selected.length} session(s) for ${worktree.name}`
    );
    refreshTree();
  });

  register('agntree.searchSessions', async (item?: WorkspaceTreeItem) => {
    const repo =
      item?.itemType === 'repository'
        ? (item.data as Repository)
        : await pickRepository(storageService);
    if (!repo) {
      return;
    }

    // A plain folder is its own root worktree, so its sessions are
    // searchable too.
    const { worktrees } = gitService.listRepositoryWorktrees(repo.rootPath, repo.id);
    const adapters = await installedAdapters();
    if (!adapters) {
      return;
    }

    const sessions = await withProgress('Searching for agent sessions...', () =>
        collectSessions(adapters, (adapter) =>
          adapter.listSessionsForRepository(
            repo.rootPath,
            worktrees.map((worktree) => worktree.path)
          )
        )
    );
    if (sessions.length === 0) {
      vscode.window.showInformationMessage(`No sessions found for "${repo.name}".`);
      return;
    }

    const selected = await showSessionSearch(
      context.extensionUri,
      harnessRegistry,
      repo.name,
      groupByWorktree(sessions, worktrees),
      importedKeys(worktrees)
    );
    if (!selected) {
      return;
    }
    if (selected.isImported || !selected.session || !selected.worktree || !selected.harness) {
      vscode.window.showInformationMessage('That session is already imported.');
      return;
    }

    importSession(selected.worktree, {
      harness: selected.harness,
      session: selected.session,
    });
    vscode.window.showInformationMessage(`Imported session to ${selected.worktree.name}`);
    refreshTree();
  });
}

async function pickRepository(storageService: StorageService): Promise<Repository | undefined> {
  const repos = storageService.getRepositories();
  if (repos.length === 0) {
    vscode.window.showErrorMessage('No repositories available. Add a repository first.');
    return undefined;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const selected = await vscode.window.showQuickPick(
    repos.map((repo) => ({ label: repo.name, description: repo.rootPath, repo })),
    { placeHolder: 'Select repository to search sessions for' }
  );
  return selected?.repo;
}

/**
 * Each session goes to the deepest worktree containing its cwd, or to the main
 * worktree when none does. Groups list the main worktree first, then by name.
 */
function groupByWorktree(
  sessions: HarnessSessionEntry[],
  worktrees: Worktree[]
): { worktree: Worktree; entries: HarnessSessionEntry[] }[] {
  const fallback = worktrees.find((worktree) => worktree.isMain) ?? worktrees[0];
  const groups = new Map<string, { worktree: Worktree; entries: HarnessSessionEntry[] }>();
  for (const entry of sessions) {
    const worktree = deepestContainingRoot(worktrees, entry.session.cwd) ?? fallback;
    const group = groups.get(worktree.id) ?? { worktree, entries: [] };
    group.entries.push(entry);
    groups.set(worktree.id, group);
  }
  return [...groups.values()].sort((a, b) =>
    a.worktree.isMain !== b.worktree.isMain
      ? a.worktree.isMain
        ? -1
        : 1
      : a.worktree.name.localeCompare(b.worktree.name)
  );
}

/**
 * The search picker. Rows stay compact (name, recency, and the harness mark);
 * the highlighted row expands into a short brief loaded on demand, so the list
 * does not repeat several prompts under every row.
 */
async function showSessionSearch(
  extensionUri: vscode.Uri,
  harnessRegistry: HarnessRegistry,
  repoName: string,
  groups: { worktree: Worktree; entries: HarnessSessionEntry[] }[],
  imported: Set<string>
): Promise<SessionQuickPickItem | undefined> {
  const items: SessionQuickPickItem[] = [];
  for (const { worktree, entries } of groups) {
    items.push({
      label: `${worktree.name}${worktree.isMain ? ' (main)' : ''}`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const { harness, session } of entries) {
      const isImported = imported.has(harnessSessionKey(harness, session.sessionId));
      const description: string[] = [];
      if (session.lastUpdated) {
        description.push(formatRelativeTime(session.lastUpdated, { absoluteAfterDays: 30 }));
      }
      if (session.messageCount > 0) {
        description.push(`${session.messageCount} msgs`);
      }
      items.push({
        label: `${isImported ? '$(check) ' : ''}${sessionDisplayName(session)}`,
        description: description.join(' · '),
        iconPath: harnessIconPath(extensionUri, harnessRegistry.get(harness), 'closed'),
        harness,
        session,
        worktree,
        isImported,
      });
    }
  }

  const quickPick = vscode.window.createQuickPick<SessionQuickPickItem>();
  quickPick.items = items;
  quickPick.placeholder = 'Select a session to import — highlight a row for details';
  quickPick.title = `Search Sessions — ${repoName}`;
  quickPick.matchOnDescription = true;
  // Detail exists only for the highlighted row, so matching on it would hide
  // every row the user has not visited yet.
  quickPick.matchOnDetail = false;

  const details = new Map<string, string | undefined>();
  const loading = new Set<string>();
  let expanded: SessionQuickPickItem | undefined;
  let repainting = false;
  let closed = false;

  const paint = (item: SessionQuickPickItem, detail: string | undefined): void => {
    if (expanded === item && item.detail === detail) {
      return;
    }
    if (expanded && expanded !== item) {
      expanded.detail = undefined;
    }
    item.detail = detail;
    expanded = detail ? item : undefined;
    // The picker repaints detail from its item list, not from the mutated
    // object, so hand it the same items again.
    repainting = true;
    quickPick.items = [...quickPick.items];
    repainting = false;
  };

  const load = async (item: SessionQuickPickItem, key: string): Promise<void> => {
    const { harness, session } = item;
    if (!harness || !session || loading.has(key)) {
      return;
    }
    loading.add(key);
    const adapter = harnessRegistry.get(harness);
    try {
      let meta = await adapter.getSessionMetadata(session.sessionId, session.cwd);
      // A lazy-preview harness builds previews from an export: fetch it once,
      // then re-read the metadata so the reply and counts come along.
      if (meta && meta.preview.length === 0 && adapter.capabilities.preview === 'lazy') {
        await adapter.getPreview(session.sessionId, 3);
        meta = (await adapter.getSessionMetadata(session.sessionId, session.cwd)) ?? meta;
      }
      const detail = sessionBrief(adapter, session, meta);
      details.set(key, detail);
      if (!closed && quickPick.activeItems[0] === item) {
        paint(item, detail);
      }
    } catch {
      // A broken session still needs a selectable row; do not retry it on
      // every highlight.
      details.set(key, undefined);
    } finally {
      loading.delete(key);
    }
  };

  quickPick.onDidChangeActive(([active]) => {
    if (closed || repainting || !active?.session || !active.harness) {
      return;
    }
    const key = harnessSessionKey(active.harness, active.session.sessionId);
    if (details.has(key)) {
      paint(active, details.get(key));
      return;
    }
    // Collapse the previous row now; this one expands when its brief loads.
    if (expanded && expanded !== active) {
      paint(expanded, undefined);
    }
    void load(active, key);
  });

  const selected = await new Promise<SessionQuickPickItem | undefined>((resolve) => {
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
  closed = true;
  return selected;
}

/** The last exchange plus usage, for the highlighted search row. */
function sessionBrief(
  adapter: HarnessAdapter,
  session: HarnessSession,
  meta: SessionMetadata | null
): string | undefined {
  const lines: string[] = [];
  const { lastAsk, lastReply } = lastExchange(meta);
  if (lastAsk) {
    lines.push(`You: ${clampInlineText(lastAsk.text, 160)}`);
    if (lastReply) {
      lines.push(`${adapter.displayName}: ${clampInlineText(lastReply.text, 160)}`);
    }
  }
  const usage = sessionUsageLine(meta, session);
  if (usage) {
    lines.push(usage);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Query every installed harness in parallel and flatten the results, newest
 * first. A harness that throws is logged and skipped so one bad adapter cannot
 * break import or search.
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
