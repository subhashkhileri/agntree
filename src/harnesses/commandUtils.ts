import * as fs from 'fs';
import * as readline from 'readline';
import { Writable } from 'stream';
import * as vscode from 'vscode';
import { ChildProcess, execFile, spawn } from 'child_process';
import { HarnessId } from '../types';
import { parseJsonLine } from '../utils/jsonlTail';
import { SessionSearchRunRequest } from './types';

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
 * path. Terminal launches on Windows need a different quoting strategy; keep
 * that limitation in `ROADMAP.md`. A CLI Agntree runs itself goes through
 * `harnessInvocation()` instead.
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

/**
 * How to run a harness CLI with an argument list. npm installs CLIs on
 * Windows as `.cmd` shims, which only cmd.exe can start, and Node joins the
 * arguments for cmd.exe unquoted, so each one is quoted for it.
 */
export function harnessInvocation(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32') {
    return { command, args, shell: false };
  }
  return { command: quoteForCmd(command), args: args.map(quoteForCmd), shell: true };
}

/**
 * One argument for a cmd.exe command line. Double quotes keep spaces and
 * `&|<>^()` literal; nothing escapes `%` or a quote there, so those are
 * refused rather than passed through.
 */
export function quoteForCmd(value: string): string {
  if (/["%\r\n]/.test(value)) {
    throw new Error(`Agntree cannot pass this to a command on Windows: ${value}`);
  }
  return /^[\w@+=:,.\/\\[\]-]+$/.test(value) ? value : `"${value}"`;
}

/** How long a stopped CLI gets to exit before it is killed outright. */
const KILL_GRACE_MS = 5_000;
/** How long after the CLI exits a grandchild may hold its output open. */
const OUTPUT_GRACE_MS = 2_000;
const STDERR_TAIL = 2_000;
/** Greps over a large history on a slow disk have taken over four minutes. */
export const SEARCH_TIMEOUT_MS = 10 * 60_000;

export interface CliProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Absolute time by which the CLI must exit. */
  deadline: number;
  timeoutMessage: string;
  /**
   * Attach the protocol to the process as soon as it exists. This owns stderr
   * and the process lifetime; the caller owns stdin and stdout.
   */
  onSpawn(child: ChildProcess): void;
}

export interface CliProcessResult {
  code: number | null;
  stderr: string;
}

/**
 * Run a harness CLI for one bounded turn. This owns the process lifetime: its
 * own group on POSIX, a bounded stop that becomes SIGKILL, the output grace
 * period, the stderr tail, and the stop/deadline errors. The caller owns the
 * protocol through `onSpawn`. A stop rejects with the signal's reason.
 */
export function runCliProcess(options: CliProcessOptions): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(options.signal.reason);
      return;
    }
    // A later turn of a conversation must not start a process it cannot finish.
    if (Date.now() >= options.deadline) {
      reject(new Error(options.timeoutMessage));
      return;
    }
    const cli = harnessInvocation(options.command, options.args);
    const child = spawn(cli.command, cli.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: cli.shell,
      windowsHide: true,
      detached: !cli.shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let outputTimer: NodeJS.Timeout | undefined;

    const stop = (): void => {
      if (killTimer) {
        return;
      }
      stopProcessTree(child, false);
      killTimer = setTimeout(() => stopProcessTree(child, true), KILL_GRACE_MS);
    };

    const finish = (error: unknown, result?: CliProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(outputTimer);
      options.signal.removeEventListener('abort', stop);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(result!);
      }
    };

    timer = setTimeout(
      () => {
        timedOut = true;
        stop();
      },
      Math.max(1_000, options.deadline - Date.now())
    );
    options.signal.addEventListener('abort', stop, { once: true });

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    // A CLI may exit before reading its input; that is reported on close.
    child.stdin!.on('error', () => undefined);
    child.on('error', (error) => finish(error));
    // 'close' waits for every holder of the output pipes; a grandchild that
    // outlives the CLI must not keep the search open.
    child.on('exit', () => {
      outputTimer = setTimeout(() => {
        child.stdout!.destroy();
        child.stderr!.destroy();
      }, OUTPUT_GRACE_MS);
    });
    child.on('close', (code) => {
      if (options.signal.aborted) {
        finish(options.signal.reason);
      } else if (timedOut) {
        finish(new Error(options.timeoutMessage));
      } else {
        finish(undefined, { code, stderr });
      }
    });

    try {
      options.onSpawn(child);
    } catch (error) {
      stopProcessTree(child, true);
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    if (options.signal.aborted) {
      stop();
    }
  });
}

export interface JsonlCliRunOptions extends Omit<CliProcessOptions, 'onSpawn'> {
  /** Send the first message; stdin stays open until the caller ends it. */
  start(stdin: Writable): void;
  /** One JSON object the CLI printed. Lines that are not one are skipped. */
  onRecord(record: Record<string, unknown>, stdin: Writable): void;
}

/**
 * Run a CLI that answers with one JSON object per line. Messages travel on
 * stdin, so a multi-line question never has to survive command-line quoting.
 * Tool results make some lines hundreds of KB; readline joins chunks once.
 */
export function runJsonlCli(options: JsonlCliRunOptions): Promise<CliProcessResult> {
  const { start, onRecord, ...processOptions } = options;
  return runCliProcess({
    ...processOptions,
    onSpawn: (child) => {
      const stdin = child.stdin!;
      readline
        .createInterface({ input: child.stdout!, crlfDelay: Infinity })
        .on('line', (line) => {
          const record = parseJsonLine(line);
          if (record && typeof record === 'object' && !Array.isArray(record)) {
            onRecord(record as Record<string, unknown>, stdin);
          }
        });
      start(stdin);
    },
  });
}

/** What a search CLI's events said by the time it exited. */
export interface SearchTurn {
  reply?: string;
  failure?: string;
}

/**
 * The reply a search turn ended with: a reported failure wins, and a CLI that
 * exited without a reply is explained by its stderr or exit code.
 */
export function searchTurnReply(
  turn: SearchTurn,
  result: CliProcessResult,
  cliName: string
): string {
  if (turn.failure !== undefined) {
    throw new Error(turn.failure);
  }
  if (turn.reply === undefined) {
    throw new Error(result.stderr.trim() || `${cliName} exited with code ${result.code}`);
  }
  return turn.reply;
}

/**
 * Hold a search conversation one CLI process per turn, for a CLI that ends
 * the conversation when it exits. `turn` runs one process for `message`;
 * `nextMessage` builds the message that carries a follow-up.
 */
export async function runTurnPerProcess(
  request: SessionSearchRunRequest,
  turn: (message: string, index: number) => Promise<string>,
  nextMessage: (reply: string, followUp: string) => string
): Promise<string> {
  let message = request.prompt;
  for (let index = 0; ; index++) {
    const reply = await turn(message, index);
    const followUp = request.followUp(reply);
    if (followUp === undefined) {
      return reply;
    }
    message = nextMessage(reply, followUp);
  }
}

/**
 * Stop a CLI and everything it started. On POSIX that needs the child to
 * lead its own process group (`detached: true`); on Windows the child is
 * cmd.exe, and killing it alone would leave the CLI running.
 */
export function stopProcessTree(child: ChildProcess, force: boolean): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
        'error',
        () => undefined
      );
    } else {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    // No such group (the child does not lead one, or it is gone): stop the
    // child itself, so a stop never depends on how it was started.
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}
