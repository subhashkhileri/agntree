import * as fs from 'fs';
import * as path from 'path';
import { generateId } from '../types';
import {
  PiSessionService,
  toHarnessSession,
} from '../services/PiSessionService';
import { clampInlineText, errorMessage } from '../utils/text';
import { commandExists, runJsonlCli } from './commandUtils';
import {
  HarnessSession,
  PreviewMessage,
  SessionSearchRunner,
  SessionSearchRunRequest,
  SessionSearchRunResult,
  SessionSearchSource,
} from './types';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Read-only built-ins; no bash, edit, or write reaches the agent. */
const READ_ONLY_TOOLS = 'read,grep,find,ls';

/**
 * Pi sessions as a search source. The agent greps the documented JSONL
 * records itself; the instructions carry what it cannot guess, chiefly that
 * the first line is a header and that system, assistant, and toolResult
 * entries are not user prompts.
 */
export class PiSessionSearch implements SessionSearchSource {
  constructor(private readonly sessions: PiSessionService) {}

  readableDirs(): string[] {
    return this.sessions.searchDirectories();
  }

  instructions({ excludedCwds }: { excludedCwds: string[] }): string {
    const dirs = this.readableDirs();
    const lines = [
      `- Records are JSONL files under ${dirs.join(' and ')}. Normally they sit in one directory per working directory, named after its path with separators and ":" replaced by "-"; a flat sessionDir may hold every project's records directly.`,
      '- The first line is {"type":"session","version":3,"id":"<session ID>","cwd":"<working directory>","timestamp":...}. The file name is <timestamp>_<session ID>.jsonl and the header\'s "id" is authoritative. Directories are not sessions.',
      '- The user\'s own prompts are entries with "type":"message" and "message":{"role":"user"}; message.content is a string or a list of {"type":"text","text":...} blocks. Entries with role "system", "assistant", "toolResult", or "custom" are never prompts.',
      '- The system message holds Pi\'s prompt and tool loadout and repeats in every session, so matching it proves nothing. Assistant messages hold replies plus "thinking" and "toolCall" blocks; toolResult entries hold tool output. Tool calls name files and commands and are good evidence of what was done.',
      '- A "session_info" entry holds the /name display name. "context_edit" entries hide or replace an earlier entry from future context; they do not add a prompt. "compaction" and "branch_summary" entries are summaries, not prompts. Records are a tree, so a prompt on an abandoned branch can still appear in the file.',
      '- Records can be large. Use Grep in files_with_matches mode first, then search narrowly and Read only the lines you need. Glob lists the newest files first.',
    ];
    for (const cwd of excludedCwds) {
      lines.push(`- Never search a record whose session header cwd is ${cwd}: it belongs to this search itself.`);
    }
    return lines.join('\n');
  }

  async verify(
    sessionId: string,
    quote: string
  ): Promise<{ session: HarnessSession; prompt?: PreviewMessage } | null> {
    const found = await this.sessions.findSessionPrompt(sessionId, quote);
    return found
      ? { session: toHarnessSession(found.session), prompt: found.prompt }
      : null;
  }
}

export interface PiSearchRunnerOptions {
  command: () => string;
  timeoutMs?: number;
}

/**
 * Runs the session finder as `pi --print --mode json` with only the built-in
 * read, grep, find, and ls tools. The user's settings, extensions, skills,
 * context files, and configured model stay in effect; MCP tools are denied
 * because their servers can write or reach a network. The session lives in a
 * directory under the search's own folder, so a follow-up resumes the same
 * conversation while the user's session store is untouched; it is removed
 * with the search folder.
 */
export class PiSearchRunner implements SessionSearchRunner {
  /** Empty means the model configured for the user's Pi install. */
  readonly defaultModel = '';
  readonly suggestedModels: readonly string[] = [];
  readonly efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

  constructor(private readonly options: PiSearchRunnerOptions) {}

  /** Whether the configured Pi CLI can actually be spawned. */
  isAvailable(): Promise<boolean> {
    return commandExists(this.options.command());
  }

