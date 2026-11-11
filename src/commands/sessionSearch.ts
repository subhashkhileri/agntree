import * as fs from 'fs';
import * as vscode from 'vscode';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { quoteShellArgument } from '../harnesses/commandUtils';
import { chatNativeSessionIds } from '../harnesses/sessionUtils';
import { SessionSearchNode, displayPath } from '../providers/SessionSearchTreeProvider';
import { WorkspacesTreeProvider } from '../providers/WorkspacesTreeProvider';
import { SessionSearchService } from '../services/SessionSearchService';
import { StorageService } from '../services/StorageService';
import { WorktreeCatalog } from '../services/WorktreeCatalog';
import { ChatSession, SessionSearchEngine, SessionSearchMatch } from '../types';
import { errorMessage } from '../utils/text';
import { commandRegistrar, importNativeSession } from './common';

export const SESSION_SEARCH_VIEW = 'agntree.sessionSearchView';

export interface SessionSearchCommandDeps {
  sessionSearch: SessionSearchService;
  storageService: StorageService;
  harnessRegistry: HarnessRegistry;
  worktreeCatalog: Pick<WorktreeCatalog, 'owner'>;
  workspacesProvider: Pick<WorkspacesTreeProvider, 'getChatTreeItem'>;
  /** Select a chat's row in the Workspaces tree. */
  activateChat: (chat: ChatSession) => void;
  refreshTree: () => void;
  /** Whether the Find Session view is on screen. */
  isViewVisible: () => boolean;
}

/**
 * The session finder's commands: ask, tune the engine, and act on what it
 * found. A found session resumes in its Agntree row when a workspace root
 * owns its folder, and in a plain terminal at that folder otherwise.
 */
