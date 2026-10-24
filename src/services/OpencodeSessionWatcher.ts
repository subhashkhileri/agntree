import { StorageService } from './StorageService';
import { ChatSession } from '../types';
import { HarnessAdapter } from '../harnesses/types';
import {
  PendingChat,
  PendingSessionWatcher,
} from './PendingSessionWatcher';

const PROMPT_FALLBACK_DELAY_MS = 30_000;

/**
 * Links newly launched opencode sessions to their Agntree chat.
 *
 * opencode owns its session IDs, so unlike Claude we cannot predict them.
 * `PendingSessionWatcher` polls the session list and claims the first new
 * top-level session in the worktree directory; this subclass adds the
 * first-prompt naming fallback for sessions opencode has not titled yet.
 */
export class OpencodeSessionWatcher extends PendingSessionWatcher {
  private readonly namingFromPrompt = new Set<string>();

  constructor(
    storageService: StorageService,
    adapter: HarnessAdapter
  ) {
    super('opencode', storageService, adapter);
  }

  protected override handleUnnamed(
    pending: PendingChat,
    chat: ChatSession
  ): void {
    // opencode may not title a session immediately. Fall back to the first
    // user prompt so the tree does not sit on "New Session" forever.
    if (
      !chat.harnessSessionId ||
      this.namingFromPrompt.has(pending.chatId) ||
      Date.now() - pending.since < PROMPT_FALLBACK_DELAY_MS
    ) {
      return;
    }

    this.namingFromPrompt.add(pending.chatId);
    void this.nameFromPrompt(pending);
  }

  private async nameFromPrompt(pending: PendingChat): Promise<void> {
    const chat = this.storageService.getChat(pending.chatId);
    if (!chat || !chat.harnessSessionId || !chat.name.startsWith('New Session')) {
      this.pendingChats.delete(pending.chatId);
      return;
    }

    try {
      const preview = await this.adapter.getPreview(chat.harnessSessionId, 1);
      const prompt = preview[0]?.text?.trim();
      if (prompt) {
        this.renameChat(pending.chatId, prompt);
      }
    } catch (error) {
      console.error(
        `[OpencodeSessionWatcher] Failed to read preview for ${chat.harnessSessionId}:`,
        error
      );
    } finally {
      this.pendingChats.delete(pending.chatId);
    }
  }

  override dispose(): void {
    this.namingFromPrompt.clear();
    super.dispose();
  }
}