  async run(request: SessionSearchRunRequest): Promise<SessionSearchRunResult> {
    const sessionId = generateId();
    const sessionDir = path.join(request.cwd, 'pi-sessions');
    await fs.promises.mkdir(sessionDir, { recursive: true });
    const deadline = Date.now() + (this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let message = request.prompt;
    let first = true;

    for (;;) {
      if (Date.now() >= deadline) {
        throw new Error('Pi did not finish the search in time');
      }
      const result = await this.invocation(
        request,
        { sessionId, sessionDir, first },
        message,
        deadline
      );
      first = false;
      let next: string | undefined;
      try {
        next = request.followUp(result.reply);
      } catch (error) {
        throw new Error(errorMessage(error));
      }
      if (next === undefined) {
        return { reply: result.reply };
      }
      message = next;
    }
  }

  private async invocation(
    request: SessionSearchRunRequest,
    session: { sessionId: string; sessionDir: string; first: boolean },
    message: string,
    deadline: number
  ): Promise<{ reply: string }> {
    const args = [
      '--print',
      '--mode',
      'json',
      '--session-dir',
      session.sessionDir,
      ...(session.first
        ? ['--session-id', session.sessionId]
        : ['--session', session.sessionId]),
      '--tools',
      READ_ONLY_TOOLS,
      // --tools keeps MCP tools; this denies them while their configuration
      // stays as the user set it.
      '--exclude-tools',
      'mcp__*',
    ];
    if (request.model) {
      args.push('--model', request.model);
    }
    if (request.effort) {
      args.push('--thinking', request.effort);
    }

    let reply: string | undefined;
    let failure: string | undefined;

    await runJsonlCli({
      command: this.options.command(),
      args,
      cwd: request.cwd,
      signal: request.signal,
      deadline,
      timeoutMessage: 'Pi did not finish the search in time',
      // Pi reads piped stdin as the initial message, so a multi-line prompt
      // never has to survive cmd.exe quoting on Windows.
      prompt: message,
      onLine: (line) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type === 'message_end' || event.type === 'turn_end') {
          const value = event.message as
            | { role?: string; content?: unknown; stopReason?: unknown }
            | undefined;
          if (value?.role === 'assistant') {
            const text = assistantText(value.content);
            if (text && terminalStop(value.stopReason)) {
              reply = text;
            }
          }
          return;
        }
        if (event.type === 'tool_execution_start') {
          const step = describePiTool(
            typeof event.toolName === 'string' ? event.toolName : '',
            event.args
          );
          if (step) {
            request.onActivity(step);
          }
          return;
        }
        if (event.type === 'agent_settled' && event.aborted === true) {
          failure = 'Pi aborted the search';
          return;
        }
        if (event.type === 'error') {
          const detail =
            typeof event.message === 'string'
              ? event.message
              : typeof event.error === 'string'
                ? event.error
                : '';
          if (detail) {
            failure = clampInlineText(detail, 300);
          }
        }
      },
      complete: (code, stderr) => {
        if (failure !== undefined) {
          return { error: failure };
        }
        if (reply === undefined) {
          return {
            error: stderr.trim() || `Pi exited with code ${code}`,
          };
        }
        return undefined;
      },
    });

    return { reply: reply! };
  }
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter(
      (block): block is { type?: string; text?: string } =>
        Boolean(block) && typeof block === 'object'
    )
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!.trim())
    .filter(Boolean)
    .join('\n');
}

/** A terminal assistant message ends the turn; `toolUse` means more follows. */
function terminalStop(stopReason: unknown): boolean {
  return (
    typeof stopReason !== 'string' ||
    (stopReason !== 'toolUse' && stopReason !== 'pending')
  );
}

/** One line per tool call, e.g. `Grep "usage mod"` or `Read 5d77….jsonl`. */
function describePiTool(name: string, args: unknown): string | undefined {
  const input = (args ?? {}) as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === 'string' ? clampInlineText(value, 60) : '';
  const base = (value: unknown) =>
    typeof value === 'string' && value ? path.basename(value) : '';
  switch (name) {
    case 'read':
      return `Read ${base(input.path) || 'a file'}`;
    case 'grep':
      return `Grep "${text(input.pattern)}"`;
    case 'find':
      return `Find ${text(input.pattern ?? input.glob)}`;
    case 'ls':
      return `List ${base(input.path) || 'a directory'}`;
    default:
      return name || undefined;
  }
}
