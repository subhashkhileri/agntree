import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';
import { harnessIconPath } from '../harnesses/treeIcons';
import { SessionSearchService } from '../services/SessionSearchService';
import { SessionSearchMatch, SessionSearchRecord } from '../types';
import { debounce } from '../utils/debounce';
import { clampInlineText, formatCost, formatRelativeTime } from '../utils/text';

/** Steps of the agent's work listed in a search's tooltip. */
const TOOLTIP_STEPS = 12;
const REFRESH_MS = 100;

/** A search row, or one session it found. */
export type SessionSearchNode =
  | { kind: 'search'; search: SessionSearchRecord }
  | { kind: 'match'; search: SessionSearchRecord; match: SessionSearchMatch };

/**
 * The Find Session view: one row per question, with the agent's answer in its
 * tooltip, and one row per session the harness confirmed beneath it.
 */
export class SessionSearchTreeProvider implements vscode.TreeDataProvider<SessionSearchNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  // A search reports every tool call; one repaint covers a burst of them.
  private readonly refresh = debounce(() => this.changed.fire(), REFRESH_MS);

  constructor(
    private readonly sessionSearch: Pick<SessionSearchService, 'searches' | 'onDidChange'>,
    private readonly harnessRegistry: HarnessRegistry,
    private readonly extensionUri: vscode.Uri
  ) {
    this.subscription = sessionSearch.onDidChange(this.refresh);
  }

  getChildren(node?: SessionSearchNode): SessionSearchNode[] {
    if (!node) {
      return this.sessionSearch.searches().map((search) => ({ kind: 'search', search }));
    }
    if (node.kind === 'search') {
      return node.search.matches.map((match) => ({ kind: 'match', search: node.search, match }));
    }
    return [];
  }

  getTreeItem(node: SessionSearchNode): vscode.TreeItem {
    return node.kind === 'search' ? this.searchItem(node.search) : this.matchItem(node);
  }

  dispose(): void {
    this.refresh.cancel();
    this.subscription.dispose();
    this.changed.dispose();
  }

  private searchItem(search: SessionSearchRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(
      clampInlineText(search.query, 80),
      search.matches.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
    );
    // The state is part of the id so a finished search renders expanded
    // instead of keeping the collapsed state of its running row.
    item.id = `search:${search.id}:${search.state}`;
    item.contextValue = search.state === 'running' ? 'sessionSearchRunning' : 'sessionSearch';
    item.tooltip = this.searchTooltip(search);
    switch (search.state) {
      case 'running':
        item.iconPath = new vscode.ThemeIcon('loading~spin');
        item.description = search.activity.at(-1) ?? 'searching…';
        break;
      case 'failed':
        item.iconPath = new vscode.ThemeIcon('error');
        item.description = 'failed';
        break;
      default:
        item.iconPath = new vscode.ThemeIcon(search.matches.length > 0 ? 'sparkle' : 'circle-slash');
        item.description = [
          search.matches.length === 0
            ? 'no match'
            : `${search.matches.length} ${search.matches.length === 1 ? 'session' : 'sessions'}`,
          formatRelativeTime(search.startedAt, { short: true }),
        ].join(' · ');
    }
    return item;
  }

  private matchItem(node: SessionSearchNode & { kind: 'match' }): vscode.TreeItem {
    const { search, match } = node;
    const item = new vscode.TreeItem(match.title, vscode.TreeItemCollapsibleState.None);
    item.id = `search:${search.id}:${search.state}:${match.harness}:${match.sessionId}`;
    item.contextValue = 'sessionSearchMatch';
    item.iconPath = harnessIconPath(this.extensionUri, this.harnessRegistry.get(match.harness), 'closed');
    const when = match.prompt?.timestamp ?? match.lastUpdated;
    item.description = [displayPath(match.cwd), when ? formatRelativeTime(when, { absoluteAfterDays: 7 }) : '']
      .filter(Boolean)
      .join(' · ');
    item.tooltip = this.matchTooltip(match);
    item.command = { command: 'agntree.resumeSearchMatch', title: 'Resume', arguments: [node] };
    return item;
  }

  /** The agent's answer, then how it got there. Plain text: it is shown as written. */
  private searchTooltip(search: SessionSearchRecord): string {
    const lines = [search.query, ''];
    if (search.state === 'running') {
      lines.push('Searching…');
    } else if (search.state === 'failed') {
      lines.push(`The search failed: ${search.error ?? 'unknown error'}`);
    } else {
      lines.push(search.answer || 'The agent gave no answer.');
      if (search.discarded) {
        lines.push(
          '',
          `${search.discarded} ${search.discarded === 1 ? 'session the agent named does' : 'sessions the agent named do'} not exist and ${search.discarded === 1 ? 'is' : 'are'} hidden.`
        );
      }
    }

    const facts = [
      this.harnessRegistry.get(search.engine.harness).displayName,
      search.engine.model,
      search.engine.effort,
      search.durationMs !== undefined ? `${Math.round(search.durationMs / 1000)} s` : '',
      search.costUsd !== undefined ? formatCost(search.costUsd) : '',
      new Date(search.startedAt).toLocaleString(),
    ].filter(Boolean);
    lines.push('', facts.join(' · '));

    if (search.activity.length > 0) {
      const steps = search.activity.slice(-TOOLTIP_STEPS);
      const skipped = search.activity.length - steps.length;
      lines.push('', 'What it searched:');
      if (skipped > 0) {
        lines.push(`  … ${skipped} earlier`);
      }
      lines.push(...steps.map((step) => `  • ${step}`));
    }
    return lines.join('\n');
  }

  private matchTooltip(match: SessionSearchMatch): string {
    const lines = [match.title];
    if (match.reason) {
      lines.push('', match.reason);
    }
    if (match.prompt) {
      const when = match.prompt.timestamp ? ` · ${new Date(match.prompt.timestamp).toLocaleString()}` : '';
      lines.push('', `You${when}:`, `“${match.prompt.text}”`);
    }
    lines.push('', [this.harnessRegistry.get(match.harness).displayName, match.cwd, match.sessionId].join(' · '));
    return lines.join('\n');
  }
}

/** A folder under the home directory as `~/…`. */
export function displayPath(folder: string): string {
  const home = os.homedir();
  if (folder === home) {
    return '~';
  }
  return folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder;
}