export function registerSessionSearchCommands(context: vscode.ExtensionContext, deps: SessionSearchCommandDeps): void {
  const { sessionSearch, storageService, harnessRegistry, worktreeCatalog, workspacesProvider } = deps;
  const register = commandRegistrar(context);

  // With agntree.sessionSearch.alwaysShowView off, the view appears once there is a search.
  let shown: boolean | undefined;
  // Sent only when it changes: a running search reports every tool call.
  const showView = async (visible: boolean): Promise<void> => {
    if (visible !== shown) {
      shown = visible;
      await vscode.commands.executeCommand('setContext', 'agntree.hasSessionSearches', visible);
    }
  };
  const updateView = () => void showView(sessionSearch.searches().length > 0);
  updateView();
  context.subscriptions.push(sessionSearch.onDidChange(updateView));

  const engineLabel = (engine: SessionSearchEngine): string =>
    `${harnessRegistry.get(engine.harness).displayName} · ${engine.model} · ${engine.effort}`;

  /** Ask for a question; the gear changes the engine and asks again. */
  const askQuestion = (initial: string): Promise<string | undefined> => {
    const engine = sessionSearch.engine();
    if (!engine) {
      vscode.window.showErrorMessage('No harness that can search sessions is registered.');
      return Promise.resolve(undefined);
    }
    const input = vscode.window.createInputBox();
    input.title = `Find Session — ${engineLabel(engine)}`;
    input.placeholder = 'What did you work on? e.g. the mod that shows context and usage limits';
    input.value = initial;
    input.buttons = [{ iconPath: new vscode.ThemeIcon('settings-gear'), tooltip: 'Choose Harness, Model, and Effort…' }];
    return new Promise((resolve) => {
      let next: Promise<string | undefined> | undefined;
      input.onDidTriggerButton(() => {
        const value = input.value;
        next = configure().then(() => askQuestion(value));
        input.hide();
      });
      input.onDidAccept(() => {
        if (input.value.trim()) {
          next = Promise.resolve(input.value.trim());
          input.hide();
        }
      });
      input.onDidHide(() => {
        input.dispose();
        resolve(next);
      });
      input.show();
    });
  };

  const find = async (initial = ''): Promise<void> => {
    const query = await askQuestion(initial);
    const engine = sessionSearch.engine();
    if (!query || !engine) {
      return;
    }
    await showView(true);
    focusView();
    let search;
    try {
      search = await vscode.window.withProgress({ location: { viewId: SESSION_SEARCH_VIEW } }, () =>
        sessionSearch.search(query, engine)
      );
    } catch (error) {
      // Nothing started, so there may be nothing for the view to show.
      updateView();
      vscode.window.showErrorMessage(errorMessage(error));
      return;
    }
    if (search.state === 'failed') {
      vscode.window.showErrorMessage(`The session search failed: ${search.error}`);
    } else if (search.state === 'done' && !deps.isViewVisible()) {
      const found = search.matches.length;
      const choice = await vscode.window.showInformationMessage(
        found === 0 ? `No session matched "${query}".` : `Found ${found} ${found === 1 ? 'session' : 'sessions'} for "${query}".`,
        'Show'
      );
      if (choice === 'Show') {
        focusView();
      }
    }
  };

  const focusView = (): void => {
    void vscode.commands.executeCommand(`${SESSION_SEARCH_VIEW}.focus`).then(undefined, () => undefined);
  };

  /** Change one part of the engine; the choice becomes the default. */
  const configure = async (): Promise<void> => {
    const engine = sessionSearch.engine();
    if (!engine) {
      return;
    }
    const config = vscode.workspace.getConfiguration('agntree');
    const save = (key: string, value: string | undefined) =>
      config.update(`sessionSearch.${key}`, value, vscode.ConfigurationTarget.Global);
    const adapter = harnessRegistry.get(engine.harness);
    const runner = adapter.sessionSearchRunner!;
    const part = await vscode.window.showQuickPick(
      [
        { label: 'Harness', description: adapter.displayName, part: 'harness' },
        { label: 'Model', description: engine.model, part: 'model' },
        { label: 'Effort', description: engine.effort, part: 'effort' },
      ],
      { title: 'Session Search Settings', placeHolder: 'Choose what to change' }
    );
    if (part?.part === 'harness') {
      const picked = await vscode.window.showQuickPick(
        sessionSearch.runners().map((adapter) => ({
          label: adapter.displayName,
          description: adapter.id === engine.harness ? 'current' : undefined,
          id: adapter.id,
        })),
        { title: 'Search with which harness?' }
      );
      if (picked && picked.id !== engine.harness) {
        // Model names belong to a harness; the new one starts on its default.
        await save('harness', picked.id);
        await save('model', undefined);
      }
    } else if (part?.part === 'model') {
      const other = 'Other…';
      const picked = await vscode.window.showQuickPick(
        [
          ...runner.suggestedModels.map((model) => ({
            label: model,
            description: [model === runner.defaultModel ? 'default, cheapest' : '', model === engine.model ? 'current' : '']
              .filter(Boolean)
              .join(' · '),
          })),
          { label: other, description: 'Type a model name' },
        ],
        { title: 'Search with which model?' }
      );
      const model =
        picked?.label === other
          ? (await vscode.window.showInputBox({ prompt: 'Model name or alias', value: engine.model }))?.trim()
          : picked?.label;
      if (model) {
        await save('model', model === runner.defaultModel ? undefined : model);
      }
    } else if (part?.part === 'effort') {
      const picked = await vscode.window.showQuickPick(
        runner.efforts.map((effort) => ({ label: effort, description: effort === engine.effort ? 'current' : undefined })),
        { title: 'How much effort?' }
      );
      if (picked) {
        await save('effort', picked.label);
      }
    }
  };

  /** The match's row, imported into the root that owns its folder if it has none yet. */
  const chatFor = (match: SessionSearchMatch): ChatSession | undefined => {
    const owner = worktreeCatalog.owner(match.cwd);
    if (!owner) {
      return undefined;
    }
    const existing = storageService
      .getChats()
      .find((chat) => chat.harness === match.harness && chatNativeSessionIds(chat).includes(match.sessionId));
    if (existing) {
      return existing;
    }
    const chat = importNativeSession(storageService, owner, match.harness, {
      sessionId: match.sessionId,
      summary: match.title,
      lastUpdated: match.lastUpdated ? new Date(match.lastUpdated) : null,
    });
    deps.refreshTree();
    return chat;
  };

  const resumeCommand = (match: SessionSearchMatch): string =>
    harnessRegistry.get(match.harness).buildLaunchCommand({ worktreePath: match.cwd, sessionId: match.sessionId });

  register('agntree.findSession', () => find());
  register('agntree.askSessionSearchAgain', (node?: SessionSearchNode) => find(node?.search.query));
  register('agntree.configureSessionSearch', () => configure());
  register('agntree.cancelSessionSearch', () => sessionSearch.cancel());
  register('agntree.removeSessionSearch', (node?: SessionSearchNode) => {
    if (node) {
      return sessionSearch.remove([node.search.id]);
    }
  });
  register('agntree.clearSessionSearches', async () => {
    const finished = sessionSearch.searches().filter((search) => search.state !== 'running');
    if (finished.length === 0) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Clear ${finished.length} past ${finished.length === 1 ? 'search' : 'searches'}?`,
      { modal: true, detail: 'Their answers are removed from the Find Session view. Your sessions are not affected.' },
      'Clear'
    );
    if (confirm === 'Clear') {
      await sessionSearch.remove(finished.map((search) => search.id));
    }
  });

  register('agntree.resumeSearchMatch', async (node?: SessionSearchNode) => {
    const match = node?.kind === 'match' ? node.match : undefined;
    if (!match) {
      return;
    }
    const chat = chatFor(match);
    if (chat) {
      await vscode.commands.executeCommand('agntree.openChat', workspacesProvider.getChatTreeItem(chat));
      return;
    }
    // No workspace root owns the folder: resume where the session ran.
    const adapter = harnessRegistry.get(match.harness);
    if (!fs.existsSync(match.cwd)) {
      vscode.window.showWarningMessage(`The session's folder no longer exists: ${match.cwd}`);
      return;
    }
    if (!(await adapter.isSessionResumable(match.sessionId, match.cwd))) {
      vscode.window.showWarningMessage(`The ${adapter.displayName} session no longer exists. It may have been removed.`);
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: match.title,
      cwd: match.cwd,
      iconPath: new vscode.ThemeIcon(adapter.icon),
    });
    terminal.sendText(resumeCommand(match));
    terminal.show();
  });

  register('agntree.revealSearchMatch', async (node?: SessionSearchNode) => {
    const match = node?.kind === 'match' ? node.match : undefined;
    if (!match) {
      return;
    }
    const chat = chatFor(match);
    if (chat) {
      deps.activateChat(chat);
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `${displayPath(match.cwd)} is not in Agntree. Add the folder to see this session in the tree.`,
      'Add Folder…'
    );
    if (choice) {
      await vscode.commands.executeCommand('agntree.addRepository');
    }
  });

  register('agntree.copySearchMatchCommand', async (node?: SessionSearchNode) => {
    const match = node?.kind === 'match' ? node.match : undefined;
    if (match) {
      const command = `cd ${quoteShellArgument(match.cwd)} && ${resumeCommand(match)}`;
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(`Copied: ${command}`);
    }
  });
}
