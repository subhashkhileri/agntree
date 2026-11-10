/**
 * Handing sessions to the agents' own VS Code UIs. The availability rules
 * differ by design: Claude's UI runs in the first workspace folder, while a
 * Codex thread keeps its own cwd and only a new Codex panel depends on the
 * window's folders.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { CodexHarness } from '../../src/harnesses/CodexHarness';
import { stub } from './support';

const UI_CWD = '/work/repo';
const OTHER = '/work/repo-feature';
const claude = new ClaudeHarness().nativeUi;
const codex = new CodexHarness().nativeUi;

function windowWith(folders: string[], installed: string[] = ['anthropic.claude-code', 'openai.chatgpt']) {
  stub.__reset();
  stub.workspace.workspaceFolders = folders.map((fsPath) => ({ uri: { fsPath } }));
  for (const id of installed) stub.__setExtensionInstalled(id);
}

/** Record calls to an extension command; `fail` makes it throw. */
function command(id: string, fail?: string) {
  const calls: unknown[][] = [];
  vscode.commands.registerCommand(id, async (...args: unknown[]) => {
    calls.push(args);
    if (fail) throw new Error(fail);
  });
  return calls;
}

beforeEach(() => windowWith([UI_CWD]));

test('availability follows each UI folder rule', () => {
  const cases: [string, string[], string[], () => string, string][] = [
    ['Claude, first folder', [UI_CWD], ['anthropic.claude-code'], () => claude.checkAvailability(UI_CWD).kind, 'available'],
    ['Claude, another worktree', [UI_CWD], ['anthropic.claude-code'], () => claude.checkAvailability(OTHER).kind, 'workspace-mismatch'],
    ['Claude, empty window', [], ['anthropic.claude-code'], () => claude.checkAvailability(UI_CWD).kind, 'no-workspace'],
    ['Claude, not installed', [UI_CWD], [], () => claude.checkAvailability(UI_CWD).kind, 'not-installed'],
    ['Codex thread, any folder', [], ['openai.chatgpt'], () => codex.checkAvailability(OTHER).kind, 'available'],
    ['Codex, not installed', [UI_CWD], [], () => codex.checkAvailability(UI_CWD).kind, 'not-installed'],
    ['new Codex panel, sole folder', [UI_CWD], ['openai.chatgpt'], () => codex.checkNewSessionAvailability(UI_CWD).kind, 'available'],
    ['new Codex panel, multi-root', [UI_CWD, OTHER], ['openai.chatgpt'], () => codex.checkNewSessionAvailability(UI_CWD).kind, 'workspace-multi-root'],
    ['new Codex panel, another worktree', [UI_CWD], ['openai.chatgpt'], () => codex.checkNewSessionAvailability(OTHER).kind, 'workspace-mismatch'],
  ];
  for (const [label, folders, installed, check, expected] of cases) {
    windowWith(folders, installed);
    assert.equal(check(), expected, label);
  }
});

test('an unavailable open is reported before anything opens', async () => {
  windowWith([UI_CWD], ['anthropic.claude-code']);
  const openWith = command('vscode.openWith');
  const claudeOpen = command('claude-vscode.editor.open');
  assert.equal((await codex.openSession('thread-1', UI_CWD)).kind, 'not-installed');
  const refused = await claude.openSession('session-1', OTHER);
  assert.deepEqual(refused, { kind: 'workspace-mismatch', uiCwd: UI_CWD });
  assert.equal(openWith.length + claudeOpen.length + stub.__openExternalCalls.length, 0);
});

test('Claude opens through its command in the active group; the documented URI is only the fallback', async () => {
  const calls = command('claude-vscode.editor.open');
  assert.deepEqual(await claude.openSession('session-1', UI_CWD), { kind: 'opened', via: 'command' });
  assert.equal(calls[0][0], 'session-1');
  assert.equal(calls[0][2], vscode.ViewColumn.Active, 'not a new group on the right');
  assert.deepEqual(calls[0][5], { programmatic: 'honor-preferred-location' });
  await claude.openNewSession(UI_CWD);
  assert.deepEqual(calls[1].slice(0, 2), [undefined, undefined], 'a new conversation passes no session');

  windowWith([UI_CWD]);
  assert.deepEqual(await claude.openSession('session/with?chars', UI_CWD), { kind: 'opened', via: 'uri' });
  assert.equal(stub.__openExternalCalls[0].toString(), `vscode://anthropic.claude-code/open?session=${encodeURIComponent('session/with?chars')}`);
});

test('Codex resumes a thread in its conversation editor and starts new ones with its own command', async () => {
  const openWith = command('vscode.openWith');
  const newPanel = command('chatgpt.newCodexPanel');
  assert.deepEqual(await codex.openSession('thread-1', OTHER), { kind: 'opened', via: 'command' });
  const [uri, viewType, options] = openWith[0] as [vscode.Uri, string, object];
  assert.equal(uri.toString(), 'openai-codex://route/local/thread-1');
  assert.equal(viewType, 'chatgpt.conversationEditor');
  assert.deepEqual(options, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false });

  assert.deepEqual(await codex.openNewSession(UI_CWD), { kind: 'opened', via: 'command' });
  assert.equal(newPanel.length, 1);
});

test('a failed open is reported, never retried another way that could start a new chat', async () => {
  command('claude-vscode.editor.open', 'command exploded');
  assert.deepEqual(await claude.openSession('session-1', UI_CWD), { kind: 'failed', message: 'command exploded' });
  assert.equal(stub.__openExternalCalls.length, 0, 'no URI fallback after the command failed');

  windowWith([UI_CWD]);
  stub.__setOpenExternalResult(false);
  assert.equal((await claude.openSession('session-1', UI_CWD)).kind, 'failed', 'a rejected URI');

  command('vscode.openWith', 'custom editor unavailable');
  assert.deepEqual(await codex.openSession('thread-1', UI_CWD), { kind: 'failed', message: 'custom editor unavailable' });
});
