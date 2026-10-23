import * as vscode from 'vscode';
import { HarnessId } from '../types';

/** A user message extracted from a native session for previews. */
export interface PreviewMessage {
  text: string;
  timestamp: number | null;
}

/** A session as discovered from a harness, normalized for Agntree. */
export interface HarnessSession {
  harness: HarnessId;
  sessionId: string;
  /** Directory the session was created in (used to map it to a worktree). */
  cwd: string;
  /** Title/summary shown in the UI. */
  summary: string | null;
  /** Harness-provided recap, when supported. */
  recap: string | null;
  gitBranch: string | null;
  lastUpdated: Date | null;
  /** Timestamp of the last user prompt, when available. */
  lastActivity: number | null;
  /** Message count when the harness can provide it cheaply; 0 when unknown. */
  messageCount: number;
  model?: string;
  agent?: string;
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/** Visual state of a chat row in the session tree. */
export type HarnessIconState = 'default' | 'running' | 'closed' | 'new';

/** Extension-relative SVG paths for each theme and tree state. */
export interface HarnessTreeIcons {
  light: Record<HarnessIconState, string>;
  dark: Record<HarnessIconState, string>;
}

/** Metadata used to render a chat row and its tooltip. */
export interface SessionMetadata {
  lastActivity: number | null;
  recap: string | null;
  preview: PreviewMessage[];
  model?: string;
  agent?: string;
  cost?: number;
  tokens?: HarnessSession['tokens'];
}

export interface LaunchOptions {
  worktreePath: string;
  /** Resume this native session. */
  sessionId?: string | null;
  /** Fork this native session using the harness's terminal fork flag. */
  forkFromSessionId?: string | null;
}

export interface ForkResult {
  /**
   * New session ID when the harness can fork server-side (opencode).
   * Claude returns undefined and discovers the new ID through its watcher.
   */
  sessionId?: string;
}

export interface HarnessCapabilities {
  /** Can fork an existing conversation. */
  fork: boolean;
  /** Can move a session to another directory (opencode). */
  move: boolean;
  /** Provides a recap separate from previews (Claude). */
  recap: boolean;
  /**
   * How previews are obtained. `inline` means they arrive with session
   * metadata (cheap); `lazy` means fetching them is expensive and should
   * happen only when the user asks for them.
   */
  preview: 'inline' | 'lazy';
}

/** Minimal shape of a prompt-based quick action. */
export interface HeadlessAction {
  name: string;
  prompt: string;
  /** Claude only. */
  allowedTools?: string;
  /** opencode only. */
  agent?: string;
  /** opencode only, provider/model[#variant]. */
  model?: string;
  /** opencode only; defaults to true for headless runs. */
  auto?: boolean;
}

export interface HeadlessCommand {
  command: string;
  args: string[];
}

/**
 * A CLI coding harness (Claude Code, opencode, ...).
 *
 * Implementations must not read the harness's internal database directly;
 * prefer the harness's documented CLI/API so schema changes don't break us.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  /** VS Code ThemeIcon id used for terminal/tree affordances. */
  readonly icon: string;
  /** Optional custom SVG marks for session rows, generated per state/theme. */
  readonly treeIcons?: HarnessTreeIcons;
  readonly capabilities: HarnessCapabilities;

  /** Whether the harness CLI/data is available. Cached by the registry. */
  isInstalled(): Promise<boolean>;

  /** Full shell command used by TerminalManager. */
  buildLaunchCommand(options: LaunchOptions): string;

  /** Whether the harness can resume this session (checked before launching). */
  isSessionResumable(sessionId: string, cwd?: string): Promise<boolean>;

  listSessionsForWorktree(worktreePath: string): Promise<HarnessSession[]>;
  listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]>;

  /**
   * Metadata for a chat row. Implementations should prefer cached data and
   * return quickly; opencode previews are populated by getPreview lazily.
   * `cwd` lets the adapter locate a session that is not in its cache.
   */
  getSessionMetadata(sessionId: string, cwd?: string): Promise<SessionMetadata | null>;

  /** Last few user prompts, newest last. */
  getPreview(sessionId: string, maxMessages?: number): Promise<PreviewMessage[]>;

  /** Fork a conversation. */
  forkSession(sessionId: string, cwd?: string): Promise<ForkResult>;

  /** Move a session to a directory. Only called when capabilities.move. */
  moveSession(sessionId: string, directory: string, cwd?: string): Promise<void>;

  /**
   * Prepare a fork into a brand-new worktree.
   * Claude copies its JSONL project directory and reuses the source ID;
   * opencode forks + moves server-side and returns the new ID.
   */
  prepareForkToNewWorktree(
    sessionId: string,
    sourceWorktreePath: string,
    destinationWorktreePath: string
  ): Promise<ForkResult>;

  /** Command for a prompt-based quick action, or null when unsupported. */
  buildHeadlessCommand(action: HeadlessAction): HeadlessCommand | null;
}

/** Watches for newly-created native sessions and links them to pending chats. */
export interface HarnessSessionWatcher extends vscode.Disposable {
  readonly harness: HarnessId;
  readonly onChatNameUpdated: vscode.Event<{ chatId: string; name: string }>;
  startWatching(): void;
  registerPendingChat(chatId: string, worktreePath: string): void;
}
