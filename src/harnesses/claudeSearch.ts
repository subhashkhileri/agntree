import * as fs from 'fs';
import * as path from 'path';
import { Writable } from 'stream';
import { ClaudeSessionService, toHarnessSession } from '../services/ClaudeSessionService';
import { encodeClaudeProjectPath, isStrictlyWithin } from '../utils/paths';
import { clampInlineText, errorMessage } from '../utils/text';
import { commandExists, runJsonlCli, SEARCH_TIMEOUT_MS, SearchTurn, searchTurnReply } from './commandUtils';
import { SessionSearchRunner, SessionSearchRunRequest, SessionSearchSource } from './types';

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

const MAX_PROJECT_NAME = 200;
/** An empty MCP config Claude loads for the run; a file keeps its JSON out of quoting. */
const MCP_CONFIG_FILE = '.agntree-empty-mcp.json';

/**
 * Runs the session finder as `claude --print` with only Read, Grep and Glob.
 * Without an allow list Claude refuses reads outside its working directory
 * and `--add-dir`, so the agent sees transcripts and nothing else. Messages go
 * in as stream-json on stdin, so a follow-up reaches the same agent in the
 * same process; progress and each reply come from the stream-json events.
 *
 * The user's settings, skills, plugins, hooks, and configured model stay in
 * effect. Only MCP servers are turned off: their tools are not filtered by
 * `--tools`, and an MCP server can run code the search must not run.
 */
export class ClaudeSearchRunner implements SessionSearchRunner {
  readonly suggestedModels = ['haiku', 'sonnet', 'opus'] as const;
  readonly efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

  constructor(private readonly options: ClaudeSearchRunnerOptions) {}

  /** Whether the configured Claude Code CLI can actually be spawned. */
  isAvailable(): Promise<boolean> {
    return commandExists(this.options.command());
  }

  async run(request: SessionSearchRunRequest): Promise<string> {
    // Claude shortens longer project names with a hash it does not document,
    // and cleanup must find the directory by its exact name.
    if (encodeClaudeProjectPath(request.cwd).length > MAX_PROJECT_NAME) {
      throw new Error(`The search folder's path is too long for Claude Code: ${request.cwd}`);
    }
    // A file avoids passing quoted JSON through cmd.exe on Windows. It lives
    // in the search's own folder, which is removed afterwards.
    const mcpConfig = path.join(request.cwd, MCP_CONFIG_FILE);
    await fs.promises.writeFile(mcpConfig, '{"mcpServers":{}}', 'utf8');
    const args = [
      '--print',
      ...(request.model ? ['--model', request.model] : []),
      ...(request.effort ? ['--effort', request.effort] : []),
      '--tools',
      'Read,Grep,Glob',
      // MCP tools are not built-in and are not filtered by --tools. A strict
      // empty config keeps every other setting but lets no MCP server load.
      '--strict-mcp-config',
      '--mcp-config',
      mcpConfig,
      // An installed harness may not have written its first record yet, and
      // a missing --add-dir directory fails the whole run.
      ...request.readableDirs.filter((dir) => fs.existsSync(dir)).flatMap((dir) => ['--add-dir', dir]),
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
      await fs.promises.rm(mcpConfig, { force: true }).catch(() => undefined);
      // --no-session-persistence keeps the transcript out, but Claude still
      // creates the cwd's project directory and saves large tool output in
      // it, where the next search would find it.
      await this.removeLeftovers(request.cwd);
    }
  }

  private async spawn(command: string, args: string[], request: SessionSearchRunRequest): Promise<string> {
    const turn: SearchTurn = {};
    // The override would put the search's leftovers in a real project's
    // directory, where cleanup cannot tell them apart.
    const { CLAUDE_CODE_PROJECT_DIR_NAME: _override, ...env } = process.env;
    const send = (stdin: Writable, text: string): void => {
      stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
    };

    /** Each turn ends in a result event: send the next message, or close stdin so the CLI exits. */
    const handleResult = (event: Record<string, unknown>, stdin: Writable): void => {
      if (event.is_error) {
        turn.failure = resultError(event);
        stdin.end();
        return;
      }
      const text = typeof event.result === 'string' ? event.result : '';
      let next: string | undefined;
      try {
        next = request.followUp(text);
      } catch (error) {
        // This runs in a stream callback, where a throw would escape the run.
        turn.failure = errorMessage(error);
        stdin.end();
        return;
      }
      if (next === undefined) {
        turn.reply = text;
        stdin.end();
      } else {
        send(stdin, next);
      }
    };

    const result = await runJsonlCli({
      command,
      args,
      cwd: request.cwd,
      env,
      signal: request.signal,
      deadline: Date.now() + (this.options.timeoutMs ?? SEARCH_TIMEOUT_MS),
      timeoutMessage: 'Claude Code did not finish the search in time',
      // Messages stay open on stdin, so a follow-up reaches the same process.
      start: (stdin) => send(stdin, request.prompt),
      onRecord: (event, stdin) => {
        if (event.type === 'result') {
          handleResult(event, stdin);
          return;
        }
        const content = (event.message as { content?: unknown } | undefined)?.content;
        if (event.type === 'assistant' && Array.isArray(content)) {
          for (const block of content as { type?: string; name?: string; input?: unknown }[]) {
            const step = block?.type === 'tool_use' ? describeToolUse(block.name, block.input) : undefined;
            if (step) {
              request.onActivity(step);
            }
          }
        }
      },
    });
    return searchTurnReply(turn, result, 'Claude Code');
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
