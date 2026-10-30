import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CodexHarness } from '../../src/harnesses/CodexHarness';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-codex-ui-'));
const WORKTREE = path.join(ROOT, 'worktree');
fs.mkdirSync(WORKTREE);

let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function reset(extensionInstalled: boolean): void {
  (vscode as any).__setExtensionInstalled(
    'openai.chatgpt',
    extensionInstalled
  );
  (vscode as any).workspace.workspaceFolders = [
    { uri: vscode.Uri.file(WORKTREE) },
  ];
  (vscode as any).__commandHandlers.delete('vscode.openWith');
  (vscode as any).__commandHandlers.delete('chatgpt.newCodexPanel');
}

async function main(): Promise<void> {
  const harness = new CodexHarness();

  console.log('\n== capability ==');
  reset(true);
  check(
    harness.nativeUi.contextValueSuffix === 'CodexUi',
    'Codex chats carry a UI context suffix'
  );
  check(
    harness.nativeUi.isInstalled(),
    'the capability sees an installed Codex extension'
  );
  reset(false);
  check(
    harness.nativeUi.isInstalled() === false,
    'the capability sees a missing Codex extension'
  );

  console.log('\n== preflight ==');
  reset(true);
  check(
    harness.nativeUi.checkAvailability(WORKTREE).kind === 'available',
    'an installed extension is available'
  );
  (vscode as any).workspace.workspaceFolders = [];
  check(
    harness.nativeUi.checkAvailability(WORKTREE).kind === 'available',
    'a Codex thread needs no workspace folder; it keeps its own cwd'
  );
  reset(false);
  check(
    harness.nativeUi.checkAvailability(WORKTREE).kind === 'not-installed',
    'preflight reports a missing extension'
  );

  console.log('\n== conversation panel ==');
  reset(true);
  const calls: unknown[][] = [];
  const openWith = vscode.commands.registerCommand(
    'vscode.openWith',
    async (...args: unknown[]) => {
      calls.push(args);
    }
  );
  let result = await harness.nativeUi.openSession('thread-1', WORKTREE);
  check(
    result.kind === 'opened' && result.via === 'command',
    'the conversation panel opens the session'
  );
  check(calls.length === 1, 'exactly one custom editor is opened');
  const uri = calls[0]?.[0] as vscode.Uri;
  check(
    uri.toString() === 'openai-codex://route/local/thread-1',
    `the panel receives the thread resource: ${uri?.toString()}`
  );
  check(
    uri.scheme === 'openai-codex' &&
      uri.authority === 'route' &&
      uri.path === '/local/thread-1',
    'the URI uses the extension route and local scope'
  );
  check(
    calls[0]?.[1] === 'chatgpt.conversationEditor',
    'the Codex conversation editor is requested'
  );
  const options = calls[0]?.[2] as
    | { viewColumn?: number; preview?: boolean; preserveFocus?: boolean }
    | undefined;
  check(
    options?.viewColumn === (vscode as any).ViewColumn.Active,
    'the panel opens in the active editor group'
  );
  check(
    options?.preview === false && options?.preserveFocus === false,
    'the panel opens focused and as a permanent tab'
  );
  openWith.dispose();

  console.log('\n== new conversation ==');
  reset(true);
  check(
    harness.nativeUi.checkNewSessionAvailability(WORKTREE).kind ===
      'available',
    'a single matching workspace folder can start a new Codex panel'
  );
  (vscode as any).workspace.workspaceFolders = [];
  check(
    harness.nativeUi.checkNewSessionAvailability(WORKTREE).kind ===
      'no-workspace',
    'a new Codex panel needs a workspace folder'
  );
  reset(true);
  (vscode as any).workspace.workspaceFolders = [
    { uri: vscode.Uri.file(WORKTREE) },
    { uri: vscode.Uri.file(path.join(ROOT, 'other')) },
  ];
  check(
    harness.nativeUi.checkNewSessionAvailability(WORKTREE).kind ===
      'workspace-multi-root',
    'a new Codex panel refuses a multi-root workspace'
  );
  reset(true);
  check(
    harness.nativeUi.checkNewSessionAvailability(
      path.join(ROOT, 'other')
    ).kind === 'workspace-mismatch',
    'a new Codex panel refuses another worktree'
  );

  reset(true);
  let newPanelCalls = 0;
  const newPanel = vscode.commands.registerCommand(
    'chatgpt.newCodexPanel',
    async () => {
      newPanelCalls++;
    }
  );
  result = await harness.nativeUi.openNewSession(WORKTREE);
  check(
    result.kind === 'opened' && result.via === 'command',
    'the native command opens a new Codex panel'
  );
  check(newPanelCalls === 1, 'exactly one new panel is requested');
  newPanel.dispose();

  reset(false);
  newPanelCalls = 0;
  result = await harness.nativeUi.openNewSession(WORKTREE);
  check(
    result.kind === 'not-installed' && newPanelCalls === 0,
    'a missing extension is reported before opening a panel'
  );

  console.log('\n== unavailable paths ==');
  reset(false);
  calls.length = 0;
  result = await harness.nativeUi.openSession('thread-1', WORKTREE);
  check(
    result.kind === 'not-installed' && calls.length === 0,
    'a missing extension is reported without opening an editor'
  );

  console.log('\n== failures ==');
  reset(true);
  const failing = vscode.commands.registerCommand(
    'vscode.openWith',
    async () => {
      throw new Error('custom editor unavailable');
    }
  );
  result = await harness.nativeUi.openSession('thread-1', WORKTREE);
  check(
    result.kind === 'failed' && result.message === 'custom editor unavailable',
    'a failed open is reported instead of being ignored'
  );
  failing.dispose();

  harness.dispose();
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL CODEX UI CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
