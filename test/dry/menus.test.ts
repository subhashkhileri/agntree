import pkg from '../../package.json';

/**
 * The Workspaces panel keeps destructive and occasional actions out of the
 * hover row. These checks lock the quiet layout so a new inline entry cannot
 * quietly reintroduce clutter (or a delete button one click away).
 */

interface MenuEntry {
  command?: string;
  submenu?: string;
  when?: string;
  group?: string;
}

const menus = pkg.contributes.menus as Record<string, MenuEntry[]>;
const title = menus['view/title'] ?? [];
const itemContext = menus['view/item/context'] ?? [];
const commands = pkg.contributes.commands as { command: string; title: string }[];

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

const isWorkspacesTitle = (entry: MenuEntry): boolean =>
  Boolean(entry.when?.includes('agntree.workspacesView'));
const isInline = (entry: MenuEntry): boolean =>
  entry.group?.split('@')[0] === 'inline';
const isWorkspacesItem = (entry: MenuEntry): boolean =>
  Boolean(entry.when?.includes('agntree.workspacesView'));

console.log('\n== view title ==');
const workspacesTitle = title.filter(isWorkspacesTitle);
const inlineTitle = workspacesTitle.filter(
  (entry) => entry.group?.split('@')[0] === 'navigation'
);
check(
  inlineTitle.length === 1 && inlineTitle[0].command === 'agntree.addRepository',
  `only Add Repository is an inline title action: ${inlineTitle.map((e) => e.command).join(', ')}`
);
check(
  !workspacesTitle.some(
    (entry) =>
      entry.command === 'agntree.refreshWorkspaces' &&
      entry.group?.startsWith('navigation')
  ),
  'refresh stays in the overflow menu'
);
check(
  workspacesTitle.some((entry) => entry.command === 'agntree.searchSessions'),
  'Search Sessions is reachable from the title menu'
);
check(
  workspacesTitle.some((entry) => entry.command === 'agntree.showStarredSessions'),
  'Starred Sessions is reachable from the title menu'
);

console.log('\n== item hover actions ==');
const inlineItems = itemContext.filter(isWorkspacesItem).filter(isInline);
const inlineCommands = new Set(
  inlineItems.map((entry) => entry.command ?? entry.submenu)
);

for (const command of [
  'agntree.deleteChat',
  'agntree.removeRepository',
  'agntree.deleteWorktree',
  'agntree.forkChatWithChanges',
  'agntree.clearWorktreeSessions',
]) {
  check(!inlineCommands.has(command), `${command} is not an inline hover action`);
}

for (const command of [
  'agntree.newSession',
  'agntree.openTerminalAtWorktree',
  'agntree.renameChat',
  'agntree.toggleStarChat',
]) {
  check(inlineCommands.has(command), `${command} stays one click away`);
}

check(
  itemContext.some(
    (entry) => entry.command === 'agntree.deleteChat' && entry.group?.includes('destructive')
  ),
  'Remove from List remains in the context menu'
);

console.log('\n== harness menus ==');
for (const submenu of ['agntree.newSession', 'agntree.newSessionContext']) {
  const entries = menus[submenu] ?? [];
  check(
    entries.some(
      (entry) =>
        entry.command === 'agntree.newCodexChat' &&
        entry.when === 'agntree.codexInstalled'
    ),
    `${submenu} lists New Codex Session behind codexInstalled`
  );
  check(
    entries.some(
      (entry) =>
        entry.command === 'agntree.newOpencodeChat' &&
        entry.when === 'agntree.opencodeInstalled'
    ),
    `${submenu} keeps the opencode entry`
  );
}
for (const entry of itemContext.filter((candidate) => candidate.submenu)) {
  check(
    Boolean(entry.when?.includes('agntree.anyHarnessInstalled')),
    `${entry.submenu} is gated on anyHarnessInstalled`
  );
}
check(
  commands.some((entry) => entry.command === 'agntree.newCodexChat'),
  'New Codex Session is a contributed command'
);

console.log('\n== hooks removed ==');
check(
  !commands.some((entry) => entry.command.includes('AttentionHooks')),
  'no attention-hook commands remain'
);
check(
  !itemContext.some((entry) => entry.when?.includes('attentionHooks')) &&
    !title.some((entry) => entry.when?.includes('attentionHooks')),
  'no attention-hook context key or menu entries remain'
);

console.log('\n== dialog wording ==');
const openingDialogs = [
  'agntree.addRepository',
  'agntree.cloneRepository',
  'agntree.importSessions',
  'agntree.forkChatWithChanges',
  'agntree.renameChat',
];
for (const command of openingDialogs) {
  const entry = commands.find((candidate) => candidate.command === command);
  check(
    Boolean(entry?.title.endsWith('…')),
    `${command} title ends with an ellipsis: ${entry?.title}`
  );
}

console.log(
  `\n${failures === 0 ? 'ALL MENU CHECKS PASSED' : `${failures} FAILURE(S)`}`
);
process.exit(failures === 0 ? 0 : 1);
