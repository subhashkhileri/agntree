import { TurnState } from '../harnesses/types';
import { JsonlFold, JsonlAppendReader } from '../utils/jsonlAppendReader';

/**
 * Minimal rollout reader for live turn state.
 *
 * The app-server is not the executor for `codex` processes started by
 * Agntree, so `thread/list` always reports `notLoaded` for them. The rollout
 * file is the only live signal: `task_started` / `task_complete` /
 * `turn_aborted` bracket a turn.
 *
 * Files are parsed incrementally by `JsonlAppendReader`, so a 4s poll only
 * reads what the TUI appended since the last poll. A full scan happens once
 * per session.
 */
export interface CodexRolloutState {
  turnState?: TurnState;
  turnEndedAt: number | null;
  /** User + agent messages completed so far. */
  messageCount: number;
}

const CACHE_LIMIT = 100;

/** Folds rollout events into the live state; only `event_msg` entries count. */
const rolloutFold: JsonlFold<CodexRolloutState, CodexRolloutState> = {
  initial: () => ({
    turnState: undefined,
    turnEndedAt: null,
    messageCount: 0,
  }),
  apply(entry, state) {
    const record = entry as { type?: unknown; payload?: unknown } | null;
    if (record?.type !== 'event_msg') {
      return;
    }
    const payload = record.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload.type === 'string') {
      applyEvent(payload, state);
    }
  },
  // A copy, so a caller's value does not change under it on the next read.
  result: (state) => ({ ...state }),
};

export class CodexRolloutService {
  private readonly reader = new JsonlAppendReader(rolloutFold, CACHE_LIMIT);

  /**
   * Read the rollout, parsing only bytes appended since the previous call.
   * Returns null when the file is missing or compressed (`.zst`).
   *
   * Reads for the same path share one in-flight request so concurrent tree
   * renders cannot parse the same bytes twice.
   */
  read(rolloutPath: string | null | undefined): Promise<CodexRolloutState | null> {
    if (!rolloutPath || rolloutPath.endsWith('.zst')) {
      return Promise.resolve(null);
    }
    return this.reader.read(rolloutPath);
  }
}

function applyEvent(
  payload: Record<string, unknown>,
  state: CodexRolloutState
): void {
  switch (payload.type) {
    case 'task_started':
      state.turnState = 'working';
      state.turnEndedAt = null;
      return;
    case 'task_complete':
    case 'turn_aborted':
      state.turnState = 'done';
      state.turnEndedAt = toEpochMs(payload.completed_at) ?? Date.now();
      return;
    case 'item_completed': {
      const item = payload.item as Record<string, unknown> | undefined;
      if (item?.type === 'UserMessage' || item?.type === 'AgentMessage') {
        state.messageCount++;
      }
      return;
    }
    default:
      return;
  }
}

/** Rollout timestamps are Unix seconds; tolerate milliseconds too. */
function toEpochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value < 1e12 ? value * 1000 : value;
}
