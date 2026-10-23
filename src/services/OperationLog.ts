import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * Shared log for operations that create, move, or delete things on disk.
 *
 * Every destructive file action writes a timestamped line here, so there is a
 * record of what Agntree did even when a modal dialog is dismissed.
 */
export function logOperation(message: string): void {
  channel ??= vscode.window.createOutputChannel('Agntree Operations');
  channel.appendLine(`[${new Date().toISOString()}] ${message}`);
}

export function disposeOperationLog(): void {
  channel?.dispose();
  channel = undefined;
}
