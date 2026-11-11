import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChildProcess, execFile, spawn } from 'child_process';
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

export interface CliProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Absolute time by which the CLI must exit. */
  deadline: number;
  timeoutMessage: string;
  /** 'pipe' keeps stdin open for the caller; 'ignore' closes it. */
  stdin: 'ignore' | 'pipe';
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
 * protocol through `onSpawn`.
 */
export function runCliProcess(options: CliProcessOptions): Promise<CliProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error('Search cancelled'));
      return;
    }
    const cli = harnessInvocation(options.command, options.args);
    const child = spawn(cli.command, cli.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: cli.shell,
      windowsHide: true,
      detached: !cli.shell,
      stdio: [options.stdin, 'pipe', 'pipe'],
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

    const finish = (error: Error | undefined, result?: CliProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(outputTimer);
      options.signal.removeEventListener('abort', stop);
      if (error) {
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
    child.stdin?.on('error', () => undefined);
    child.on('error', (error) => finish(error));
    // 'close' waits for every holder of the output pipes; a grandchild that
    // outlives the CLI must not keep the search open.
    child.on('exit', () => {
      outputTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr!.destroy();
      }, OUTPUT_GRACE_MS);
    });
    child.on('close', (code) => {
      if (options.signal.aborted) {
        finish(new Error('Search cancelled'));
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

export interface JsonlCliRunOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** Absolute time by which the CLI must exit. */
  deadline: number;
  timeoutMessage: string;
  /** The first message, written to stdin and then closed. */
  prompt: string;
  /** One JSONL record, without its line ending. */
  onLine(line: string): void;
  /**
   * The caller's result after the last line. Returning an `error` rejects the
   * run; undefined resolves it. Read whatever `onLine` collected.
   */
  complete(code: number | null, stderr: string): { error?: string } | undefined;
}

/**
 * Run a read-only search CLI that writes one JSON object per line and ends
 * the conversation when the process exits. The prompt travels on stdin, so a
 * multi-line question never has to survive command-line quoting. `onLine`
 * gets every complete record; `complete` runs once the process ends.
 */
export async function runJsonlCli(options: JsonlCliRunOptions): Promise<void> {
  let buffer = '';
  const handleLine = (line: string): void => {
    if (line) {
      options.onLine(line.replace(/\r$/, ''));
    }
  };

  const result = await runCliProcess({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    deadline: options.deadline,
    timeoutMessage: options.timeoutMessage,
    stdin: 'pipe',
    onSpawn: (child) => {
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handleLine(line);
        }
      });
      child.stdin!.end(options.prompt);
    },
  });

  // A last line without its newline is still a complete record.
  handleLine(buffer);
  const outcome = options.complete(result.code, result.stderr);
  if (outcome?.error) {
    throw new Error(outcome.error);
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
