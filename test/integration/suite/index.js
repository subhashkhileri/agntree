const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const manifest = require(path.join(repoRoot, 'package.json'));
const extensionId = `${manifest.publisher}.${manifest.name}`;

let failures = 0;

function check(condition, message) {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

exports.run = async function run() {
  console.log('== activation ==');
  const extension = vscode.extensions.getExtension(extensionId);
  assert(extension, `Agntree extension (${extensionId}) is discoverable`);

  await extension.activate();
  check(extension.isActive, 'extension activates without throwing');

  console.log('\n== commands ==');
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'agntree.newClaudeChat',
    'agntree.newClaudeChatInTerminal',
    'agntree.newClaudeChatInUi',
    'agntree.newOpencodeChat',
    'agntree.newCodexChat',
    'agntree.newCodexChatInTerminal',
    'agntree.newCodexChatInUi',
    'agntree.newChat',
    'agntree.importSessions',
    'agntree.searchSessions',
    'agntree.forkChat',
    'agntree.forkChatWithChanges',
    'agntree.openChat',
    'agntree.openChatInTerminal',
    'agntree.openClaudeUi',
    'agntree.openCodexUi',
    'agntree.closeChat',
    'agntree.deleteChat',
    'agntree.refreshWorkspaces',
  ]) {
    check(commands.includes(command), `command registered: ${command}`);
  }

  const agntreeCommands = commands.filter((command) => command.startsWith('agntree.'));
  check(agntreeCommands.length >= 40, `${agntreeCommands.length} agntree commands registered`);

  console.log('\n== configuration ==');
  const config = vscode.workspace.getConfiguration('agntree');
  check(
    JSON.stringify(config.get('harnessCommands')) ===
      JSON.stringify({ claude: 'claude', opencode: 'opencode', codex: 'codex' }),
    'harnessCommands defaults are correct'
  );
  check(
    config.get('notifications.enabled') === true &&
      config.get('notifications.onTurnEnd') === true &&
      config.get('notifications.onNeedsInput') === true &&
      config.get('notifications.nativeBanner') === true,
    'notification settings default to on'
  );
  check(
    config.get('defaultSessionSurface') === 'terminal',
    'sessions default to the terminal surface'
  );
  check(
    config.get('autoImport.enabled') === true &&
      config.get('autoImport.retentionDays') === 7,
    'auto-import defaults to on with a seven-day retention'
  );

  console.log('\n== manifest ==');
  const contributes = manifest.contributes || {};
  const menus = contributes.menus || {};
  const contextMenus = menus['view/item/context'] || [];
  const submenuIds = new Set(
    (contributes.submenus || []).map((submenu) => submenu.id)
  );
  check(
    contextMenus.some((item) => item.submenu === 'agntree.newSession'),
    'worktree context menu opens the new-session submenu'
  );
  const newSessionChildren = [
    ...(menus['agntree.newSession'] || []),
    ...(menus['agntree.newSessionContext'] || []),
  ];
  check(submenuIds.has('agntree.newSession'), 'agntree.newSession submenu is contributed');
  check(
    submenuIds.has('agntree.newSessionContext'),
    'agntree.newSessionContext submenu is contributed'
  );
  check(
    newSessionChildren.some(
      (item) =>
        item.command === 'agntree.newClaudeChat' &&
        item.when.includes('agntree.claudeInstalled') &&
        item.when.includes('config.agntree.defaultSessionSurface')
    ),
    'Claude new-session entry follows the configured surface'
  );
  check(
    newSessionChildren.some(
      (item) => item.command === 'agntree.newClaudeChatInUi'
    ),
    'Claude exposes an explicit UI new-session entry'
  );
  check(
    newSessionChildren.some(
      (item) =>
        item.command === 'agntree.newOpencodeChat' &&
        item.when.includes('agntree.opencodeInstalled')
    ),
    'opencode new-session entry is gated on the installed context key'
  );
  check(
    newSessionChildren.some(
      (item) =>
        item.command === 'agntree.newCodexChat' &&
        item.when.includes('agntree.codexInstalled') &&
        item.when.includes('config.agntree.defaultSessionSurface')
    ),
    'Codex new-session entry follows the configured surface'
  );
  check(
    newSessionChildren.some(
      (item) => item.command === 'agntree.newCodexChatInUi'
    ),
    'Codex exposes an explicit UI new-session entry'
  );
  check(
    contextMenus.some(
      (item) =>
        item.command === 'agntree.openClaudeUi' &&
        item.when.includes('ClaudeUi') &&
        !item.when.includes('claudeUiInstalled') &&
        !String(item.group).startsWith('inline')
    ),
    'Claude UI entry stays visible on Claude rows without the extension'
  );
  check(
    contextMenus.some(
      (item) =>
        item.command === 'agntree.openClaudeUi' &&
        item.when.includes('agntree.claudeUiInstalled') &&
        String(item.group).startsWith('inline')
    ),
    'Claude UI hover action appears only when installed'
  );
  check(
    contextMenus.some(
      (item) =>
        item.command === 'agntree.openCodexUi' &&
        item.when.includes('CodexUi') &&
        !item.when.includes('codexUiInstalled') &&
        !String(item.group).startsWith('inline')
    ),
    'Codex UI entry stays visible on Codex rows without the extension'
  );
  check(
    contextMenus.some(
      (item) =>
        item.command === 'agntree.openCodexUi' &&
        item.when.includes('agntree.codexUiInstalled') &&
        String(item.group).startsWith('inline')
    ),
    'Codex UI hover action appears only when installed'
  );

  const viewTitleMenus = menus['view/title'] || [];
  check(
    !commands.some((command) => command.includes('AttentionHooks')),
    'no attention-hook commands are registered'
  );
  check(
    !viewTitleMenus.some(
      (item) =>
        String(item.command).includes('AttentionHooks') ||
        String(item.when).includes('attentionHooks')
    ),
    'no attention-hook toggles remain in the view menu'
  );

  console.log('\n== wiring smoke tests ==');
  await vscode.commands.executeCommand('agntree.refreshWorkspaces');
  check(true, 'refreshWorkspaces executes');

  console.log(
    `\n${failures === 0 ? 'ALL ACTIVATION CHECKS PASSED' : `${failures} ACTIVATION FAILURE(S)`}`
  );
  if (failures > 0) {
    throw new Error(`${failures} activation check(s) failed`);
  }
};
