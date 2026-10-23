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
    'agntree.newOpencodeChat',
    'agntree.newChat',
    'agntree.importSessions',
    'agntree.searchSessions',
    'agntree.forkChat',
    'agntree.forkChatWithChanges',
    'agntree.openChat',
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
      JSON.stringify({ claude: 'claude', opencode: 'opencode' }),
    'harnessCommands defaults are correct'
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
      (item) => item.command === 'agntree.newClaudeChat' && item.when.includes('agntree.claudeInstalled')
    ),
    'Claude new-session entry is gated on the installed context key'
  );
  check(
    newSessionChildren.some(
      (item) => item.command === 'agntree.newOpencodeChat' && item.when.includes('agntree.opencodeInstalled')
    ),
    'opencode new-session entry is gated on the installed context key'
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
