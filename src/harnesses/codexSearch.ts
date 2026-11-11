import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CodexAppServer,
  CodexItemEntry,
  codexItemTimestamp,
  codexThreadToHarnessSession,
  codexUserMessageText,
  isVisibleCodexThread,
} from '../services/CodexAppServer';
import { clampInlineText, promptMatcher } from '../utils/text';
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

/** Codex thread IDs are UUIDs; anything else is not a thread ID. */
const SESSION_ID = /^[\w-]+$/;
const ITEMS_PER_PAGE = 100;
const MAX_ITEM_PAGES = 20;

/** The Codex profile, which `CODEX_HOME` can move. */
function codexHomeDirectory(): string {
  const home = process.env.CODEX_HOME?.trim();
  return home ? path.resolve(home) : path.join(os.homedir(), '.codex');
}

/** The rollouts an agent can read. */
function codexSessionsDirectory(): string {
  return path.join(codexHomeDirectory(), 'sessions');
}

/**
 * Codex sessions as a search source. The agent reads the rollout JSONL files
 * itself; `verify()` uses the app-server's item history, which returns the
 * user's typed prompts without the AGENTS.md and environment context Codex
 * writes into the rollout.
 */
export class CodexSessionSearch implements SessionSearchSource {
  constructor(private readonly appServer: Pick<CodexAppServer, 'readThread' | 'listItems'>) {}

  readableDirs(): string[] {
    return [codexSessionsDirectory()];
  }

  instructions({ excludedCwds }: { excludedCwds: string[] }): string {
    const sessions = codexSessionsDirectory();
    const lines = [
      `- Rollouts are JSONL files at ${sessions}/<YYYY>/<MM>/<DD>/rollout-<timestamp>-<session ID>.jsonl. The session ID is the suffix of the file name and the "id" in the first line's payload. Files ending in ".zst" are compressed and cannot be read.`,
      '- The first line is {"type":"session_meta","payload":{...}} with "id", "cwd", "originator", "thread_source", and possibly "parent_thread_id" or "source.subagent". Skip a rollout with parent_thread_id or source.subagent: it is a subagent or guardian run, not a top-level session the user can resume. Top-level sessions have "thread_source":"user".',
      '- Later lines are one JSON object each. The user\'s typed prompts are "type":"response_item" lines whose payload.type is "message", payload.role is "user", and content is a list of {"type":"input_text","text":...} blocks.',
      '- The first user message usually bundles "# AGENTS.md instructions for <cwd>" and "<environment_context>". Those, and any other text beginning with "<", are injected context, not prompts. AGENTS.md and developer/system messages repeat in every session, so matching them proves nothing.',
      '- Assistant text is payload.type "message", payload.role "assistant", with content blocks of type "output_text". Tool calls and their outputs are other response_item payload types (for example custom_tool_call, function_call, local_shell_call); their arguments name files and commands and are good evidence of what was done.',
      '- Rollouts can be large. Use Grep in files_with_matches mode first, then search narrowly and Read only the lines you need. Glob lists the newest files first.',
    ];
    for (const cwd of excludedCwds) {
      lines.push(`- Never search rollouts whose session_meta payload.cwd is ${cwd}: they belong to this search itself.`);
    }
    return lines.join('\n');
  }

  async verify(
    sessionId: string,
    quote: string
  ): Promise<{ session: HarnessSession; prompt?: PreviewMessage } | null> {
    if (!SESSION_ID.test(sessionId)) {
      return null;
    }
    // A failed read rejects, and the finder drops the match.
    const { thread } = await this.appServer.readThread(sessionId);
    if (!isVisibleCodexThread(thread)) {
      return null;
    }
    return {
      session: codexThreadToHarnessSession(thread),
      prompt: await findCodexPrompt(this.appServer, sessionId, quote),
    };
  }
}

/** The earliest user prompt in the thread that opens with `quote`. */
async function findCodexPrompt(
  appServer: Pick<CodexAppServer, 'listItems'>,
  threadId: string,
  quote: string
): Promise<PreviewMessage | undefined> {
  const matches = promptMatcher(quote);
  if (!matches) {
    return undefined;
  }

  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    let response;
    try {
      response = await appServer.listItems(threadId, {
        limit: ITEMS_PER_PAGE,
        sortDirection: 'asc',
        cursor,
      });
    } catch {
      return undefined;
    }
    for (const entry of response.data) {
      const text = typedPrompt(entry);
      if (text && matches(text)) {
        return { text, timestamp: codexItemTimestamp(entry) };
      }
    }
    const next = response.nextCursor ?? undefined;
    if (!next || response.data.length === 0 || seenCursors.has(next)) {
      return undefined;
    }
    seenCursors.add(next);
    cursor = next;
  }
  return undefined;
}

