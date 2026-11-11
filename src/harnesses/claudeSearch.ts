import { spawn } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { ClaudeSessionService, toHarnessSession } from '../services/ClaudeSessionService';
import { encodeClaudeProjectPath, isStrictlyWithin } from '../utils/paths';
import { clampInlineText, errorMessage } from '../utils/text';
import { harnessInvocation, stopProcessTree } from './commandUtils';
import {
  SessionSearchRunner,
  SessionSearchRunRequest,
  SessionSearchRunResult,
  SessionSearchSource,
} from './types';

/** Claude session IDs are UUIDs; anything else is not a transcript name. */
const SESSION_ID = /^[\w-]+$/;

/**
 * Claude Code sessions as a search source. The agent greps the JSONL
 * transcripts itself; these instructions carry what it cannot guess, chiefly
 * that every session repeats the user's CLAUDE.md, so only typed prompts are
 * evidence.
 */
export class ClaudeSessionSearch implements SessionSearchSource {
  constructor(private readonly sessions: ClaudeSessionService) {}

  readableDirs(): string[] {
    return [this.sessions.getProjectsDirectory()];
  }

  instructions({ excludedCwds }: { excludedCwds: string[] }): string {
    const projects = this.sessions.getProjectsDirectory();
    const lines = [
      `- Transcripts are JSONL files at ${projects}/<folder>/<session ID>.jsonl, where <folder> is the session's working directory with every character other than A-Z, a-z and 0-9 replaced by "-". The file name without ".jsonl" is the session ID. Directories beside the transcripts (subagents, tool results) are not sessions.`,
      '- Each line is one JSON object with "type", "timestamp" and "cwd" (the folder the session ran in). An "ai-title" line holds the session\'s name.',
      '- The user\'s own prompts are "type":"user" lines whose message content is a string or a list of "text" blocks; most contain `"type":"user","message":{"role":"user","content":"`. Skip lines marked "isMeta":true, "isCompactSummary":true or "isSidechain":true, and prompts that begin with "<" (command output, system reminders).',
      '- Text inside <system-reminder> tags repeats the user\'s standing instructions in every session, so matching it proves nothing.',
      '- Files the agent touched appear in "tool_use" inputs on "type":"assistant" lines; they are good evidence of what was done.',
      '- Transcripts can be large: find candidate files with Grep in files_with_matches mode first, then search narrowly and Read only the lines you need. Glob lists the newest files first.',
    ];
    for (const cwd of excludedCwds) {
      lines.push(`- Never search ${path.join(projects, encodeClaudeProjectPath(cwd))}: it holds this search's own files.`);
    }
    return lines.join('\n');
  }

  async verify(sessionId: string, quote: string) {
    if (!SESSION_ID.test(sessionId)) {
      return null;
    }
    const found = await this.sessions.findSessionPrompt(sessionId, quote);
    if (!found?.session.hasMessages) {
      return null;
    }
    return { session: toHarnessSession(found.session), prompt: found.prompt };
  }
}

export interface ClaudeSearchRunnerOptions {
  command: () => string;
  projectsDir: () => string;
  timeoutMs?: number;
}

// Greps over a large history on a slow disk have taken over four minutes.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** How long a stopped CLI gets to exit before it is killed outright. */
const KILL_GRACE_MS = 5_000;
/** How long after the CLI exits a grandchild may hold its output open. */
const OUTPUT_GRACE_MS = 2_000;
const STDERR_TAIL = 2_000;
const MAX_PROJECT_NAME = 200;

/**
 * Runs the session finder as `claude --print` with only Read, Grep and Glob.
 * Without an allow list Claude refuses reads outside its working directory
 * and `--add-dir`, so the agent sees transcripts and nothing else. Messages go
 * in as stream-json on stdin, so a follow-up reaches the same agent in the
 * same process; progress and each reply come from the stream-json events.
 */
export class ClaudeSearchRunner implements SessionSearchRunner {
  readonly defaultModel = 'haiku';
  readonly suggestedModels = ['haiku', 'sonnet', 'opus'] as const;
  readonly efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  constructor(private readonly options: ClaudeSearchRunnerOptions) {}

