/**
 * Represents a git repository added to the workspace manager
 */
export interface Repository {
  /** Unique identifier */
  id: string;
  /** Display name (usually folder name) */
  name: string;
  /** Absolute path to the repository root (where .git is) */
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
 * Represents a Claude Code chat session
 */
export interface ChatSession {
  /** Unique identifier */
  id: string;
  /** Parent worktree ID */
  worktreeId: string;
  /** User-defined name for the chat */
  name: string;
  /** Claude Code session ID for --resume flag */
  claudeSessionId: string | null;
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
}

/**
 * Tree item types for context menu identification
 */
export type TreeItemType = 'repository' | 'worktree' | 'chat' | 'changedFile';

/**
 * Storage keys used in VS Code globalState
 */
export const STORAGE_KEYS = {
  REPOSITORIES: 'claude-workspaces.repositories',
  CHATS: 'claude-workspaces.chats',
  ACTIVE_CHAT: 'claude-workspaces.activeChat',
  ACTIVE_WORKTREE_ID: 'claude-workspaces.activeWorktreeId',
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
