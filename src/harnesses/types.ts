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
 * A harness's native graphical UI, when it has one. The CLI remains the
 * default launch path; this capability only adds an explicit handoff for an
 * existing session.
 */
export interface NativeUiCapability {
  /** Human-readable surface name, for messages. */
  displayName: string;
  /**
   * Suffix appended to a chat row's context value so a menu can target rows
   * whose adapter has this UI. The provider never names a harness.
   */
  contextValueSuffix: string;
  /** Marketplace extension ID, used to point the user at an install. */
  extensionId: string;
  /** Whether the extension that provides the UI is installed. */
  isInstalled(): boolean;
  /**
   * Whether this cwd can be handed to the UI. Callers check this before
   * stopping a running terminal; `openSession` checks it again so a folder
   * change between the two calls cannot open the wrong tree.
   */
  checkAvailability(cwd: string): NativeUiAvailability;
  /**
   * Whether a brand-new conversation can start in this UI from `cwd`. New
   * sessions are more constrained than existing ones: the extension chooses
   * the workspace folder itself, so only the folder it uses is safe.
   */
  checkNewSessionAvailability(cwd: string): NativeUiAvailability;
  /**
   * Open a brand-new conversation in the UI. The extension assigns the native
   * session ID and creates the transcript on the first prompt; callers keep a
   * placeholder chat and let the session importer link it.
   */
  openNewSession(cwd: string): Promise<NativeUiOpenResult>;
  /** Open an existing, resumable session in the UI. */
  openSession(sessionId: string, cwd: string): Promise<NativeUiOpenResult>;
  /**
   * Tracks native-UI tabs for this adapter's sessions. A tracker either reads
   * the session ID from the tab (Codex's conversation editor) or binds a tab
   * to an expectation registered before a handoff (Claude's webview tab has
   * no ID).
   */
  readonly surfaces?: NativeUiSurfaceTracker;
}

/**
 * Maps native-UI tabs to native session IDs. The tree, attention service, and
 * active-row logic resolve that ID back to a chat, so the tracker stays free
 * of stored state.
 */
export interface NativeUiSurfaceTracker extends vscode.Disposable {
  /** Fires when a tracked surface opens/closes or the active session changes. */
  readonly onDidChange: vscode.Event<void>;
  /**
   * Associate the next surface opened for this native session. A tracker that
   * reads the ID from the tab has nothing to claim and may ignore this.
   */
  expect(sessionId: string, label: string): void;
  /** Drop an expectation when the open did not happen. */
  cancelExpect(sessionId: string): void;
  /**
   * Associate the active surface after a successful open. `allowActiveFallback`
   * lets a command bind the active tab even when its title was truncated
   * differently from the chat name; a background link must not, because the
   * active tab may belong to another conversation.
   */
  settle(
    sessionId: string,
    options?: { allowActiveFallback?: boolean }
  ): void;
  /** The native session whose surface is the active editor tab, if any. */
  activeSessionId(): string | undefined;
  /** Whether this native session currently has an open native-UI tab. */
  isOpen(sessionId: string): boolean;
  /**
   * Close this session's tab. Used when the user switches an open session
   * back to a terminal, so two agent processes cannot run at once.
   */
  closeSurface(sessionId: string): Promise<boolean>;
}

/** Why a session cannot be handed to the native UI. */
export type NativeUiUnavailable =
  | { kind: 'not-installed' }
  | { kind: 'no-workspace' }
  | { kind: 'workspace-mismatch'; uiCwd: string }
  | { kind: 'workspace-multi-root'; uiCwd: string };

/** Whether the native UI can open a session in this cwd right now. */
export type NativeUiAvailability =
  | { kind: 'available' }
  | NativeUiUnavailable;

/** What happened when Agntree asked a harness to open a session in its UI. */
export type NativeUiOpenResult =
  | { kind: 'opened'; via: 'command' | 'uri' }
  | NativeUiUnavailable
  | { kind: 'failed'; message: string };

/**
 * A harness whose sessions the session finder can search. The finder is an
 * agent with read-only file tools, so a source describes where its sessions
 * live and how to read them; it never runs code of its own during a search.
 */
export interface SessionSearchSource {
  /**
   * Search instructions for the agent: where the records are, how to tell
   * the user's own prompts from injected context, and what to skip.
   * `excludedCwds` are folders whose records belong to the search itself.
   */
  instructions(options: { excludedCwds: string[] }): string;
  /** Directories the agent must be able to read. */
  readableDirs(): string[];
  /**
   * The session the agent named, read back from the harness's own record,
   * with the user's prompt that `quote` comes from. Null when the session
   * does not exist; `prompt` is absent when the quote is not one of the
   * user's prompts in it.
   */
  verify(sessionId: string, quote: string): Promise<{ session: HarnessSession; prompt?: PreviewMessage } | null>;
}

/** One headless search conversation. */
export interface SessionSearchRunRequest {
  /** The first message, including the JSON Schema the reply must match. */
  prompt: string;
  model: string;
  effort: string;
  /** A folder of the search's own, used as the agent's working directory. */
  cwd: string;
  /** Directories the agent may read besides `cwd`. */
  readableDirs: string[];
  signal: AbortSignal;
  /** A short description of each step the agent takes, as it takes it. */
  onActivity(step: string): void;
  /**
   * Called with each reply. Returns the next message for the same agent, in
   * the same conversation, or undefined when the reply is final.
   */
  followUp(reply: string): string | undefined;
}

export interface SessionSearchRunResult {
  /** The agent's final reply, as text; the caller parses and validates it. */
  reply: string;
  /** What the whole conversation cost, when the harness reports it. */
  costUsd?: number;
}

/** A harness whose CLI can run the session finder. */
export interface SessionSearchRunner {
  /** The cheap model used when the user has not chosen one. */
  readonly defaultModel: string;
  /** Models offered in the picker; the user may type any other. */
  readonly suggestedModels: readonly string[];
  /** Effort levels the CLI accepts, lowest first. */
  readonly efforts: readonly string[];
  /**
   * Hold one conversation with read-only file tools and no saved session:
   * the prompt, then each `followUp()` message, and remove anything the CLI
   * wrote for `cwd`. Rejects when the CLI fails or the signal aborts.
   */
  run(request: SessionSearchRunRequest): Promise<SessionSearchRunResult>;
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
  /** Codicon id for the harness's terminal tabs. */
  readonly icon: string;
  /** Generated marks for session rows, per theme and state. */
  readonly treeIcons: HarnessTreeIcons;
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

  /** The harness's native graphical UI, when it has one. */
  readonly nativeUi?: NativeUiCapability;

  /** Lets the session finder search this harness's sessions. */
  readonly sessionSearch?: SessionSearchSource;

  /** Lets this harness's CLI run the session finder. */
  readonly sessionSearchRunner?: SessionSearchRunner;

  /**
   * Prepare a fork into a brand-new worktree. Claude forks into the
   * destination on its first prompt; opencode forks and moves the copy;
   * Codex forks into the destination cwd.
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
