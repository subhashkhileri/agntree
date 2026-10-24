import { execFile, ExecFileOptions } from 'child_process';
import * as vscode from 'vscode';
import { getHarnessCommand } from '../harnesses/commandUtils';

const CACHE_TTL_MS = 10_000;
const TIMEOUT_MS = 5_000;
const MAX_BUFFER = 2 * 1024 * 1024;

/** The fields Agntree reads from one `claude agents --json` row. */
export interface ClaudeAgentState {
  sessionId: string;
  /** Raw waiting reason; "input needed" when Claude reports waiting without one. */
  waitingFor?: string;
  startedAt?: number;
}

export type ClaudeAgentsExec = (
  command: string,
  args: string[],
  options: ExecFileOptions
) => Promise<string>;

export interface ClaudeAgentsServiceOptions {
  command?: () => string;
  /** Read `agntree.notifications.onNeedsInput` without spawning when off. */
  enabled?: () => boolean;
  exec?: ClaudeAgentsExec;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function execClaudeAgents(
  command: string,
  args: string[],
  options: ExecFileOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(String(stdout));
    });
  });
}

/**
 * Parse `claude agents --json`. Unknown fields are absent, a duplicate session
 * ID merges deterministically (a real waiting reason wins; otherwise the
 * newest `startedAt`), and `status: waiting` without a reason still produces a
 * notification reason.
 */
export function parseClaudeAgents(
  stdout: string
): Map<string, ClaudeAgentState> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return new Map();
  }

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error('claude agents --json did not return an array');
  }

  const states = new Map<string, ClaudeAgentState>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.sessionId !== 'string' || !record.sessionId) {
      continue;
    }

    const status = typeof record.status === 'string' ? record.status : null;
    let waitingFor =
      typeof record.waitingFor === 'string' ? record.waitingFor.trim() : '';
    if (status === 'waiting' && !waitingFor) {
      waitingFor = 'input needed';
    }

    const state: ClaudeAgentState = {
      sessionId: record.sessionId,
      waitingFor: waitingFor || undefined,
      startedAt:
        typeof record.startedAt === 'number' ? record.startedAt : undefined,
    };

    const existing = states.get(state.sessionId);
    if (!existing) {
      states.set(state.sessionId, state);
      continue;
    }

    const incomingWaiting = Boolean(state.waitingFor);
    const existingWaiting = Boolean(existing.waitingFor);
    const keepIncoming =
      incomingWaiting !== existingWaiting
        ? incomingWaiting
        : (state.startedAt ?? 0) >= (existing.startedAt ?? 0);
    if (keepIncoming) {
      states.set(state.sessionId, state);
    }
  }

  return states;
}

/**
 * Reads the live process state Claude Code exposes through
 * `claude agents --json`. The attention tick uses it for needs-you reasons.
 *
 * One call is shared by concurrent callers and cached for 10 seconds. A
 * failure disables the interface until the extension host restarts: turn-end
 * notifications and everything else keep working.
 */
export class ClaudeAgentsService {
  private readonly command: () => string;
  private readonly enabled: () => boolean;
  private readonly exec: ClaudeAgentsExec;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  private cache:
    | { at: number; states: Map<string, ClaudeAgentState> }
    | undefined;
  private inFlight: Promise<Map<string, ClaudeAgentState>> | undefined;
  private unavailable = false;

  constructor(options: ClaudeAgentsServiceOptions = {}) {
    this.command =
      options.command ?? (() => getHarnessCommand('claude', 'claude'));
    this.enabled =
      options.enabled ??
      (() =>
        vscode.workspace
          .getConfiguration('agntree')
          .get<boolean>('notifications.onNeedsInput', true));
    this.exec = options.exec ?? execClaudeAgents;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  async getStates(): Promise<Map<string, ClaudeAgentState>> {
    if (!this.enabled() || this.unavailable) {
      return new Map();
    }

    if (this.cache && this.now() - this.cache.at < CACHE_TTL_MS) {
      return this.cache.states;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const request = this.fetchStates();
    this.inFlight = request;
    try {
      const states = await request;
      this.cache = { at: this.now(), states };
      return states;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async fetchStates(): Promise<Map<string, ClaudeAgentState>> {
    try {
      const stdout = await this.exec(this.command(), ['agents', '--json'], {
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        env: this.env,
        windowsHide: true,
        // npm installs the CLI as a `.cmd` shim on Windows, which execFile
        // cannot start without a shell.
        shell: process.platform === 'win32',
      });
      return parseClaudeAgents(stdout);
    } catch (error) {
      // Log once; retrying a missing/broken CLI on every tick is noise.
      this.unavailable = true;
      console.error(
        '[Agntree] Could not read `claude agents --json`; needs-you notifications are off until the extension restarts:',
        error
      );
      return new Map();
    }
  }
}
