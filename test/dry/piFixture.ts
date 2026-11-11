/**
 * Synthetic Pi sessions under a temp directory. Tests never read the
 * developer's `~/.pi`: the fixture sets `PI_CODING_AGENT_DIR` and `HOME` for
 * the test and restores the environment afterwards.
 */
import * as fs from 'fs';
import * as path from 'path';
import { encodePiProjectDir } from '../../src/utils/paths';
import { setEnv, tempDir } from './support';

type Hooks = { after(fn: () => void): void };

let entrySequence = 0;
const entryId = () => `entry-${++entrySequence}`;

const iso = (at: number) => new Date(at).toISOString();

const header = (sessionId: string, cwd: string, at: number) => ({
  type: 'session',
  version: 3,
  id: sessionId,
  timestamp: iso(at),
  cwd,
});

const assistant = (
  text: string,
  stopReason = 'stop',
  at = Date.now(),
  overrides: Record<string, unknown> = {}
) => ({
  type: 'message',
  id: entryId(),
  parentId: null,
  timestamp: iso(at),
  message: {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 15,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.01,
      },
    },
    stopReason,
    timestamp: at,
    ...overrides,
  },
});

/** Session entries. `write()` adds the header and derives the file name. */
export const piEntry = {
  modelChange: (provider = 'test-provider', modelId = 'test-model', at = Date.now()) => ({
    type: 'model_change',
    id: entryId(),
    parentId: null,
    timestamp: iso(at),
    provider,
    modelId,
  }),
  sessionInfo: (name: string, at = Date.now()) => ({
    type: 'session_info',
    id: entryId(),
    parentId: null,
    timestamp: iso(at),
    name,
  }),
  user: (text: string, at = Date.now()) => ({
    type: 'message',
    id: entryId(),
    parentId: null,
    timestamp: iso(at),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: at,
    },
  }),
  assistant,
  toolUse: (toolName = 'bash', at = Date.now()) =>
    assistant('', 'toolUse', at, {
      content: [{ type: 'toolCall', id: 'call_1', name: toolName, arguments: {} }],
    }),
  toolResult: (toolCallId = 'call_1', text = 'ok', at = Date.now()) => ({
    type: 'message',
    id: entryId(),
    parentId: null,
    timestamp: iso(at),
    message: {
      role: 'toolResult',
      toolCallId,
      toolName: 'bash',
      content: [{ type: 'text', text }],
      isError: false,
      timestamp: at,
    },
  }),
};

export function piProfile(t: Hooks) {
  const root = tempDir(t, 'agntree-pi-');
  const home = path.join(root, 'home');
  const agentDir = path.join(root, 'agent');
  setEnv(t, {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: undefined,
    HOME: home,
    USERPROFILE: home,
  });
  const sessionsRoot = path.join(agentDir, 'sessions');

  return {
    /** Create a directory under the profile root. */
    dir(name: string): string {
      const dir = path.join(root, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    /** The directory Pi uses for sessions started in `cwd`. */
    sessionDir(cwd: string): string {
      return path.join(sessionsRoot, encodePiProjectDir(cwd));
    },
    /**
     * Write a session record with a header at `at`; returns its path. The file
     * name uses the header's timestamp, as Pi's does.
     */
    write(
      sessionId: string,
      cwd: string,
      entries: object[],
      options: { at?: number; dir?: string } = {}
    ): string {
      const at = options.at ?? Date.now();
      const dir = options.dir ?? this.sessionDir(cwd);
      fs.mkdirSync(dir, { recursive: true });
      const timestamp = iso(at).replace(/[:.]/g, '-');
      const file = path.join(dir, `${timestamp}_${sessionId}.jsonl`);
      fs.writeFileSync(
        file,
        [header(sessionId, cwd, at), ...entries]
          .map((entry) => `${JSON.stringify(entry)}\n`)
          .join('')
      );
      return file;
    },
    /** Append entries to an existing record. */
    append(file: string, entries: object[]): void {
      fs.appendFileSync(
        file,
        entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')
      );
    },
  };
}
