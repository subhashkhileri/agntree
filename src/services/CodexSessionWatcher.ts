import { StorageService } from './StorageService';
import { HarnessAdapter } from '../harnesses/types';
import {
  PendingSessionWatcher,
  PendingSessionWatcherOptions,
} from './PendingSessionWatcher';

/**
 * Links newly launched Codex threads to their Agntree chat.
 *
 * A brand-new thread has no rollout and no `thread/list` row until the first
 * user message, so `thread/start` cannot be used to create a resumable chat.
 * We launch `codex` in the terminal and poll the app-server for the first new
 * thread in that worktree. Forks do not use this watcher: `thread/fork`
 * returns a linked ID immediately.
 */
export class CodexSessionWatcher extends PendingSessionWatcher {
  constructor(
    storageService: StorageService,
    adapter: HarnessAdapter,
    options: PendingSessionWatcherOptions = {}
  ) {
    super('codex', storageService, adapter, options);
  }
}
