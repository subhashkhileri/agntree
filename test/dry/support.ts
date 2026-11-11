/**
 * Shared plumbing for dry tests: typed access to the `vscode` stub's test
 * controls, in-memory storage, temp directories, polling, and fakes at the
 * harness boundary. Fakes here stand in for processes and the editor, never
 * for the code under test.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { StorageService } from '../../src/services/StorageService';
import { harnessTreeIcons } from '../../src/harnesses/treeIcons';
import {
  HarnessAdapter,
  HarnessSession,
  NativeUiCapability,
  NativeUiSurfaceTracker,
} from '../../src/harnesses/types';
import { ChatSession, HarnessId, Worktree } from '../../src/types';

/** A terminal created by the stub. */
export interface FakeTerminal {
  name: string;
  options: { name?: string; cwd?: string; iconPath?: { id: string }; __pid?: number; __exitStatus?: unknown };
  sent: string[];
  shown: number;
  disposed: boolean;
  __pid: number;
  exitStatus: unknown;
  shellIntegration: unknown;
  readonly processId: Promise<number>;
  sendText(text: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface FakeInputBox {
  value: string;
  title: string;
  buttons: unknown[];
  hidden: boolean;
  __accept(value: string): void;
  __triggerButton(index?: number): void;
}

interface StubControls {
  __reset(): void;
  __messages: unknown[][];
  __warningResponses: (string | undefined)[];
  __inputResponses: (string | undefined)[];
  __quickPickResponses: unknown[];
  __openDialogResponses: unknown[];
  __inputBoxes: FakeInputBox[];
  __fileWatchers: {
    pattern: { base: string; pattern: string };
    disposed: boolean;
    __fireChange(): void;
    __fireCreate(): void;
    __fireDelete(): void;
  }[];
  __deleted: { path: string; options?: { useTrash?: boolean } }[];
  __setQuickPickHandler(handler: ((items: any[], options?: any) => unknown) | null): void;
  __setConfiguration(key: string, value: unknown): void;
  __setExtensionInstalled(id: string, installed?: boolean): void;
  __setOpenExternalResult(value: boolean): void;
  __openExternalCalls: { toString(): string }[];
  __setSilentExecutionEvents(value: boolean): void;
  workspace: { workspaceFolders: { uri: { fsPath: string } }[] };
  window: {
    terminals: FakeTerminal[];
    activeTerminal: FakeTerminal | undefined;
    tabGroups: { all: unknown[] };
    createTerminal(options: FakeTerminal['options']): FakeTerminal;
    __fireDidCloseTerminal(terminal: unknown): void;
    __fireDidOpenTerminal(terminal: unknown): void;
    __fireDidStartTerminalShellExecution(terminal: unknown, commandLine?: string): void;
    __setActiveTerminal(terminal: unknown): void;
  };
}

/** The `vscode` stub's test controls. */
export const stub = vscode as unknown as StubControls;

/** Text of every message, input prompt, or dialog shown since the last reset. */
export function shownMessages(): string[] {
  return stub.__messages.map((args) => {
    const first = args[0] as unknown;
    if (typeof first === 'string') {
      return first;
    }
    const prompt = (first as { prompt?: string } | undefined)?.prompt;
    return prompt ?? '';
  });
}

/** Whether a message containing `text` was shown since the last reset. */
export function shown(text: string): boolean {
  return shownMessages().some((message) => message.includes(text));
}

export function runCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
  return vscode.commands.executeCommand<T>(id, ...args) as Promise<T>;
}

/** An in-memory `Memento` that clones values the way VS Code serializes them. */
export function memento() {
  const state = new Map<string, unknown>();
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    get: <T>(key: string, fallback?: T): T =>
      (state.has(key) ? clone(state.get(key)) : fallback) as T,
    update: async (key: string, value: unknown): Promise<void> => {
      state.set(key, clone(value));
    },
    keys: () => Array.from(state.keys()),
    setKeysForSync: () => undefined,
  };
}

export function makeStorage(
  globalState = memento(),
  workspaceState = memento()
): StorageService {
  return new StorageService({ globalState, workspaceState } as unknown as vscode.ExtensionContext);
}

