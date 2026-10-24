import * as fs from 'fs';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { HarnessId } from '../types';

/**
 * Resolve a harness CLI command from the agntree.harnessCommands setting.
 */
export function getHarnessCommand(harness: HarnessId, fallback: string): string {
  const configured = vscode.workspace
    .getConfiguration('agntree')
    .get<Record<string, string>>('harnessCommands', {});
  const value = configured?.[harness];
  return value && value.trim() ? value.trim() : fallback;
}

/**
 * Quote one argument for a POSIX shell used by a VS Code terminal.
 *
 * This is used for both the executable and values such as Codex's `--cd`
 * path. Windows needs a different quoting strategy; keep that limitation in
 * `ROADMAP.md` until a platform-specific helper is added.
 */
export function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Check whether a command is available on PATH (or is an existing executable).
 */
export function commandExists(command: string): Promise<boolean> {
  if (command.includes('/') || command.includes('\\')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }

  return new Promise((resolve) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    execFile(
      probe,
      [command],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        resolve(!error && String(stdout).trim().length > 0);
      }
    );
  });
}
