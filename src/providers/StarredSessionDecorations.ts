import * as vscode from 'vscode';
import { StorageService } from '../services/StorageService';

/** The scheme of a session row's `resourceUri`. It names a chat, not a file. */
const SESSION_ROW_SCHEME = 'agntree-session';

/** The `resourceUri` that lets VS Code decorate a session row. */
export function sessionRowUri(chatId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SESSION_ROW_SCHEME, path: `/${chatId}` });
}

/**
 * Puts a star at the right edge of a starred session's row. VS Code truncates
 * a row's description before its name, so a star in the description
 * disappeared on exactly the rows with long names; a decoration badge stays
 * visible and the name is shortened instead. The name keeps its usual color.
 *
 * VS Code caches a decoration per URI until its provider reports a change, so
 * every tree change compares the starred set with the one last reported and
 * names only the rows whose star changed.
 */
export class StarredSessionDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private reported: Set<string>;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly storage: Pick<StorageService, 'getStarredChatIds' | 'isStarred'>,
    onDidChangeTree: vscode.Event<unknown>
  ) {
    this.reported = storage.getStarredChatIds();
    this.subscription = onDidChangeTree(() => this.reportStarChanges());
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SESSION_ROW_SCHEME || !this.storage.isStarred(uri.path.slice(1))) {
      return undefined;
    }
    return new vscode.FileDecoration('★');
  }

  private reportStarChanges(): void {
    const starred = this.storage.getStarredChatIds();
    const changed = [...starred, ...this.reported].filter((id) => starred.has(id) !== this.reported.has(id));
    this.reported = starred;
    if (changed.length > 0) {
      this.changed.fire(changed.map(sessionRowUri));
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
