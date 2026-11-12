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
interface Setting { enum?: string[]; enumItemLabels?: string[]; markdownDescription?: string; order?: number }
const sections = pkg.contributes.configuration as unknown as { title: string; properties: Record<string, Setting> }[];
const settings: Record<string, Setting> = Object.assign({}, ...sections.map((section) => section.properties));
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
  for (const command of ['agntree.newSession', 'agntree.newDefaultSession', 'agntree.openTerminalAtWorktree', 'agntree.renameChat', 'agntree.starChat', 'agntree.unstarChat']) {
    assert.ok(inline.has(command), `${command} stays one click away`);
  }
  assert.ok(
    rowMenu.some((entry) => entry.command === 'agntree.deleteChat' && entry.group?.includes('destructive')),
    'Remove Session from List lives in the destructive context group'
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
    assert.ok(entries.some((entry) => entry.command === 'agntree.setDefaultHarness'), `${submenu} offers Set Default Agent`);
    for (const entry of entries.filter((candidate) => candidate.command !== 'agntree.setDefaultHarness')) {
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

test('the New Session button is the menu until a default agent is set, then one click; the context menu always lists every agent', () => {
  const worktreeInline = rowMenu.filter((entry) => isInline(entry) && entry.when?.includes('worktree|folderRepository'));
  const button = (entryId: string) => worktreeInline.find((entry) => id(entry) === entryId);
  assert.match(button('agntree.newSession')?.when ?? '', /!config\.agntree\.defaultHarness/);
  assert.match(button('agntree.newDefaultSession')?.when ?? '', /[^!]config\.agntree\.defaultHarness/);
  assert.equal(button('agntree.newSession')?.group, button('agntree.newDefaultSession')?.group, 'the same slot');
  const context = rowMenu.find((entry) => entry.submenu === 'agntree.newSessionContext');
  assert.ok(context && !context.when?.includes('defaultHarness'), 'every agent stays one right-click away');

  const harnesses = Object.keys(settings).flatMap((key) => /^agntree\.harnessCommands\.(\w+)$/.exec(key)?.[1] ?? []);
  assert.deepEqual(settings['agntree.defaultHarness'].enum, ['', ...harnesses], 'the default agent can be any harness, or none');
});

test('every setting sits in a titled section, explains itself, and names its choices; Agntree Settings is in the view menu', () => {
  assert.ok(sections.length > 1 && sections.every((section) => section.title), 'settings are grouped');
  for (const [key, setting] of Object.entries(settings)) {
    assert.ok(setting.markdownDescription, `${key} has a description`);
    assert.ok(setting.order, `${key} has a position in its section`);
    if (setting.enum) {
      assert.equal(setting.enumItemLabels?.length, setting.enum.length, `${key} labels every choice`);
    }
  }
  assert.ok(
    (menus['view/title'] ?? []).some((entry) => entry.command === 'agntree.openSettings' && entry.when?.includes('agntree.workspacesView')),
    'the settings are one click from the sidebar'
  );
});

test('every Workspaces context entry sits in a numbered group, and every command is in the Agntree category', () => {
  for (const entry of rowMenu.filter((candidate) => !isInline(candidate) && !candidate.when?.includes('changedFile'))) {
    assert.match(entry.group ?? '', /^\d_\w+@\d$/, id(entry));
  }
  for (const command of pkg.contributes.commands as { command: string; category?: string }[]) {
    assert.equal(command.category, 'Agntree', command.command);
  }
});

test('with several session rows selected, the context menu keeps only actions that apply to all of them', () => {
  const sessionContext = rowMenu.filter((entry) => !isInline(entry) && /chat\|/i.test(entry.when ?? ''));
  assert.ok(sessionContext.length > 0);
  const bulk = new Set(['agntree.starChat', 'agntree.unstarChat', 'agntree.closeChat', 'agntree.deleteChat']);
  for (const entry of sessionContext) {
    assert.equal(!entry.when?.includes('!listMultiSelection'), bulk.has(id(entry)), id(entry));
  }
});

test('global shortcuts use Ctrl+Alt (Ctrl+Cmd on macOS); plain keys work only in a focused Agntree tree, never while typing', () => {
  const bindings = pkg.contributes.keybindings as { command: string; key: string; mac?: string; when?: string }[];
  for (const binding of bindings) {
    if (binding.when) {
      assert.match(binding.when, /^focusedView == 'agntree\.(workspaces|files)View' && !inputFocus/, binding.command);
    } else {
      assert.match(binding.key, /^ctrl\+alt\+\w+$/, binding.command);
      assert.match(binding.mac ?? '', /^ctrl\+cmd\+\w+$/, binding.command);
    }
  }
  const known = new Set([...commands.map((entry) => entry.command), 'workbench.view.extension.agntree']);
  assert.deepEqual(bindings.filter((binding) => !known.has(binding.command)), [], 'every shortcut runs a real command');
  assert.ok(
    (menus['view/title'] ?? []).some((entry) => entry.command === 'agntree.openKeybindings'),
    'the shortcuts can be changed from the sidebar menu'
  );
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
  for (const command of ['agntree.moveRepositoryUp', 'agntree.renameChat', 'agntree.deleteWorktree', 'agntree.files.delete', 'agntree.starChat']) {
    assert.ok(
      (menus.commandPalette ?? []).some((entry) => entry.command === command && entry.when === 'false'),
      `${command} is hidden from the palette`
    );
  }
});
