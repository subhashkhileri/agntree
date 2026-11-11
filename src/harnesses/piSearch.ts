import * as fs from 'fs';
import * as path from 'path';
import { generateId } from '../types';
import { PiSessionService, textFromContent, toHarnessSession } from '../services/PiSessionService';
import { clampInlineText } from '../utils/text';
import {
  commandExists,
  runJsonlCli,
  runTurnPerProcess,
  SEARCH_TIMEOUT_MS,
  SearchTurn,
  searchTurnReply,
} from './commandUtils';
import {
  HarnessSession,
  PreviewMessage,
  SessionSearchRunner,
  SessionSearchRunRequest,
  SessionSearchSource,
} from './types';

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
  readonly suggestedModels: readonly string[] = [];
  readonly efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

  constructor(private readonly options: PiSearchRunnerOptions) {}

  /** Whether the configured Pi CLI can actually be spawned. */
  isAvailable(): Promise<boolean> {
    return commandExists(this.options.command());
  }

  async run(request: SessionSearchRunRequest): Promise<string> {
    const session = { id: generateId(), dir: path.join(request.cwd, 'pi-sessions') };
    await fs.promises.mkdir(session.dir, { recursive: true });
    const deadline = Date.now() + (this.options.timeoutMs ?? SEARCH_TIMEOUT_MS);
    // Each turn resumes the same session, so a follow-up is the whole message.
    return runTurnPerProcess(
      request,
      (message, index) => this.turn(request, session, index === 0, message, deadline),
      (_reply, next) => next
    );
  }

  private async turn(
    request: SessionSearchRunRequest,
    session: { id: string; dir: string },
    first: boolean,
    message: string,
    deadline: number
  ): Promise<string> {
    const args = [
      '--print',
      '--mode',
      'json',
      '--session-dir',
      session.dir,
      ...(first ? ['--session-id', session.id] : ['--session', session.id]),
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

    const turn: SearchTurn = {};
    const result = await runJsonlCli({
      command: this.options.command(),
      args,
      cwd: request.cwd,
      signal: request.signal,
      deadline,
      timeoutMessage: 'Pi did not finish the search in time',
      // Pi reads piped stdin as the initial message.
      start: (stdin) => stdin.end(message),
      onRecord: (event) => {
        if (event.type === 'message_end' || event.type === 'turn_end') {
          const value = event.message as { role?: string; content?: unknown; stopReason?: unknown } | undefined;
          const text = value?.role === 'assistant' ? textFromContent(value.content) : '';
          if (text && terminalStop(value!.stopReason)) {
            turn.reply = text;
          }
        } else if (event.type === 'tool_execution_start') {
          const step = describePiTool(typeof event.toolName === 'string' ? event.toolName : '', event.args);
          if (step) {
            request.onActivity(step);
          }
        } else if (event.type === 'agent_settled' && event.aborted === true) {
          turn.failure = 'Pi aborted the search';
        } else if (event.type === 'error') {
          const detail =
            typeof event.message === 'string' ? event.message : typeof event.error === 'string' ? event.error : '';
          if (detail) {
            turn.failure = clampInlineText(detail, 300);
          }
        }
      },
    });
    return searchTurnReply(turn, result, 'Pi');
  }
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
