import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { ChatSession } from '../types';

export type AttentionKind = 'finished' | 'needs-input';

export interface NotificationTarget {
  chat: ChatSession;
  /** "repo · worktree", shown in the banner and appended to the toast. */
  context: string;
  /** Extra line from the harness, e.g. the hook's own message. */
  detail?: string;
}

/** Escape text for an AppleScript double-quoted string literal. */
export function escapeAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

/**
 * Delivers attention notifications.
 *
 * VS Code has no OS-notification API: `showInformationMessage` renders inside
 * the window (and in the notification center) and can carry a button. On macOS
 * we additionally shell out to `osascript` so a finished session is visible
 * when VS Code is behind another app. The banner cannot be clicked, so the
 * toast keeps the action.
 */
export class NotificationService {
  constructor(
    private readonly onOpenChat: (chatId: string) => void,
    /** True when this chat's terminal is the one the user is looking at. */
    private readonly isChatVisible: (chatId: string) => boolean
  ) {}

  notify(kind: AttentionKind, target: NotificationTarget): void {
    const config = vscode.workspace.getConfiguration('agntree');
    if (!config.get<boolean>('notifications.enabled', true)) {
      return;
    }
    const toggle =
      kind === 'finished'
        ? 'notifications.onTurnEnd'
        : 'notifications.onNeedsInput';
    if (!config.get<boolean>(toggle, true)) {
      return;
    }

    const windowFocused = vscode.window.state.focused;
    // Never interrupt someone who is already typing in this session.
    if (windowFocused && this.isChatVisible(target.chat.id)) {
      return;
    }

    const name = target.chat.name;
    const title = kind === 'finished' ? `${name} finished` : `${name} needs your input`;
    const context = target.context ? ` (${target.context})` : '';
    const detail = target.detail?.trim();
    const message = detail ? `${title}${context} — ${detail}` : `${title}${context}`;

    void vscode.window
      .showInformationMessage(message, 'Open')
      .then((choice) => {
        if (choice === 'Open') {
          this.onOpenChat(target.chat.id);
        }
      });

    if (!windowFocused) {
      this.showNativeBanner(title, target, detail, config);
    }
  }

  private showNativeBanner(
    title: string,
    target: NotificationTarget,
    detail: string | undefined,
    config: vscode.WorkspaceConfiguration
  ): void {
    if (process.platform !== 'darwin') {
      return;
    }
    if (!config.get<boolean>('notifications.nativeBanner', true)) {
      return;
    }

    const body = detail ? `${target.chat.name}: ${detail}` : title;
    const subtitle = target.context;
    const script =
      `display notification "${escapeAppleScript(body)}" ` +
      `with title "Agntree"` +
      (subtitle ? ` subtitle "${escapeAppleScript(subtitle)}"` : '') +
      ` sound name "Glass"`;

    execFile('/usr/bin/osascript', ['-e', script], (error) => {
      if (error) {
        console.error('[Agntree] Native notification failed:', error.message);
      }
    });
  }
}
