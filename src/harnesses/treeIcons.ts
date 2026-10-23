import * as vscode from 'vscode';
import { HarnessAdapter, HarnessIconState, HarnessTreeIcons } from './types';

const STATES: HarnessIconState[] = ['working', 'done', 'closed', 'new'];

/**
 * Extension-relative paths for a harness's generated tree icons.
 * The files are produced by `npm run generate:icons`.
 */
export function harnessTreeIcons(harness: string): HarnessTreeIcons {
  const paths = (theme: 'light' | 'dark'): Record<HarnessIconState, string> =>
    Object.fromEntries(
      STATES.map((state) => [
        state,
        `resources/icons/harness/${harness}-${theme}-${state}.svg`,
      ])
    ) as Record<HarnessIconState, string>;

  return { light: paths('light'), dark: paths('dark') };
}

/**
 * Resolve a harness mark for the current theme. Adapters without custom art
 * fall back to their codicon.
 */
export function harnessIconPath(
  extensionUri: vscode.Uri,
  adapter: HarnessAdapter,
  state: HarnessIconState
): vscode.IconPath {
  if (!adapter.treeIcons) {
    return new vscode.ThemeIcon(adapter.icon);
  }
  return {
    light: vscode.Uri.joinPath(extensionUri, adapter.treeIcons.light[state]),
    dark: vscode.Uri.joinPath(extensionUri, adapter.treeIcons.dark[state]),
  };
}
