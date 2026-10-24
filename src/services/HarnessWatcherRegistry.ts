import { HarnessId } from '../types';
import { HarnessSessionWatcher } from '../harnesses/types';

/**
 * Routes watcher operations to the implementation for a chat's harness.
 */
export class HarnessWatcherRegistry {
  private readonly watchers = new Map<HarnessId, HarnessSessionWatcher>();

  constructor(watchers: HarnessSessionWatcher[]) {
    for (const watcher of watchers) {
      this.watchers.set(watcher.harness, watcher);
    }
  }

  startAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.startWatching();
    }
  }

  registerPendingChat(
    harness: HarnessId,
    chatId: string,
    worktreePath: string
  ): void {
    const watcher = this.watchers.get(harness);
    if (!watcher) {
      return;
    }
    void watcher.registerPendingChat(chatId, worktreePath);
  }

  /** Fires when any harness discovers a better name for a chat. */
  onChatNameUpdated(
    listener: (event: { chatId: string; name: string }) => unknown
  ): { dispose(): void } {
    const subscriptions = Array.from(this.watchers.values()).map((watcher) =>
      watcher.onChatNameUpdated(listener)
    );
    return {
      dispose: () => subscriptions.forEach((subscription) => subscription.dispose()),
    };
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
  }
}