  async run(request: SessionSearchRunRequest): Promise<SessionSearchRunResult> {
    // Claude shortens longer project names with a hash it does not document,
    // and cleanup must find the directory by its exact name.
    if (encodeClaudeProjectPath(request.cwd).length > MAX_PROJECT_NAME) {
      throw new Error(`The search folder's path is too long for Claude Code: ${request.cwd}`);
    }
    const args = [
      '--print',
      '--model',
      request.model,
      '--effort',
      request.effort,
      '--tools',
      'Read,Grep,Glob',
      ...request.readableDirs.flatMap((dir) => ['--add-dir', dir]),
      '--no-session-persistence',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    try {
      return await this.spawn(this.options.command(), args, request);
    } finally {
      // --no-session-persistence keeps the transcript out, but Claude still
      // creates the cwd's project directory and saves large tool output in
      // it, where the next search would find it.
      await this.removeLeftovers(request.cwd);
    }
  }

  private spawn(command: string, args: string[], request: SessionSearchRunRequest): Promise<SessionSearchRunResult> {
    return new Promise((resolve, reject) => {
      const cli = harnessInvocation(command, args);
      // The override would put the search's leftovers in a real project's
      // directory, where cleanup cannot tell them apart.
      const { CLAUDE_CODE_PROJECT_DIR_NAME: _override, ...env } = process.env;
      const child = spawn(cli.command, cli.args, {
        cwd: request.cwd,
        env,
        shell: cli.shell,
        windowsHide: true,
        // Its own process group on POSIX, so stopping it also stops the
        // ripgrep processes its searches start.
        detached: !cli.shell,
      });

      let reply: string | undefined;
      let costUsd: number | undefined;
      let failure: string | undefined;
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const send = (text: string): void => {
        child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
      };

      /** Each turn ends in a result event: ask for the next message, or close stdin so the CLI exits. */
      const handleResult = (event: Record<string, unknown>): void => {
        // The cost is a running total for the whole conversation.
        if (typeof event.total_cost_usd === 'number') {
          costUsd = event.total_cost_usd;
        }
        if (event.is_error) {
          failure = resultError(event);
          child.stdin.end();
          return;
        }
        const text = typeof event.result === 'string' ? event.result : '';
        let next: string | undefined;
        try {
          next = request.followUp(text);
        } catch (error) {
          failure = errorMessage(error);
          child.stdin.end();
          return;
        }
        if (next === undefined) {
          reply = text;
          child.stdin.end();
        } else {
          send(next);
        }
      };

      const handleLine = (line: string): void => {
        let event: { type?: string; message?: { content?: unknown } } & Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        if (event.type === 'result') {
          handleResult(event);
        } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content as { type?: string; name?: string; input?: unknown }[]) {
            const step = block?.type === 'tool_use' ? describeToolUse(block.name, block.input) : undefined;
            if (step) {
              request.onActivity(step);
            }
          }
        }
      };

      let killTimer: NodeJS.Timeout | undefined;
      let outputTimer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        if (killTimer) {
          return;
        }
        stopProcessTree(child, false);
        killTimer = setTimeout(() => stopProcessTree(child, true), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      request.signal.addEventListener('abort', stop, { once: true });

      const finish = (error: Error | undefined, value?: SessionSearchRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        clearTimeout(outputTimer);
        request.signal.removeEventListener('abort', stop);
        if (error) {
          reject(error);
        } else {
          resolve(value!);
        }
      };

      // Tool results make some lines hundreds of KB; readline joins chunks once.
      readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', handleLine);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });
      child.on('error', (error) => finish(error));
      // 'close' waits for every holder of the output pipes; a grandchild
      // that outlives the CLI must not keep the search open.
      child.on('exit', () => {
        outputTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, OUTPUT_GRACE_MS);
      });
      child.on('close', (code) => {
        if (request.signal.aborted) {
          finish(new Error('Search cancelled'));
        } else if (timedOut) {
          finish(new Error('Claude Code did not finish the search in time'));
        } else if (failure !== undefined) {
          finish(new Error(failure));
        } else if (reply === undefined) {
          finish(new Error(stderr.trim() || `Claude Code exited with code ${code}`));
        } else {
          finish(undefined, { reply, costUsd });
        }
      });

      if (request.signal.aborted) {
        stop();
      }
      // The CLI may exit before reading its prompt; that is reported on close.
      child.stdin.on('error', () => undefined);
      send(request.prompt);
    });
  }

  /**
   * Remove the project directory Claude made for the search's own cwd, and
   * nothing else: only the exact name, since a prefix could name another
   * project's sessions.
   */
  private async removeLeftovers(cwd: string): Promise<void> {
    const projects = this.options.projectsDir();
    const dir = path.join(projects, encodeClaudeProjectPath(cwd));
    if (isStrictlyWithin(dir, projects)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
}

/** One line per tool call, e.g. `Grep "usage mod"` or `Read 5d77….jsonl`. */
function describeToolUse(name: string | undefined, input: unknown): string | undefined {
  const args = (input ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? clampInlineText(value, 60) : '');
  switch (name) {
    case 'Grep':
      return `Grep "${text(args.pattern)}"`;
    case 'Glob':
      return `Glob ${text(args.pattern)}`;
    case 'Read':
      return `Read ${typeof args.file_path === 'string' ? path.basename(args.file_path) : 'a file'}`;
    default:
      return name;
  }
}

function resultError(result: Record<string, unknown>): string {
  const text = typeof result.result === 'string' ? result.result.trim() : '';
  if (text) {
    return clampInlineText(text, 300);
  }
  return `Claude Code stopped: ${typeof result.subtype === 'string' ? result.subtype : 'unknown error'}`;
}
