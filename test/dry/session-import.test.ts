import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import {
  HarnessAdapter,
  HarnessSession,
  NativeUiCapability,
} from '../../src/harnesses/types';
import {
  SessionImportService,
  SessionImportSettings,
} from '../../src/services/SessionImportService';
import { StorageService } from '../../src/services/StorageService';
import { Worktree } from '../../src/types';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-import-'));
let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function makeMemento() {
  const state = new Map<string, unknown>();
  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  return {
    get: <T>(key: string, fallback: T): T =>
      state.has(key) ? clone(state.get(key) as T) : fallback,
    update: async (key: string, value: unknown): Promise<void> => {
      state.set(key, clone(value));
    },
    keys: () => Array.from(state.keys()),
    setKeysForSync: () => undefined,
  };
}

interface Fixture {
  storage: StorageService;
  worktree: Worktree;
  sessions: HarnessSession[];
  settings: SessionImportSettings;
  /** How many times the importer has listed sessions. */
  listCalls: () => number;
  /**
   * The current importer. A restart drops in-memory expectations and builds a
   * new service over the same stored state, like an extension-host reload.
   */
  readonly service: SessionImportService;
  restart: () => SessionImportService;
  dispose: () => void;
}

function setup(options: { openChatIds?: Set<string> } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(ROOT, 'case-'));
  const worktreePath = path.join(root, 'worktree');
  fs.mkdirSync(worktreePath, { recursive: true });

  const storage = new StorageService({
    globalState: makeMemento(),
    workspaceState: makeMemento(),
  } as any);
  const repo = storage.addRepository('demo', worktreePath);
  const worktree: Worktree = {
    id: 'wt-main',
    repoId: repo.id,
    name: 'main',
    path: worktreePath,
    isMain: true,
  };

  const sessions: HarnessSession[] = [];
  let listCalls = 0;
  const nativeUi: NativeUiCapability = {
    displayName: 'Claude Code UI',
    contextValueSuffix: 'ClaudeUi',
    extensionId: 'anthropic.claude-code',
    isInstalled: () => true,
    checkAvailability: () => ({ kind: 'available' }),
    checkNewSessionAvailability: () => ({ kind: 'available' }),
    openNewSession: async () => ({ kind: 'opened', via: 'command' }),
    openSession: async () => ({ kind: 'opened', via: 'command' }),
  };

  const adapter: HarnessAdapter = {
    id: 'claude',
    displayName: 'Claude Code',
    icon: 'sparkle',
    capabilities: {
      fork: true,
      move: false,
      newSessionId: true,
      preview: 'inline',
    },
    nativeUi,
    isInstalled: async () => true,
    buildLaunchCommand: () => 'claude',
    isSessionResumable: async () => true,
    listSessionsForWorktree: async () => {
      listCalls++;
      return sessions;
    },
    listSessionsForRepository: async () => {
      listCalls++;
      return sessions;
    },
    getSessionMetadata: async () => null,
    getPreview: async () => [],
    forkSession: async () => ({ kind: 'linked', sessionId: 'fork' }),
    moveSession: async () => undefined,
    prepareForkToNewWorktree: async () => ({
      kind: 'linked',
      sessionId: 'fork',
    }),
  };

  const registry = new HarnessRegistry([adapter]);
  const settings: SessionImportSettings = {
    enabled: true,
    retentionDays: 7,
  };
  const makeService = (): SessionImportService =>
    new SessionImportService(
      storage,
      {
        listRepositoryWorktrees: () => ({ isGit: true, worktrees: [worktree] }),
      } as any,
      registry,
      {
        scanIntervalMs: 40,
        hotScanIntervalMs: 10,
        isChatOpen: (chat) => options.openChatIds?.has(chat.id) ?? false,
        readSettings: () => settings,
      }
    );
  let service = makeService();

  return {
    storage,
    worktree,
    sessions,
    settings,
    listCalls: () => listCalls,
    get service() {
      return service;
    },
    restart: () => {
      service.dispose();
      service = makeService();
      return service;
    },
    dispose: () => {
      service.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function session(
  fixture: Fixture,
  id: string,
  summary: string | null,
  ageMs: number
): HarnessSession {
  const time = new Date(Date.now() - ageMs);
  return {
    harness: 'claude',
    sessionId: id,
    cwd: fixture.worktree.path,
    summary,
    gitBranch: null,
    lastUpdated: time,
    lastActivity: time.getTime(),
    messageCount: 1,
  };
}

async function waitFor(
  condition: () => unknown,
  what: string
): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  console.log('\n== external sessions ==');
  {
    const fixture = setup();
    const name = 'Named by the harness';
    fixture.sessions.push(session(fixture, 's-recent', name, 60_000));
    fixture.sessions.push(session(fixture, 's-old', 'Old session', 8 * DAY));

    fixture.service.start();
    await waitFor(
      () =>
        fixture.storage
          .getChats()
          .some((chat) => chat.harnessSessionId === 's-recent'),
      'the recent session to be imported'
    );

    const imported = fixture.storage
      .getChats()
      .find((chat) => chat.harnessSessionId === 's-recent');
    check(imported?.name === name, 'the harness name becomes the chat name');
    check(imported?.autoImported === true, 'the chat is marked auto-imported');
    check(
      !fixture.storage
        .getChats()
        .some((chat) => chat.harnessSessionId === 's-old'),
      'a session older than the retention window is not imported'
    );

    fixture.sessions[0].summary = 'Updated harness name';
    await waitFor(
      () =>
        fixture.storage.getChat(imported!.id)?.name ===
        'Updated harness name',
      'the harness name to replace the first-prompt name'
    );
    fixture.storage.updateChat(imported!.id, {
      name: 'My name',
      customName: true,
    });
    fixture.sessions[0].summary = 'Ignored harness name';
    await waitFor(() => fixture.listCalls() > 2, 'another scan');
    check(
      fixture.storage.getChat(imported!.id)?.name === 'My name',
      'a user rename is never overwritten by auto-import'
    );
    fixture.dispose();
  }

  console.log('\n== removed sessions stay removed ==');
  {
    const fixture = setup();
    fixture.sessions.push(session(fixture, 's-removed', 'Removed', 60_000));
    fixture.storage.rememberRemovedSession('claude', 's-removed');
    fixture.service.start();
    await waitFor(() => fixture.listCalls() > 0, 'the first scan');
    check(
      !fixture.storage
        .getChats()
        .some((chat) => chat.harnessSessionId === 's-removed'),
      'a removed session is not resurrected by auto-import'
    );
    fixture.dispose();
  }

  console.log('\n== UI-started placeholder ==');
  {
    const fixture = setup();
    const chat = fixture.storage.createChat(
      fixture.worktree.id,
      'New Session',
      null,
      'claude'
    );
    fixture.storage.updateChat(chat.id, { pendingUiLaunch: true });
    await fixture.service.expectChat(chat.id, fixture.worktree.path, {
      bindSurface: false,
    });

    fixture.sessions.push(session(fixture, 's-ui', 'UI session', 0));
    fixture.service.start();
    await waitFor(
      () => Boolean(fixture.storage.getChat(chat.id)?.harnessSessionId),
      'the UI session to link'
    );

    const linked = fixture.storage.getChat(chat.id);
    check(
      linked?.harnessSessionId === 's-ui',
      'the placeholder links to the UI-created session'
    );
    check(
      linked?.name === 'UI session',
      'the linked placeholder takes the harness name'
    );
    check(
      linked?.pendingUiLaunch === false,
      'the placeholder stops waiting after linking'
    );
    fixture.dispose();
  }

  console.log('\n== retention ==');
  {
    const openChatIds = new Set<string>();
    const fixture = setup({ openChatIds });
    const oldSession = session(fixture, 's-auto-old', 'Old auto', 8 * DAY);
    const starredSession = session(
      fixture,
      's-auto-starred',
      'Old starred',
      8 * DAY
    );
    const userSession = session(fixture, 's-user-old', 'Old user', 8 * DAY);
    const userStarredSession = session(
      fixture,
      's-user-starred',
      'Old user starred',
      8 * DAY
    );
    const openSession = session(fixture, 's-open-old', 'Old open', 8 * DAY);
    fixture.sessions.push(
      oldSession,
      starredSession,
      userSession,
      userStarredSession,
      openSession
    );

    const oldChat = fixture.storage.createChat(
      fixture.worktree.id,
      'Old auto',
      null,
      'claude'
    );
    fixture.storage.updateChat(oldChat.id, {
      harnessSessionId: oldSession.sessionId,
      autoImported: true,
      createdAt: oldSession.lastUpdated!.getTime(),
      lastAccessedAt: oldSession.lastUpdated!.getTime(),
    });

    const starredChat = fixture.storage.createChat(
      fixture.worktree.id,
      'Old starred',
      null,
      'claude'
    );
    fixture.storage.updateChat(starredChat.id, {
      harnessSessionId: starredSession.sessionId,
      autoImported: true,
      createdAt: starredSession.lastUpdated!.getTime(),
      lastAccessedAt: starredSession.lastUpdated!.getTime(),
    });
    fixture.storage.toggleStar(starredChat.id);

    const userChat = fixture.storage.createChat(
      fixture.worktree.id,
      'Old user',
      null,
      'claude'
    );
    fixture.storage.updateChat(userChat.id, {
      harnessSessionId: userSession.sessionId,
      createdAt: userSession.lastUpdated!.getTime(),
      lastAccessedAt: userSession.lastUpdated!.getTime(),
    });

    const starredUserChat = fixture.storage.createChat(
      fixture.worktree.id,
      'Old user starred',
      null,
      'claude'
    );
    fixture.storage.updateChat(starredUserChat.id, {
      harnessSessionId: userStarredSession.sessionId,
      createdAt: userStarredSession.lastUpdated!.getTime(),
      lastAccessedAt: userStarredSession.lastUpdated!.getTime(),
    });
    fixture.storage.toggleStar(starredUserChat.id);

    const openChat = fixture.storage.createChat(
      fixture.worktree.id,
      'Old open',
      null,
      'claude'
    );
    fixture.storage.updateChat(openChat.id, {
      harnessSessionId: openSession.sessionId,
      createdAt: openSession.lastUpdated!.getTime(),
      lastAccessedAt: openSession.lastUpdated!.getTime(),
    });
    openChatIds.add(openChat.id);

    const unlinkedChat = fixture.storage.createChat(
      fixture.worktree.id,
      'Old unlinked',
      null,
      'claude'
    );
    fixture.storage.updateChat(unlinkedChat.id, {
      createdAt: Date.now() - 8 * DAY,
      lastAccessedAt: Date.now() - 8 * DAY,
    });

    fixture.service.start();
    await waitFor(
      () => !fixture.storage.getChat(oldChat.id),
      'the expired chat to be removed'
    );
    check(
      !fixture.storage.getChat(userChat.id),
      'retention applies to a chat Agntree created'
    );
    check(
      !fixture.storage.getChat(unlinkedChat.id),
      'retention applies to a chat with no linked session'
    );
    check(
      Boolean(fixture.storage.getChat(starredChat.id)),
      'a starred auto-import survives retention'
    );
    check(
      Boolean(fixture.storage.getChat(starredUserChat.id)),
      'a starred user-created chat survives retention'
    );
    check(
      Boolean(fixture.storage.getChat(openChat.id)),
      'a chat open in a terminal or UI tab survives retention'
    );
    fixture.dispose();
  }

  console.log('\n== CLI placeholder is reserved ==');
  {
    const fixture = setup();
    const awaiting = fixture.storage.createChat(
      fixture.worktree.id,
      'New Session',
      null,
      'claude'
    );
    fixture.sessions.push(session(fixture, 's-cli', 'CLI session', 0));
    fixture.service.start();
    await waitFor(() => fixture.listCalls() > 0, 'the scan');
    check(
      !fixture.storage
        .getChats()
        .some(
          (chat) =>
            chat.autoImported === true &&
            chat.harnessSessionId === 's-cli'
        ),
      'auto-import does not race the watcher that owns a CLI placeholder'
    );
    check(
      fixture.storage.getChat(awaiting.id)?.harnessSessionId === null,
      'the CLI placeholder is left for its watcher'
    );
    fixture.dispose();
  }

  console.log('\n== disabled auto-import ==');
  {
    const fixture = setup();
    fixture.settings.enabled = false;
    fixture.sessions.push(session(fixture, 's-disabled', 'Disabled', 60_000));
    fixture.service.start();
    await waitFor(() => fixture.listCalls() > 0, 'the scan');
    check(
      !fixture.storage
        .getChats()
        .some((chat) => chat.harnessSessionId === 's-disabled'),
      'auto-import stays off when the setting is disabled'
    );
    fixture.dispose();
  }

  console.log('\n== a reload keeps the launch snapshot ==');
  {
    const fixture = setup();
    const preExisting = session(fixture, 's-pre', 'Pre-existing', 60_000);
    fixture.sessions.push(preExisting);

    const chat = fixture.storage.createChat(
      fixture.worktree.id,
      'New Session',
      null,
      'claude'
    );
    fixture.storage.updateChat(chat.id, { pendingUiLaunch: true });
    await fixture.service.expectChat(chat.id, fixture.worktree.path, {
      bindSurface: false,
    });
    check(
      fixture.storage.getChat(chat.id)?.pendingUiKnownSessionIds?.[0] ===
        's-pre',
      'the launch snapshot is persisted so it survives a reload'
    );

    // The extension host restarts before the first prompt, and the session
    // that already existed stays active in another terminal, so its timestamp
    // is newer than the placeholder.
    preExisting.lastUpdated = new Date();
    preExisting.lastActivity = Date.now();
    const restarted = fixture.restart();
    restarted.start();
    await waitFor(() => fixture.listCalls() > 0, 'the scan after the reload');
    check(
      fixture.storage.getChat(chat.id)?.harnessSessionId === null,
      'the reloaded placeholder does not claim the session that was already there'
    );

    fixture.sessions.push(session(fixture, 's-ui', 'UI session', 0));
    await waitFor(
      () => fixture.storage.getChat(chat.id)?.harnessSessionId === 's-ui',
      'the UI session to link after the reload'
    );
    check(
      fixture.storage.getChat(chat.id)?.pendingUiKnownSessionIds === undefined,
      'linking clears the persisted snapshot'
    );
    fixture.dispose();
  }

  console.log('\n== a stale placeholder reserves nothing ==');
  {
    const fixture = setup();
    const stale = fixture.storage.createChat(
      fixture.worktree.id,
      'New Session',
      null,
      'claude'
    );
    fixture.storage.updateChat(stale.id, {
      createdAt: Date.now() - 2 * DAY,
      lastAccessedAt: Date.now() - 2 * DAY,
    });
    fixture.sessions.push(session(fixture, 's-external', 'External', 0));
    fixture.service.start();
    await waitFor(
      () =>
        fixture.storage
          .getChats()
          .some((chat) => chat.harnessSessionId === 's-external'),
      'the external session to be imported'
    );
    check(
      fixture.storage
        .getChats()
        .some(
          (chat) => chat.autoImported === true && chat.harnessSessionId === 's-external'
        ),
      'a placeholder that never got a session stops reserving new ones'
    );
    fixture.dispose();
  }

  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL SESSION IMPORT CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(ROOT, { recursive: true, force: true });
  process.exit(1);
});
