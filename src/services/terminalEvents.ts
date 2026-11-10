import * as vscode from 'vscode';
import { ChatSession } from '../types';
import { quoteShellArgument } from '../harnesses/commandUtils';

/** How long to wait for a terminal's pty before giving up on its PID. */
const PROCESS_ID_TIMEOUT_MS = 2000;
/** How long to let `show()` settle before renaming the active terminal. */
const ACTIVE_TERMINAL_TIMEOUT_MS = 1000;

const TITLE_PREFIX = 'Agntree: ';

/**
 * A chat terminal's title, `Agntree: <name> [<shortId>]`. The short ID is the
 * identity that survives a quit (ADR 0009).
 */
export function terminalTitle(chat: ChatSession): string {
  return `${TITLE_PREFIX}${chat.name} [${chat.id.substring(0, 6)}]`;
}

/** The chat short ID in an Agntree title; null for a terminal Agntree does not own. */
export function titleShortId(terminalName: string): string | null {
  if (!terminalName.startsWith(TITLE_PREFIX)) {
    return null;
  }
  return terminalName.match(/\[([a-f0-9]{6})\]$/)?.[1] ?? null;
}

/**
 * Whether a terminal still owns a running process. VS Code keeps a terminal
 * listed after its process exits (the tab keeps its last output), so presence
 * alone does not mean the session is open.
 */
export function isLiveTerminal(terminal: vscode.Terminal): boolean {
  return vscode.window.terminals.includes(terminal) && terminal.exitStatus === undefined;
}

/**
 * Change directory and launch as one shell line: a revived tab's shell starts
 * in the workspace root, the command-start event then covers the launch, and
 * a failed `cd` cannot start an agent in the wrong worktree.
 */
export function commandInDirectory(directory: string, command: string): string {
  return `cd ${quoteShellArgument(directory)} && ${command}`;
}

/**
 * Settle on the first matching event or the timeout, and always release the
 * listener and timer.
 */
export function waitForEvent<T>(
  timeoutMs: number,
  onTimeout: T,
  subscribe: (done: (value: T) => void) => vscode.Disposable
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    let disposable: vscode.Disposable | undefined;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      disposable?.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => finish(onTimeout), timeoutMs);
    disposable = subscribe(finish);
    if (settled) {
      disposable.dispose();
    }
  });
}

/** A terminal's pty PID, bounded so activation cannot hang on one that never reports. */
export function readProcessId(terminal: vscode.Terminal): Promise<number | undefined> {
  return waitForEvent<number | undefined>(PROCESS_ID_TIMEOUT_MS, undefined, (done) => {
    Promise.resolve(terminal.processId).then(done, () => done(undefined));
    return { dispose: () => undefined };
  });
}

/**
 * Wait until the command sent into a terminal has started. Shell integration
 * reports the working directory as the shell starts and again as a command
 * starts, and each report re-tags the title as a config title, which a quit
 * then lets the revived shell overwrite. A rename after the command starts is
 * the one VS Code persists. False when no command start is reported (no
 * integration), which is also when the title never needs re-applying.
 */
export function waitForCommandStart(terminal: vscode.Terminal, timeoutMs: number): Promise<boolean> {
  return waitForEvent<boolean>(timeoutMs, false, (done) =>
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (event.terminal === terminal) {
        done(true);
      }
    })
  );
}

/**
 * Wait until a terminal's shell reports integration, or give up. Only an
 * integrated shell makes VS Code re-tag the title from a cwd report.
 */
export function waitForShellIntegration(terminal: vscode.Terminal, timeoutMs: number): Promise<boolean> {
  const enabled = vscode.workspace
    .getConfiguration('terminal.integrated')
    .get<boolean>('shellIntegration.enabled', true);
  if (!enabled) {
    return Promise.resolve(false);
  }
  if (terminal.shellIntegration) {
    return Promise.resolve(true);
  }
  return waitForEvent(timeoutMs, false, (done) =>
    vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        done(true);
      }
    })
  );
}

/**
 * Wait for a terminal that was just shown to become active. The rename command
 * targets the active tab, and `show()` crosses process boundaries
 * asynchronously.
 */
export function waitForActive(terminal: vscode.Terminal): Promise<void> {
  if (vscode.window.activeTerminal === terminal) {
    return Promise.resolve();
  }
  return waitForEvent<void>(ACTIVE_TERMINAL_TIMEOUT_MS, undefined, (done) =>
    vscode.window.onDidChangeActiveTerminal((active) => {
      if (active === terminal) {
        done(undefined);
      }
    })
  );
}
