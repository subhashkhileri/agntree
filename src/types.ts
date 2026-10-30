/**
 * Represents a git repository added to the workspace manager
 */
export interface Repository {
  /** Unique identifier */
  id: string;
  /** Display name (usually folder name) */
  name: string;
  /** Absolute path to the folder the user added; contains `.git` when it is a git repository */
  rootPath: string;
  /** Whether the repository is hidden (soft removed) */
  hidden?: boolean;
}

/**
 * Represents a git worktree within a repository
 */
export interface Worktree {
  /** Unique identifier */
  id: string;
  /** Parent repository ID */
  repoId: string;
  /** Branch name or descriptive name */
  name: string;
  /** Absolute path to the worktree directory */
  path: string;
  /** Whether this is the main worktree */
  isMain: boolean;
}

/**
 * The worktrees sessions can run in for a workspace root. A plain folder is
 * its own single worktree (`isGit: false`), so chats can attach before
 * `git init`.
 */
export interface RepositoryWorktrees {
  isGit: boolean;
  worktrees: Worktree[];
}

/**
 * Supported CLI coding harnesses
 */
export type HarnessId = 'claude' | 'opencode' | 'codex';

/**
 * Represents a chat session managed by Agntree
 */
export interface ChatSession {
  /** Unique identifier */
  id: string;
  /** Parent worktree ID */
  worktreeId: string;
  /** User-defined name for the chat */
  name: string;
  /** Which CLI harness owns this session */
  harness: HarnessId;
  /** Native session ID used to resume in the owning harness */
  harnessSessionId: string | null;
  /**
   * ID chosen at launch for a harness that accepts one, before its transcript
   * exists. Cleared when the watcher links the native session.
   */
  pendingHarnessSessionId?: string | null;
  /**
   * Source session for an unlinked terminal fork. Reopening the chat before
   * the first prompt repeats the fork instead of starting a fresh session.
   */
  forkedFromSessionId?: string | null;
  /**
   * A chat started in the agent's VS Code UI. The UI assigns the native ID,
   * so the session importer links this chat when the session first appears.
   */
  pendingUiLaunch?: boolean;
  /**
   * Native sessions that already existed when the UI launch began, newest
   * first and bounded. Persisted so a reload between the launch and the first
   * prompt cannot make the importer claim an older session in the worktree.
   */
  pendingUiKnownSessionIds?: string[];
  /**
   * Imported automatically from a native session rather than created or
   * imported by the user. Retention applies to every row; this flag marks a
   * row whose name may follow the harness's later title.
   */
  autoImported?: boolean;
  /** The user renamed this chat, so automatic naming must leave it alone. */
  customName?: boolean;
  /** Unix timestamp of creation */
  createdAt: number;
  /** Unix timestamp of last access */
  lastAccessedAt: number;
  /** Current status of the chat */
  status: 'active' | 'idle' | 'closed';
  /** Git commit SHA when session started (for tracking changes) */
  baseCommit: string | null;
}

/**
 * Represents a file change tracked during a chat session
 */
export interface FileChange {
  /** Relative file path from worktree root */
  path: string;
  /** Type of change */
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Number of lines added */
  additions: number;
  /** Number of lines removed */
  deletions: number;
}

/**
 * Represents GitHub PR info for a branch
 */
export interface PRInfo {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR state */
  state: 'open' | 'merged' | 'closed';
  /** Whether the PR is a draft */
  isDraft: boolean;
  /** PR URL */
  url: string;
  /** PR source branch name */
  headRefName?: string;
}

/**
 * Tree item types for context menu identification
 */
export type TreeItemType = 'repository' | 'worktree' | 'chat' | 'changedFile';

/**
 * Storage keys used in VS Code globalState and workspaceState
 */
export const STORAGE_KEYS = {
  REPOSITORIES: 'agntree.repositories',
  CHATS: 'agntree.chats',
  ACTIVE_CHAT: 'agntree.activeChat',
  ACTIVE_WORKTREE_ID: 'agntree.activeWorktreeId',
  PR_WORKTREES: 'agntree.prWorktrees',
  STARRED_CHATS: 'agntree.starredChats',
  /**
   * Sessions the user removed from the tree. Auto-import must not resurrect
   * them while they are still inside the retention window.
   */
  REMOVED_SESSIONS: 'agntree.removedSessions',
  /**
   * workspaceState: the pty PID this workspace last saw for a chat it
   * launched. A matching PID is the live agent after a reload; a different
   * PID means VS Code revived the tab as a new shell that needs resuming.
   */
  TERMINAL_PIDS: 'agntree.terminalPids',
} as const;

/**
 * Generates a UUID v4
 */
export function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
