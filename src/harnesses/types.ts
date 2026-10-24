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
  gitBranch: string | null;
  lastUpdated: Date | null;
  /** Timestamp of the last user prompt, when available. */
  lastActivity: number | null;
  /** Message count when the harness can provide it cheaply; 0 when unknown. */
  messageCount: number;
  /**
   * Whether the harness is mid-turn (`working`) or has finished responding
   * (`done`). Undefined when the harness cannot tell, in which case no
   * turn-end notification is sent for it.
   */
  turnState?: TurnState;
  /** Timestamp the completed turn ended at, used to notify once per turn. */
  turnEndedAt?: number | null;
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

/**
 * Live turn state a harness reports for a session. Declared once so services,
 * providers, and adapters cannot drift apart when a state is added.
 */
export type TurnState = 'working' | 'done';

/** A session's live turn state plus whatever is blocking it on the user. */
export interface HarnessLiveState {
  turnState: TurnState;
  turnEndedAt: number | null;
  /** Raw harness reason, e.g. "permission prompt". Undefined when not waiting. */
  waitingFor?: string;
}

/**
 * Visual state of a chat row in the session tree.
 *
 * `working` is the animated mark (mid-turn), `done` is the mark plus a green
 * dot (turn finished, terminal open), `closed` is the grey mark, and `new` is
 * the mark plus a hollow ring for a chat the harness has not linked yet.
 */
export type HarnessIconState = 'working' | 'done' | 'closed' | 'new';

/** Extension-relative SVG paths for each theme and tree state. */
export interface HarnessTreeIcons {
  light: Record<HarnessIconState, string>;
  dark: Record<HarnessIconState, string>;
}

/** Metadata used to render a chat row and its tooltip. */
export interface SessionMetadata {
  lastActivity: number | null;
  /** Last few user prompts, oldest first. */
  preview: PreviewMessage[];
  /** Most recent user prompt, when it is not already in `preview`. */
  lastAsk?: PreviewMessage | null;
  /** Most recent assistant text, skipping tool-only turns. */
  lastReply?: PreviewMessage | null;
  /** Total messages in the conversation, when known. */
  messageCount?: number;
  model?: string;
  agent?: string;
  cost?: number;
  tokens?: HarnessSession['tokens'];
}

export interface LaunchOptions {
  worktreePath: string;
  /** Resume this native session. */
  sessionId?: string | null;
  /**
   * A caller-chosen ID for a session that does not exist yet. Harnesses that
   * assign their own IDs ignore it.
   */
  newSessionId?: string | null;
  /** Fork this native session using the harness's terminal fork flag. */
  forkFromSessionId?: string | null;
}

/**
 * How a fork was created. `linked` means the harness returned a new session
 * ID to resume; `terminal` means the harness forks in the terminal under an
 * ID the caller chose, which the watcher then links.
 */
export type ForkResult =
  | { kind: 'linked'; sessionId: string }
  | { kind: 'terminal'; pendingSessionId: string };

export interface HarnessCapabilities {
  /** Can fork an existing conversation. */
  fork: boolean;
  /** Can move a session to another directory (opencode). */
  move: boolean;
  /** Accepts a caller-chosen ID for a new session (Claude Code). */
  newSessionId: boolean;
  /**
   * How previews are obtained. `inline` means they arrive with session
   * metadata (cheap); `lazy` means fetching them is expensive and should
   * happen only when the user asks for them.
   */
  preview: 'inline' | 'lazy';
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

  listSessionsForWorktree(
    worktreePath: string,
    force?: boolean
  ): Promise<HarnessSession[]>;
  listSessionsForRepository(
    repoRootPath: string,
    worktreePaths: string[]
  ): Promise<HarnessSession[]>;

  /**
   * Live state for specific sessions, when the harness has a cheaper way to
   * answer than a full discovery pass. The attention tick prefers this.
   * Sessions without a readable native record are omitted.
   */
  getLiveStates?(sessionIds: string[]): Promise<Map<string, HarnessLiveState>>;

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
   * Claude forks natively into the destination on the first prompt; opencode
   * forks + moves server-side and returns the new ID.
   */
  prepareForkToNewWorktree(
    sessionId: string,
    sourceWorktreePath: string,
    destinationWorktreePath: string
  ): Promise<ForkResult>;

  /** Release long-lived resources such as child processes or caches. */
  dispose?(): void;
}

/** Watches for newly-created native sessions and links them to pending chats. */
export interface HarnessSessionWatcher extends vscode.Disposable {
  readonly harness: HarnessId;
  readonly onChatNameUpdated: vscode.Event<{ chatId: string; name: string }>;
  startWatching(): void;
  registerPendingChat(chatId: string, worktreePath: string): void | Promise<void>;
}
