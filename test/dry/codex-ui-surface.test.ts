import * as vscode from 'vscode';
import { CodexUiSurfaceService } from '../../src/services/CodexUiSurfaceService';

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
  input: unknown;
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

function makeTab(
  group: FakeGroup,
  options: {
    sessionId?: string;
    label?: string;
    active?: boolean;
    viewType?: string;
    path?: string;
  } = {}
): FakeTab {
  const {
    sessionId,
    label = 'Codex',
    active = true,
    viewType = 'chatgpt.conversationEditor',
    path = sessionId ? `/local/${sessionId}` : '/extension/panel/new',
  } = options;
  const uri = vscode.Uri.from({
    scheme: 'openai-codex',
    authority: 'route',
    path,
  });
  const tab: FakeTab = {
    label,
    input: new (vscode as any).TabInputCustom(uri, viewType),
    isActive: active,
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
  const service = new CodexUiSurfaceService({
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
  console.log('\n== exact tab identity ==');
  {
    const group = makeGroup();
    const restored = makeTab(group, { sessionId: 'thread-1' });
    const { service } = makeService([group]);
    check(
      service.activeSessionId() === 'thread-1',
      'a restored Codex panel is identified from its resource'
    );
    check(
      service.isOpen('thread-1'),
      'a restored Codex panel is open without an expectation'
    );
    check(
      !service.isOpen('thread-2'),
      'another thread is not open'
    );
    service.dispose();
    void restored;
  }

  console.log('\n== tab events and focus ==');
  {
    const group = makeGroup();
    const { service, tabChanges, groupChanges } = makeService([group]);
    let changes = 0;
    service.onDidChange(() => {
      changes++;
    });

    const panel = makeTab(group, { sessionId: 'thread-2' });
    tabChanges.fire(tabChange([panel]));
    check(
      service.activeSessionId() === 'thread-2',
      'a new Codex panel becomes the active session'
    );
    check(service.isOpen('thread-2'), 'the new panel is open');
    check(changes === 1, 'opening the panel announces the change');

    const fileTab: FakeTab = {
      label: 'file.ts',
      input: { viewType: 'default' },
      isActive: true,
      group,
    };
    for (const existing of group.tabs) {
      existing.isActive = false;
    }
    group.tabs.push(fileTab);
    group.activeTab = fileTab;
    tabChanges.fire(tabChange([], [fileTab, panel]));
    check(
      service.activeSessionId() === undefined,
      'a file tab clears the active session'
    );

    fileTab.isActive = false;
    panel.isActive = true;
    group.activeTab = panel;
    tabChanges.fire(tabChange([], [fileTab, panel]));
    check(
      service.activeSessionId() === 'thread-2',
      'switching back to the Codex panel restores the active session'
    );

    const otherGroup = makeGroup(true);
    otherGroup.tabs.push({
      label: 'README.md',
      input: { viewType: 'default' },
      isActive: true,
      group: otherGroup,
    });
    otherGroup.activeTab = otherGroup.tabs[0];
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
      service.activeSessionId() === 'thread-2',
      'returning to the Codex group restores the active session'
    );
    check(changes >= 4, 'every active-session transition is announced');
    service.dispose();
  }

  console.log('\n== settle and close ==');
  {
    const group = makeGroup();
    const { service, tabChanges } = makeService([group]);
    const panel = makeTab(group, { sessionId: 'thread-3' });
    service.expect('thread-3', 'Codex');
    service.settle('thread-3');
    check(
      service.activeSessionId() === 'thread-3',
      'settle binds the active panel without a tab event'
    );
    tabChanges.fire(tabChange([], [], [panel]));
    group.tabs.length = 0;
    group.activeTab = undefined;
    check(
      service.activeSessionId() === undefined,
      'closing the panel clears the active session'
    );
    check(!service.isOpen('thread-3'), 'closing the panel clears the open state');
    service.dispose();
  }

  console.log('\n== ignored tabs ==');
  {
    const group = makeGroup();
    const { service, tabChanges } = makeService([group]);
    const otherEditor = makeTab(group, {
      sessionId: 'thread-4',
      viewType: 'other.conversationEditor',
    });
    const webview = {
      label: 'Other UI',
      input: new (vscode as any).TabInputWebview('other.webview'),
      isActive: true,
      group,
    };
    group.tabs.push(webview as FakeTab);
    group.activeTab = webview as FakeTab;
    tabChanges.fire(tabChange([otherEditor, webview as FakeTab]));
    check(
      service.activeSessionId() === undefined,
      'other custom editors and webviews are ignored'
    );
    check(!service.isOpen('thread-4'), 'an ignored tab does not open a session');
    service.dispose();
  }

  console.log(
    `\n${failures === 0 ? 'ALL CODEX UI SURFACE CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
