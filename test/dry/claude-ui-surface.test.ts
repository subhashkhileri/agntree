import * as vscode from 'vscode';
import { ClaudeUiSurfaceService } from '../../src/services/ClaudeUiSurfaceService';

let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

interface FakeTab {
  label: string;
  input: { viewType: string };
  isActive: boolean;
  group: FakeGroup;
}

interface FakeGroup {
  isActive: boolean;
  activeTab: FakeTab | undefined;
  tabs: FakeTab[];
  viewColumn: number;
}

function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    event: (listener: (value: T) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (value: T) => {
      for (const listener of [...listeners]) {
        listener(value);
      }
    },
  };
}

function makeGroup(isActive = true): FakeGroup {
  return { isActive, activeTab: undefined, tabs: [], viewColumn: 1 };
}

function addTab(
  group: FakeGroup,
  label: string,
  options: { active?: boolean; viewType?: string } = {}
): FakeTab {
  const tab: FakeTab = {
    label,
    input: { viewType: options.viewType ?? 'claudeVSCodePanel' },
    isActive: options.active ?? true,
    group,
  };
  if (tab.isActive) {
    for (const existing of group.tabs) {
      existing.isActive = false;
    }
    group.activeTab = tab;
  }
  group.tabs.push(tab);
  return tab;
}

function makeService(groups: FakeGroup[]) {
  const tabChanges = emitter<vscode.TabChangeEvent>();
  const groupChanges = emitter<vscode.TabGroupChangeEvent>();
  const service = new ClaudeUiSurfaceService({
    isUiTab: (tab) =>
      (tab.input as { viewType?: string } | undefined)?.viewType ===
      'claudeVSCodePanel',
    getTabGroups: () => groups as unknown as readonly vscode.TabGroup[],
    onDidChangeTabs: (listener) => tabChanges.event(listener),
    onDidChangeTabGroups: (listener) => groupChanges.event(listener),
  });
  return { service, tabChanges, groupChanges };
}

function tabChange(
  opened: FakeTab[] = [],
  changed: FakeTab[] = [],
  closed: FakeTab[] = []
): vscode.TabChangeEvent {
  return { opened, changed, closed } as unknown as vscode.TabChangeEvent;
}

