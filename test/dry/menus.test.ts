/**
 * Manifest rules for the quiet layout. Each test states a rule over every
 * entry it applies to, so a new harness or command is covered without a new
 * check. Registration and activation are proven by the integration suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import pkg from '../../package.json';

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const menus = pkg.contributes.menus as Record<string, MenuEntry[]>;
const commands = pkg.contributes.commands as { command: string; title: string }[];
const rowMenu = (menus['view/item/context'] ?? []).filter((entry) =>
  entry.when?.includes('agntree.workspacesView')
);
const isInline = (entry: MenuEntry) => entry.group?.split('@')[0] === 'inline';
const id = (entry: MenuEntry) => entry.command ?? entry.submenu ?? '';

test('the hover row keeps frequent actions and nothing destructive or occasional', () => {
  const inline = new Set(rowMenu.filter(isInline).map(id));
  for (const command of [
    'agntree.deleteChat',
    'agntree.removeRepository',
    'agntree.deleteWorktree',
    'agntree.forkChatWithChanges',
    'agntree.clearWorktreeSessions',
    'agntree.moveRepositoryUp',
    'agntree.moveRepositoryDown',
  ]) {
    assert.ok(!inline.has(command), `${command} is not a hover action`);
  }
  for (const command of ['agntree.newSession', 'agntree.openTerminalAtWorktree', 'agntree.renameChat', 'agntree.toggleStarChat']) {
    assert.ok(inline.has(command), `${command} stays one click away`);
  }
  assert.ok(
    rowMenu.some((entry) => entry.command === 'agntree.deleteChat' && entry.group?.includes('destructive')),
    'Remove from List lives in the destructive context group'
  );

  const titleInline = (menus['view/title'] ?? []).filter(
    (entry) => entry.when?.includes('agntree.workspacesView') && entry.group?.startsWith('navigation')
  );
  assert.deepEqual(titleInline.map(id), ['agntree.addRepository'], 'one inline title action');
});

test('a plain folder row offers shared actions but no git-only ones', () => {
  const folderActions = new Set(rowMenu.filter((entry) => entry.when?.includes('folderRepository')).map(id));
  for (const shared of ['agntree.newSession', 'agntree.openTerminalAtWorktree', 'agntree.removeRepository', 'agntree.moveRepositoryUp']) {
    assert.ok(folderActions.has(shared), shared);
  }
  for (const gitOnly of ['agntree.addWorktree', 'agntree.checkoutPR', 'agntree.deleteWorktree', 'agntree.mergeWorktree', 'agntree.rebaseWorktree', 'agntree.openPRInBrowser']) {
    assert.ok(!folderActions.has(gitOnly), gitOnly);
  }
});

test('New Session entries are gated on their harness, and the submenus on any harness', () => {
  for (const submenu of ['agntree.newSession', 'agntree.newSessionContext']) {
    const entries = menus[submenu] ?? [];
    assert.ok(entries.length > 0, submenu);
    for (const entry of entries) {
      const [, harness, variant] = /^agntree\.new(\w+?)Chat(InTerminal|InUi)?$/.exec(entry.command ?? '') ?? [];
      assert.ok(harness, `${entry.command} is a New Session command`);
      const key = harness.toLowerCase();
      if (variant === 'InUi') {
        // Shown without the extension, so clicking it can explain the install.
        assert.match(entry.when ?? '', /defaultSessionSurface != 'ui'/, entry.command);
      } else {
        assert.ok(entry.when?.includes(`agntree.${key}Installed`), `${entry.command} needs the ${key} CLI`);
      }
    }
  }
  for (const entry of rowMenu.filter((candidate) => candidate.submenu)) {
    assert.ok(entry.when?.includes('agntree.anyHarnessInstalled'), entry.submenu);
  }
});

test('Open in UI stays in the context menu without its extension and is a hover action only with it', () => {
  for (const [command, ui] of [['agntree.openClaudeUi', 'claude'], ['agntree.openCodexUi', 'codex']]) {
    const entries = rowMenu.filter((entry) => entry.command === command);
    const context = entries.filter((entry) => !isInline(entry));
    const inline = entries.filter(isInline);
    assert.equal(context.length, 1, command);
    assert.ok(!context[0].when?.includes(`${ui}UiInstalled`), `${command} explains a missing extension`);
    assert.ok(inline.length > 0 && inline.every((entry) => entry.when?.includes(`agntree.${ui}UiInstalled`)), command);
  }
  const inTerminal = rowMenu.filter((entry) => entry.command === 'agntree.openChatInTerminal');
  assert.ok(inTerminal.some((entry) => isInline(entry) && entry.when?.includes('chat|starredChat')), 'inline for closed rows');
  assert.ok(inTerminal.some((entry) => !isInline(entry) && entry.when?.includes('runningChat')), 'context menu for running rows');
});

test('dialog commands end in an ellipsis; row-only commands stay out of the palette', () => {
  for (const command of ['agntree.addRepository', 'agntree.cloneRepository', 'agntree.importSessions', 'agntree.forkChatWithChanges', 'agntree.renameChat']) {
    assert.match(commands.find((entry) => entry.command === command)?.title ?? '', /…$/, command);
  }
  for (const command of ['agntree.moveRepositoryUp', 'agntree.moveRepositoryDown']) {
    assert.ok(
      (menus.commandPalette ?? []).some((entry) => entry.command === command && entry.when === 'false'),
      `${command} is hidden from the palette`
    );
  }
});
