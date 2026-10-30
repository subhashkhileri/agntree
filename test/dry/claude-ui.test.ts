import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-claude-ui-'));
const UI_CWD = path.join(ROOT, 'ui');
const OTHER_WORKTREE = path.join(ROOT, 'other');
fs.mkdirSync(UI_CWD);
fs.mkdirSync(OTHER_WORKTREE);

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
    'anthropic.claude-code',
    extensionInstalled
  );
  (vscode as any).workspace.workspaceFolders = [
    { uri: vscode.Uri.file(UI_CWD) },
  ];
  (vscode as any).__commandHandlers.delete('claude-vscode.editor.open');
  (vscode as any).__openExternalCalls.length = 0;
  (vscode as any).__setOpenExternalResult(true);
}

async function main(): Promise<void> {
  const harness = new ClaudeHarness();

  console.log('\n== capability ==');
  reset(true);
  check(
    harness.nativeUi.contextValueSuffix === 'ClaudeUi',
    'Claude chats carry a UI context suffix'
  );
  check(harness.nativeUi.isInstalled(), 'the capability sees an installed extension');
  (vscode as any).__setExtensionInstalled('anthropic.claude-code', false);
  check(
    harness.nativeUi.isInstalled() === false,
    'the capability sees a missing extension'
  );

  console.log('\n== preflight ==');
  reset(true);
  check(
    harness.nativeUi.checkAvailability(UI_CWD).kind === 'available',
    'a matching folder is available for the handoff'
  );
  reset(false);
  check(
    harness.nativeUi.checkAvailability(UI_CWD).kind === 'not-installed',
    'preflight reports a missing extension'
  );
  reset(true);
  (vscode as any).workspace.workspaceFolders = [];
  check(
    harness.nativeUi.checkAvailability(UI_CWD).kind === 'no-workspace',
    'preflight reports an empty window'
  );
  reset(true);
  const preflight = harness.nativeUi.checkAvailability(OTHER_WORKTREE);
  check(
    preflight.kind === 'workspace-mismatch' && preflight.uiCwd === UI_CWD,
    'preflight reports the folder mismatch without opening anything'
  );

  console.log('\n== unavailable paths ==');
  reset(false);
  let result = await harness.nativeUi.openSession('session-1', UI_CWD);
  check(result.kind === 'not-installed', 'a missing extension is reported');

  reset(true);
  (vscode as any).workspace.workspaceFolders = [];
  result = await harness.nativeUi.openSession('session-1', UI_CWD);
  check(result.kind === 'no-workspace', 'an empty window is reported');

  reset(true);
  result = await harness.nativeUi.openSession('session-1', OTHER_WORKTREE);
  check(
    result.kind === 'workspace-mismatch' && result.uiCwd === UI_CWD,
    'a session from another worktree is refused with the UI folder'
  );

  console.log('\n== command path ==');
  reset(true);
  const calls: unknown[][] = [];
  const command = vscode.commands.registerCommand(
    'claude-vscode.editor.open',
    async (...args: unknown[]) => {
      calls.push(args);
    }
  );
  result = await harness.nativeUi.openSession('session-1', UI_CWD);
  check(
    result.kind === 'opened' && result.via === 'command',
    'an installed command opens the session'
  );
  check(
    calls.length === 1 && calls[0][0] === 'session-1',
    'the command receives the native session ID'
  );
  check(
    calls[0][2] === (vscode as any).ViewColumn.Active,
    'the command opens in the active editor group instead of a new right group'
  );
  check(
    (calls[0][5] as { programmatic?: string } | undefined)?.programmatic ===
      'honor-preferred-location',
    'the command honors the extension preferred location'
  );
  check(
    (vscode as any).__openExternalCalls.length === 0,
    'the URI fallback is not used when the command succeeds'
  );
  command.dispose();

  console.log('\n== URI fallback ==');
  reset(true);
  result = await harness.nativeUi.openSession('session/with?chars', UI_CWD);
  check(
    result.kind === 'opened' && result.via === 'uri',
    'the documented URI opens the session when the command is absent'
  );
  const openCalls = (vscode as any).__openExternalCalls as {
    toString(): string;
  }[];
  check(
    openCalls.length === 1 &&
      openCalls[0].toString() ===
        `vscode://anthropic.claude-code/open?session=${encodeURIComponent(
          'session/with?chars'
        )}`,
    `the URI carries an encoded session ID: ${openCalls[0]?.toString()}`
  );

  console.log('\n== new conversation ==');
  reset(true);
  check(
    harness.nativeUi.checkNewSessionAvailability(UI_CWD).kind === 'available',
    'a matching first folder can start a new UI conversation'
  );
  reset(true);
  const newCalls: unknown[][] = [];
  const newCommand = vscode.commands.registerCommand(
    'claude-vscode.editor.open',
    async (...args: unknown[]) => {
      newCalls.push(args);
    }
  );
  result = await harness.nativeUi.openNewSession(UI_CWD);
  check(
    result.kind === 'opened' && result.via === 'command',
    'an installed command opens a new conversation'
  );
  check(
    newCalls.length === 1 &&
      newCalls[0][0] === undefined &&
      newCalls[0][1] === undefined,
    'the new-conversation command passes no session or prompt'
  );
  check(
    newCalls[0][2] === (vscode as any).ViewColumn.Active,
    'a new conversation opens in the active group'
  );
  newCommand.dispose();

  reset(true);
  result = await harness.nativeUi.openNewSession(UI_CWD);
  check(
    result.kind === 'opened' && result.via === 'uri',
    'the URI opens a new conversation when the command is absent'
  );
  check(
    (vscode as any).__openExternalCalls[0]?.toString() ===
      'vscode://anthropic.claude-code/open',
    'the new-conversation URI carries no session'
  );

  console.log('\n== failures ==');
  reset(true);
  (vscode as any).__setOpenExternalResult(false);
  result = await harness.nativeUi.openSession('session-1', UI_CWD);
  check(
    result.kind === 'failed' &&
      result.message.includes('did not open'),
    'a rejected URI is reported'
  );

  reset(true);
  const failing = vscode.commands.registerCommand(
    'claude-vscode.editor.open',
    async () => {
      throw new Error('command exploded');
    }
  );
  result = await harness.nativeUi.openSession('session-1', UI_CWD);
  check(
    result.kind === 'failed' && result.message === 'command exploded',
    'a failing command is reported instead of silently starting a new chat'
  );
  check(
    (vscode as any).__openExternalCalls.length === 0,
    'a failing command does not fall back to the URI'
  );
  failing.dispose();

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE UI CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