async function main(): Promise<void> {
  console.log('\n== tab association ==');
  {
    const group = makeGroup();
    const { service, tabChanges } = makeService([group]);
    let changes = 0;
    service.onDidChange(() => {
      changes++;
    });

    const tab = addTab(group, 'Fix login');
    service.expect('session-1', 'Fix login');
    tabChanges.fire(tabChange([tab]));

    check(
      service.activeSessionId() === 'session-1',
      'the opened Claude tab is bound to the session that expected it'
    );
    check(service.isOpen('session-1'), 'the bound session is reported as open');
    check(changes === 1, 'binding the active tab announces the active session');
    service.dispose();
  }

  console.log('\n== focus changes ==');
  {
    const group = makeGroup();
    const groups = [group];
    const { service, tabChanges, groupChanges } = makeService(groups);
    let changes = 0;
    service.onDidChange(() => {
      changes++;
    });

    const claudeTab = addTab(group, 'Session');
    service.expect('session-2', 'Session');
    tabChanges.fire(tabChange([claudeTab]));
    check(service.activeSessionId() === 'session-2', 'the Claude tab is active');

    const fileTab = addTab(group, 'file.ts', { viewType: 'default' });
    tabChanges.fire(tabChange([], [fileTab, claudeTab]));
    check(
      service.activeSessionId() === undefined,
      'a file tab in the same group clears the active session'
    );

    fileTab.isActive = false;
    claudeTab.isActive = true;
    group.activeTab = claudeTab;
    tabChanges.fire(tabChange([], [fileTab, claudeTab]));
    check(
      service.activeSessionId() === 'session-2',
      'switching back to the Claude tab restores the active session'
    );

    const otherGroup = makeGroup(true);
    groups.push(otherGroup);
    addTab(otherGroup, 'README.md', { viewType: 'default' });
    group.isActive = false;
    groupChanges.fire({} as vscode.TabGroupChangeEvent);
    check(
      service.activeSessionId() === undefined,
      'another active editor group clears the active session'
    );

    group.isActive = true;
    otherGroup.isActive = false;
    groupChanges.fire({} as vscode.TabGroupChangeEvent);
    check(
      service.activeSessionId() === 'session-2',
      'returning to the Claude group restores the active session'
    );
    check(changes >= 4, 'every active-session transition is announced');
    service.dispose();
  }

  console.log('\n== label preference ==');
  {
    const group = makeGroup();
    const { service, tabChanges } = makeService([group]);
    service.expect('session-1', 'First session');
    service.expect('session-2', 'Second session');

    const tab = addTab(group, 'Second session');
    tabChanges.fire(tabChange([tab]));
    check(
      service.activeSessionId() === 'session-2',
      'a title match wins over the oldest pending expectation'
    );
    service.dispose();
  }

  console.log('\n== settle and cancel ==');
  {
    const group = makeGroup();
    const { service } = makeService([group]);
    addTab(group, 'Already open');
    service.expect('session-3', 'Already open');
    service.settle('session-3');
    check(
      service.activeSessionId() === 'session-3',
      'settle binds an already-active Claude tab'
    );
    service.dispose();
  }
  {
    const group = makeGroup();
    const { service, tabChanges } = makeService([group]);
    service.expect('session-4', 'Cancelled');
    service.cancelExpect('session-4');
    const tab = addTab(group, 'Cancelled');
    tabChanges.fire(tabChange([tab]));
    check(
      service.activeSessionId() === undefined,
      'a cancelled expectation does not claim a later tab'
    );
    service.dispose();
  }

  console.log('\n== a background link only binds a matching title ==');
  {
    const group = makeGroup();
    const { service } = makeService([group]);
    // Another Claude conversation is the active tab when the importer links a
    // UI-started session; that tab must not be claimed.
    addTab(group, 'Another conversation');
    service.expect('session-7', 'Linked session');
    service.settle('session-7', { allowActiveFallback: false });
    check(
      service.activeSessionId() === undefined,
      'a link without the active-tab fallback leaves another tab alone'
    );
    check(!service.isOpen('session-7'), 'the mismatched tab is not mapped');
    service.dispose();
  }
  {
    const group = makeGroup();
    const { service } = makeService([group]);
    addTab(group, 'Truncated title…');
    service.expect('session-8', 'Truncated title and more');
    service.settle('session-8', { allowActiveFallback: false });
    check(
      service.activeSessionId() === 'session-8',
      'a truncated tab title still binds without the fallback'
    );
    service.dispose();
  }

  console.log('\n== closing and non-Claude tabs ==');
  {
    const group = makeGroup();
    const { service, tabChanges } = makeService([group]);
    const fileTab = addTab(group, 'file.ts', { viewType: 'default' });
    service.expect('session-5', 'file.ts');
    tabChanges.fire(tabChange([fileTab]));
    check(
      service.activeSessionId() === undefined,
      'non-Claude webview tabs are ignored'
    );

    const claudeTab = addTab(group, 'Session');
    service.expect('session-6', 'Session');
    tabChanges.fire(tabChange([claudeTab]));
    check(service.activeSessionId() === 'session-6', 'the Claude tab is bound');
    tabChanges.fire(tabChange([], [], [claudeTab]));
    check(
      service.activeSessionId() === undefined,
      'closing the Claude tab clears the active session'
    );
    check(!service.isOpen('session-6'), 'closing the Claude tab clears the open state');
    service.dispose();
  }

  console.log(
    `\n${failures === 0 ? 'ALL CLAUDE UI SURFACE CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
