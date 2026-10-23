import * as vscode from 'vscode';
import {
  ApplyResult,
  applyAttentionHooks,
  attentionHooksInstalled,
  claudeSettingsPath,
  revertAttentionHooks,
} from '../services/ClaudeAttentionHooks';
import { ATTENTION_FILE } from '../services/attentionLog';

function displayPath(filePath: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && filePath.startsWith(home)
    ? `~${filePath.slice(home.length)}`
    : filePath;
}

/**
 * Apply one hook mutation, then report the outcome. Keeps the context key and
 * the error shape in one place for install and remove.
 */
async function updateHooks(
  update: (settingsPath: string) => ApplyResult,
  messages: { changed: string; unchanged: string }
): Promise<void> {
  const settingsPath = claudeSettingsPath();
  const result = update(settingsPath);

  if (result.error) {
    void vscode.window.showErrorMessage(
      `Could not update ${displayPath(settingsPath)}: ${result.error}`
    );
    return;
  }

  await vscode.commands.executeCommand(
    'setContext',
    'agntree.attentionHooks',
    attentionHooksInstalled(settingsPath)
  );

  void vscode.window.showInformationMessage(
    result.changed ? messages.changed : messages.unchanged
  );
}

/**
 * Opt-in wiring for Claude Code's own attention signals. Without these hooks
 * only finished turns are reported; permission prompts and idle questions are
 * invisible to any tool outside the terminal.
 */
export function registerNotificationCommands(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'agntree.installAttentionHooks',
      async () => {
        const choice = await vscode.window.showWarningMessage(
          `Add a Stop and a Notification hook to ${displayPath(
            claudeSettingsPath()
          )}, next to the hooks you already have? ` +
            `They append permission and idle events to ${displayPath(
              ATTENTION_FILE
            )} so Agntree can ` +
            'tell you when a Claude session needs you. A backup is written once, and existing ' +
            'hooks are left untouched. New Claude Code sessions pick this up.',
          { modal: true },
          'Install Hooks'
        );
        if (choice !== 'Install Hooks') {
          return;
        }

        await updateHooks(applyAttentionHooks, {
          changed:
            'Claude Code attention hooks installed. They apply to new sessions.',
          unchanged: 'Claude Code attention hooks were already installed.',
        });
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agntree.removeAttentionHooks', () =>
      updateHooks(revertAttentionHooks, {
        changed: 'Removed the Agntree hooks from Claude Code settings.',
        unchanged: 'No Agntree hooks were installed.',
      })
    )
  );
}
