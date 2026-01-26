import * as vscode from 'vscode';
import { ChangesTreeProvider } from '../providers/ChangesTreeProvider';
import { QuickAction, QuickActionsTreeProvider } from '../providers/QuickActionsTreeProvider';

/**
 * Register quick action related commands
 */
export function registerQuickActionCommands(
  context: vscode.ExtensionContext,
  changesProvider: ChangesTreeProvider,
  quickActionsProvider: QuickActionsTreeProvider
): void {
  // Create output channel for Quick Actions
  const quickActionsOutput = vscode.window.createOutputChannel('Agntree Quick Actions');
  context.subscriptions.push(quickActionsOutput);

  // Helper function to run a quick action
  async function executeQuickAction(action: QuickAction, index: number, worktreePath: string): Promise<void> {
    // Check if already running
    if (quickActionsProvider.isActionRunning(index)) {
      vscode.window.showWarningMessage(`"${action.name}" is already running. Stop it first to run again.`);
      return;
    }

    // Validate action has either command or prompt+allowedTools
    if (!action.command && (!action.prompt || !action.allowedTools)) {
      vscode.window.showErrorMessage(
        `Quick action "${action.name}" is misconfigured. Provide either "command" or both "prompt" and "allowedTools".`
      );
      return;
    }

    // Log start to output channel
    const timestamp = new Date().toLocaleTimeString();
    quickActionsOutput.appendLine(`\n[${timestamp}] Running: ${action.name}`);
    quickActionsOutput.appendLine('─'.repeat(50));

    const { spawn } = await import('child_process');

    let childProcess;

    if (action.command) {
      // Command mode: run raw shell command (cross-platform)
      quickActionsOutput.appendLine(`$ ${action.command}\n`);
      childProcess = spawn(action.command, {
        cwd: worktreePath,
        shell: true, // Uses default shell on each platform
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Claude mode: run claude with prompt and allowedTools
      quickActionsOutput.appendLine(`$ claude -p "${action.prompt}" --allowedTools "${action.allowedTools}"\n`);
      childProcess = spawn('claude', ['-p', action.prompt!, '--allowedTools', action.allowedTools!], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    // Register process as running
    quickActionsProvider.setActionRunning(index, childProcess);

    let stdout = '';
    let stderr = '';

    childProcess.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    childProcess.on('close', (code: number | null) => {
      // Mark as stopped
      quickActionsProvider.setActionStopped(index);

      if (code === 0) {
        const output = stdout.trim() || `${action.name} completed successfully!`;

        // Log to output channel
        quickActionsOutput.appendLine(output);
        quickActionsOutput.appendLine(`\n✓ ${action.name} completed`);
        quickActionsOutput.appendLine('─'.repeat(50));

        // Show notification with button to view output
        vscode.window.showInformationMessage(
          `${action.name} completed`,
          'Show Output'
        ).then(selection => {
          if (selection === 'Show Output') {
            quickActionsOutput.show();
          }
        });

        changesProvider.refresh();
      } else if (code === null) {
        // Process was killed/terminated
        quickActionsOutput.appendLine(`\n⊘ ${action.name} was stopped`);
        quickActionsOutput.appendLine('─'.repeat(50));

        vscode.window.showInformationMessage(`${action.name} stopped`);
      } else {
        const errorMessage = stderr || stdout || 'Unknown error';

        // Log error to output channel
        quickActionsOutput.appendLine(`Error: ${errorMessage}`);
        quickActionsOutput.appendLine(`\n✗ ${action.name} failed (exit code: ${code})`);
        quickActionsOutput.appendLine('─'.repeat(50));

        vscode.window.showErrorMessage(
          `${action.name} failed`,
          'Show Output'
        ).then(selection => {
          if (selection === 'Show Output') {
            quickActionsOutput.show();
          }
        });
      }
    });

    childProcess.on('error', (err: Error) => {
      // Mark as stopped
      quickActionsProvider.setActionStopped(index);

      quickActionsOutput.appendLine(`Error: ${err.message}`);
      quickActionsOutput.appendLine('─'.repeat(50));
      vscode.window.showErrorMessage(`Failed to run command: ${err.message}`);
    });
  }

  // Stop Quick Action
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.stopQuickAction',
      async (item: unknown) => {
        if (!item || typeof item !== 'object' || !('index' in item)) {
          vscode.window.showErrorMessage('Invalid quick action item.');
          return;
        }

        const actionItem = item as { index: number; action: QuickAction };
        const stopped = quickActionsProvider.stopAction(actionItem.index);

        if (!stopped) {
          vscode.window.showWarningMessage(`"${actionItem.action.name}" is not running.`);
        }
      }
    )
  );

  // Run Quick Action by index (called programmatically)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.runQuickActionByIndex',
      async (index: number, worktreePath: string) => {
        const config = vscode.workspace.getConfiguration('agntree');
        const quickActions = config.get<QuickAction[]>('quickActions', []);

        if (index < 0 || index >= quickActions.length) {
          vscode.window.showErrorMessage('Invalid action index.');
          return;
        }

        const action = quickActions[index];
        await executeQuickAction(action, index, worktreePath);
      }
    )
  );

  // Run Quick Action from tree item (inline play button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.runQuickActionFromTree',
      async (item: unknown) => {
        if (!item || typeof item !== 'object' || !('action' in item) || !('worktreePath' in item) || !('index' in item)) {
          vscode.window.showErrorMessage('Invalid quick action item.');
          return;
        }

        const actionItem = item as { action: QuickAction; index: number; worktreePath: string };
        await executeQuickAction(actionItem.action, actionItem.index, actionItem.worktreePath);
      }
    )
  );

  // Run Quick Action (shows picker - kept for menu button)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.runQuickAction',
      async () => {
        const worktree = changesProvider.getActiveWorktree();
        if (!worktree) {
          vscode.window.showErrorMessage('No active worktree selected.');
          return;
        }

        const config = vscode.workspace.getConfiguration('agntree');
        const quickActions = config.get<QuickAction[]>('quickActions', []);

        if (quickActions.length === 0) {
          const addNow = await vscode.window.showInformationMessage(
            'No quick actions configured. Would you like to add one?',
            'Add Quick Action'
          );
          if (addNow === 'Add Quick Action') {
            vscode.commands.executeCommand('agntree.addQuickAction');
          }
          return;
        }

        // Show picker
        const actionItems = quickActions.map((action, index) => {
          const desc = action.command || action.prompt || '';
          return {
            label: `$(${action.icon || 'play'}) ${action.name}`,
            description: desc.substring(0, 60) + (desc.length > 60 ? '...' : ''),
            action,
            index,
          };
        });

        const selected = await vscode.window.showQuickPick(actionItems, {
          placeHolder: 'Select a quick action to run',
        });

        if (!selected) {
          return;
        }

        await executeQuickAction(selected.action, selected.index, worktree.path);
      }
    )
  );

  // Add Quick Action (opens settings)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.addQuickAction',
      async () => {
        // Open settings focused on quickActions
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'agntree.quickActions'
        );
      }
    )
  );
}