/** A temp directory removed when the test ends, pass or fail. */
export function tempDir(t: { after(fn: () => void): void }, prefix = 'agntree-'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Set environment variables for one test; `undefined` unsets one. */
export function setEnv(
  t: { after(fn: () => void): void },
  values: Record<string, string | undefined>
): void {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  const apply = (entries: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(values);
  t.after(() => apply(saved));
}

/** Poll an explicit condition (sync or async) instead of sleeping for a fixed time. */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  what: string,
  timeoutMs = 2_000
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) {
      return value as NonNullable<T>;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let queued promise callbacks run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function chatRecord(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'chat-1',
    worktreeId: 'wt-1',
    name: 'Session',
    harness: 'claude',
    harnessSessionId: null,
    createdAt: 1,
    lastAccessedAt: 1,
    status: 'idle',
    ...overrides,
  };
}

export function worktreeRecord(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    name: 'main',
    path: '/repo',
    isMain: true,
    ...overrides,
  };
}

export function sessionRecord(
  harness: HarnessId,
  sessionId: string,
  overrides: Partial<HarnessSession> = {}
): HarnessSession {
  const updated = overrides.lastUpdated?.getTime() ?? Date.now();
  return {
    harness,
    sessionId,
    cwd: '/repo',
    summary: null,
    gitBranch: null,
    lastUpdated: new Date(updated),
    lastActivity: updated,
    messageCount: 0,
    ...overrides,
  };
}

const DISPLAY_NAMES: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  codex: 'Codex',
  pi: 'Pi',
};

/**
 * A harness adapter with neutral defaults. The launch command is a readable
 * stand-in (`claude --resume s1`), so tests assert what the terminal received
 * without depending on any real CLI's flags.
 */
export function fakeAdapter(
  id: HarnessId,
  overrides: Partial<HarnessAdapter> = {}
): HarnessAdapter {
  return {
    id,
    displayName: DISPLAY_NAMES[id],
    icon: 'terminal',
    treeIcons: harnessTreeIcons(id),
    capabilities: {
      newSessionId: id === 'claude' || id === 'pi',
      preview: id === 'opencode' ? 'lazy' : 'inline',
    },
    isInstalled: async () => true,
    buildLaunchCommand: ({ sessionId, newSessionId, forkFromSessionId }) =>
      [
        id,
        forkFromSessionId && `--fork ${forkFromSessionId}`,
        sessionId && `--resume ${sessionId}`,
        newSessionId && `--session-id ${newSessionId}`,
      ]
        .filter(Boolean)
        .join(' '),
    isSessionResumable: async () => true,
    listSessionsForWorktree: async () => [],
    listSessionsForRepository: async () => [],
    getSessionMetadata: async () => null,
    getPreview: async () => [],
    forkSession: async () => {
      throw new Error(`${id} fork is not faked`);
    },
    prepareForkToNewWorktree: async () => {
      throw new Error(`${id} worktree fork is not faked`);
    },
    ...overrides,
  };
}

/** A native-UI surface tracker whose open tabs and calls the test controls. */
export function fakeSurfaces() {
  const open = new Set<string>();
  const calls: string[] = [];
  const tracker: NativeUiSurfaceTracker = {
    onDidChange: () => ({ dispose: () => undefined }),
    expect: (sessionId, label) => calls.push(`expect:${sessionId}:${label}`),
    cancelExpect: (sessionId) => calls.push(`cancel:${sessionId}`),
    settle: (sessionId) => calls.push(`settle:${sessionId}`),
    activeSessionId: () => undefined,
    dispose: () => undefined,
    isOpen: (sessionId) => open.has(sessionId),
    closeSurface: async (sessionId) => {
      calls.push(`close:${sessionId}`);
      return open.delete(sessionId);
    },
  };
  return { tracker, open, calls };
}

/** A native UI whose availability and open results the test sets. */
export function fakeNativeUi(displayName: string, overrides: Partial<NativeUiCapability> = {}) {
  const opened: { sessionId?: string; cwd: string }[] = [];
  const surfaces = fakeSurfaces();
  const nativeUi: NativeUiCapability = {
    displayName,
    contextValueSuffix: displayName.replace(/\W/g, ''),
    extensionId: `test.${displayName.replace(/\W/g, '').toLowerCase()}`,
    isInstalled: () => true,
    checkAvailability: () => ({ kind: 'available' }),
    checkNewSessionAvailability: () => ({ kind: 'available' }),
    openNewSession: async (cwd) => {
      opened.push({ cwd });
      return { kind: 'opened', via: 'command' };
    },
    openSession: async (sessionId, cwd) => {
      opened.push({ sessionId, cwd });
      return { kind: 'opened', via: 'command' };
    },
    surfaces: surfaces.tracker,
    ...overrides,
  };
  return { nativeUi, opened, surfaces };
}
