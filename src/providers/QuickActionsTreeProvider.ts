import * as vscode from 'vscode';
import type { ChildProcess } from 'child_process';
import { HarnessId } from '../types';
import { HarnessRegistry } from '../harnesses/HarnessRegistry';

/**
 * Quick Action type from settings
 *
 * Two modes:
 * 1. Agent mode: Use `prompt` to run a harness headlessly
 *    - Claude: requires `allowedTools`
 *    - opencode: uses `run --auto`; optional `agent` and `model`
 * 2. Command mode: Use `command` to run any shell command directly
 */
export interface QuickAction {
  name: string;
  icon?: string;
  /** Agent prompt (used with the harness adapter) */
  prompt?: string;
  /** Allowed tools for Claude (used with prompt) */
  allowedTools?: string;
  /** Harness to run the prompt with; defaults to agntree.defaultHarness */
  harness?: HarnessId;
  /** Harness-specific agent (opencode `--agent`) */
  agent?: string;
  /** Harness-specific model (opencode `--model`) */
  model?: string;
  /** Pass `--auto` to opencode (defaults to true) */
  auto?: boolean;
  /** Raw shell command to execute (alternative to prompt) */
  command?: string;
}

/**
 * Tree item for a quick action
 */
export class QuickActionItem extends vscode.TreeItem {
  constructor(
    public readonly action: QuickAction,
    public readonly index: number,
    public readonly worktreePath: string,
    public readonly isRunning: boolean = false,
    defaultIcon: string = 'sparkle'
  ) {
    super(action.name, vscode.TreeItemCollapsibleState.None);

    // Show different icon based on running state
    if (isRunning) {
      this.iconPath = new vscode.ThemeIcon('sync~spin');
      this.contextValue = 'quickActionRunning';
      this.tooltip = `Running: ${action.command || action.prompt || ''}`;
    } else {
      // Determine icon: user-specified > agent harness icon > command mode (zap)
      let iconId = action.icon;
      if (!iconId) {
        iconId = action.prompt ? defaultIcon : 'zap';
      }
      this.iconPath = new vscode.ThemeIcon(iconId);
      this.contextValue = 'quickAction';
      this.tooltip = action.command || action.prompt || '';
    }
    // No command on click - use the inline play/stop button instead
  }
}

/**
 * Provides tree data for the Quick Actions view
 */
export class QuickActionsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Currently active worktree path */
  private activeWorktreePath: string | undefined;

  /** Track running actions by index -> process */
  private runningProcesses: Map<number, ChildProcess> = new Map();

  constructor(private readonly harnessRegistry: HarnessRegistry) {}

  /**
   * Set the active worktree path for running actions
   */
  setActiveWorktreePath(path: string | undefined): void {
    this.activeWorktreePath = path;
    this.refresh();
  }

  /**
   * Get the active worktree path
   */
  getActiveWorktreePath(): string | undefined {
    return this.activeWorktreePath;
  }

  /**
   * Check if an action is running
   */
  isActionRunning(index: number): boolean {
    return this.runningProcesses.has(index);
  }

  /**
   * Mark an action as running and store its process
   */
  setActionRunning(index: number, process: ChildProcess): void {
    this.runningProcesses.set(index, process);
    this.refresh();
  }

  /**
   * Mark an action as stopped
   */
  setActionStopped(index: number): void {
    this.runningProcesses.delete(index);
    this.refresh();
  }

  /**
   * Stop a running action by killing its process
   */
  stopAction(index: number): boolean {
    const childProcess = this.runningProcesses.get(index);
    if (childProcess) {
      // Kill the process tree (important for shell commands)
      try {
        if (childProcess.pid) {
          // On Windows, use taskkill for process tree
          if (process.platform === 'win32') {
            require('child_process').spawn('taskkill', ['/pid', childProcess.pid.toString(), '/T', '/F']);
          } else {
            // On Unix, kill the process group
            childProcess.kill('SIGTERM');
          }
        }
      } catch {
        // Fallback to regular kill
        childProcess.kill();
      }
      this.runningProcesses.delete(index);
      this.refresh();
      return true;
    }
    return false;
  }

  /**
   * Refresh the tree view
   */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Dispose of resources — kill all running processes
   */
  dispose(): void {
    for (const [, childProcess] of this.runningProcesses) {
      try {
        if (childProcess.pid) {
          if (process.platform === 'win32') {
            require('child_process').spawn('taskkill', ['/pid', childProcess.pid.toString(), '/T', '/F']);
          } else {
            childProcess.kill('SIGTERM');
          }
        }
      } catch {
        try { childProcess.kill(); } catch { /* ignore */ }
      }
    }
    this.runningProcesses.clear();
    this._onDidChangeTreeData.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    // Only show root level items
    if (element) {
      return [];
    }

    // Get quick actions from settings
    const config = vscode.workspace.getConfiguration('agntree');
    const quickActions = config.get<QuickAction[]>('quickActions', []);

    if (quickActions.length === 0) {
      // Return empty - the welcome view will show
      return [];
    }

    // Use active worktree path or current workspace folder
    const worktreePath = this.activeWorktreePath ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      '';

    return quickActions.map((action, index) => {
      const harness = this.harnessRegistry.get(
        action.harness ?? this.harnessRegistry.defaultHarness()
      );
      return new QuickActionItem(
        action,
        index,
        worktreePath,
        this.runningProcesses.has(index),
        harness.icon
      );
    });
  }
}