/** A userMessage item's text, unless it is injected context. */
function typedPrompt(entry: CodexItemEntry): string | null {
  const text = codexUserMessageText(entry.item);
  // Current app-servers omit injected context from items; a future one that
  // returns it must not turn AGENTS.md or environment output into a prompt.
  if (!text || text.startsWith('# AGENTS.md instructions') || text.startsWith('<')) {
    return null;
  }
  return text;
}

export interface CodexSearchRunnerOptions {
  command: () => string;
  timeoutMs?: number;
}

/**
 * Runs the session finder as `codex exec` with a read-only sandbox. The
 * user's Codex config supplies the model, provider, approval policy, hooks,
 * and rules; the run is ephemeral, so it leaves no thread behind, and the
 * MCP servers declared in the config are switched off for the run because
 * their tools can write. `codex exec` keeps no conversation across processes,
 * so a correction re-runs the search with the prompt and the previous reply in
 * view.
 */
export class CodexSearchRunner implements SessionSearchRunner {
  readonly suggestedModels: readonly string[] = [];
  readonly efforts = ['low', 'medium', 'high', 'xhigh'] as const;

  constructor(private readonly options: CodexSearchRunnerOptions) {}

  /** Whether the configured Codex CLI can actually be spawned. */
  isAvailable(): Promise<boolean> {
    return commandExists(this.options.command());
  }

  async run(request: SessionSearchRunRequest): Promise<string> {
    const deadline = Date.now() + (this.options.timeoutMs ?? SEARCH_TIMEOUT_MS);
    const mcp = await codexMcpServerOverrides();
    return runTurnPerProcess(
      request,
      (message) => this.turn(request, mcp, message, deadline),
      (reply, next) => `${request.prompt}\n\nYour previous reply was:\n${reply}\n\n${next}`
    );
  }

  private async turn(
    request: SessionSearchRunRequest,
    mcp: string[],
    message: string,
    deadline: number
  ): Promise<string> {
    const args = [
      'exec',
      // A search leaves no thread or rollout in the user's profile.
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--json',
      ...mcp,
    ];
    if (request.model) {
      args.push('--model', request.model);
    }
    if (request.effort) {
      args.push('-c', `model_reasoning_effort=${request.effort}`);
    }

    const turn: SearchTurn = {};
    const result = await runJsonlCli({
      command: this.options.command(),
      args,
      cwd: request.cwd,
      signal: request.signal,
      deadline,
      timeoutMessage: 'Codex did not finish the search in time',
      // Codex reads the prompt from stdin when no argument is given.
      start: (stdin) => stdin.end(message),
      onRecord: (event) => {
        const item = event.item as
          | { type?: string; text?: string; command?: unknown; tool?: string }
          | undefined;
        if (event.type === 'item.started') {
          const step = describeCodexItem(item);
          if (step) {
            request.onActivity(step);
          }
        } else if (event.type === 'item.completed') {
          if (item?.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
            turn.reply = item.text;
          }
        } else if (event.type === 'error' && typeof event.message === 'string' && event.message) {
          turn.failure = clampInlineText(event.message, 300);
        }
      },
    });
    return searchTurnReply(turn, result, 'Codex');
  }
}

/**
 * `-c` overrides that switch off every MCP server declared in the user's
 * `config.toml`. Codex's `-c` parser takes a dotted key and does not accept a
 * quoted segment, so a name that is not a bare key, and a server a plugin
 * contributes, have no per-run switch and are left alone. An unreadable
 * config yields no overrides; Codex reports its own error in that case.
 */
async function codexMcpServerOverrides(): Promise<string[]> {
  let config: string;
  try {
    config = await fs.promises.readFile(path.join(codexHomeDirectory(), 'config.toml'), 'utf8');
  } catch {
    return [];
  }

  const names = new Set<string>();
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*(?:#.*)?$/.exec(line);
    if (match) {
      names.add(match[1]);
    }
  }

  return [...names].flatMap((name) => [
    '-c',
    `mcp_servers.${name}.enabled=false`,
  ]);
}

/** One line per tool call for the search row's activity. */
function describeCodexItem(
  item: { type?: string; command?: unknown; tool?: string } | undefined
): string | undefined {
  if (!item) {
    return undefined;
  }
  switch (item.type) {
    case 'command_execution': {
      const command = Array.isArray(item.command)
        ? item.command.filter((part) => typeof part === 'string').join(' ')
        : typeof item.command === 'string'
          ? item.command
          : '';
      return command
        ? `Exec ${clampInlineText(command.split('\n')[0], 60)}`
        : 'Exec a command';
    }
    case 'mcp_tool_call':
      return item.tool ? `MCP ${clampInlineText(item.tool, 60)}` : 'MCP call';
    case 'web_search':
      return 'Web search';
    case 'file_change':
      return 'Edit a file';
    default:
      return undefined;
  }
}
