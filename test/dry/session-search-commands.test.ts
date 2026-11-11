/**
 * Find Session commands against a fake harness: asking with the chosen engine,
 * and acting on a found session. The commands are harness-agnostic, so one
 * fake adapter covers every harness.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { registerSessionSearchCommands } from '../../src/commands/sessionSearch';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { HarnessAdapter, SessionSearchRunRequest } from '../../src/harnesses/types';
import { SessionSearchNode } from '../../src/providers/SessionSearchTreeProvider';
import { GitService } from '../../src/services/GitService';
import { SessionSearchService } from '../../src/services/SessionSearchService';
import { WorktreeCatalog } from '../../src/services/WorktreeCatalog';
import { ChatSession, SessionSearchMatch, SessionSearchRecord } from '../../src/types';
import { fakeAdapter, makeStorage, runCommand, sessionRecord, stub, tempDir, waitFor } from './support';

beforeEach(() => stub.__reset());

/** A plain-folder root `app`, a folder outside every root, and the commands over a fake harness. */
function setup(t: { after(fn: () => void): void }) {
  const scratch = tempDir(t);
  const root = path.join(scratch, 'app');
  const outside = path.join(scratch, 'elsewhere');
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  fs.mkdirSync(outside);

  const storage = makeStorage();
  storage.addRepository('app', root);
  const runs: SessionSearchRunRequest[] = [];
  const registry = new HarnessRegistry([
    fakeAdapter('claude', {
      sessionSearch: { instructions: () => 'Search the fake transcripts.', readableDirs: () => [scratch], verify: async () => null },
      sessionSearchRunner: {
        defaultModel: 'small',
        suggestedModels: ['small', 'large'],
        efforts: ['low', 'medium', 'high'],
        run: async (request) => {
          runs.push(request);
          return { reply: JSON.stringify({ answer: 'Nothing matched.', matches: [] }) };
        },
      },
    }),
  ]);
  const finder = new SessionSearchService(storage, registry, path.join(scratch, 'search'));
  const catalog = new WorktreeCatalog(storage, new GitService());
  const opened: ChatSession[] = [];
  const activated: ChatSession[] = [];
  vscode.commands.registerCommand('agntree.openChat', (item: { data: ChatSession }) => opened.push(item.data));
  registerSessionSearchCommands({ subscriptions: [] } as never, {
    sessionSearch: finder,
    storageService: storage,
    harnessRegistry: registry,
    worktreeCatalog: catalog,
    workspacesProvider: { getChatTreeItem: (chat) => ({ data: chat }) as never },
    activateChat: (chat) => activated.push(chat),
    refreshTree: () => undefined,
    isViewVisible: () => true,
  });
  return { root, outside, storage, catalog, runs, opened, activated };
}

function found(match: Partial<SessionSearchMatch> & Pick<SessionSearchMatch, 'sessionId' | 'cwd'>): SessionSearchNode {
  const full: SessionSearchMatch = { harness: 'claude', title: 'Usage mod', lastUpdated: 1, reason: 'Built it.', ...match };
  const search: SessionSearchRecord = {
    id: 'search-1',
    query: 'usage mod',
    engine: { harness: 'claude', model: 'small', effort: 'medium' },
    startedAt: 1,
    state: 'done',
    matches: [full],
    activity: [],
  };
  return { kind: 'match', search, match: full };
}

test('Find Session asks with the cheap default, and the gear changes the engine for the next question', async (t) => {
  const { runs } = setup(t);

  const finding = runCommand('agntree.findSession');
  const first = await waitFor(() => stub.__inputBoxes[0], 'the question box');
  assert.equal(first.title, 'Find Session — Claude Code · small · medium');

  stub.__quickPickResponses.push({ part: 'effort' }, { label: 'high' });
  first.value = 'the usage mod';
  first.__triggerButton();
  const second = await waitFor(() => stub.__inputBoxes[1], 'the question box again');
  assert.equal(second.title, 'Find Session — Claude Code · small · high');
  assert.equal(second.value, 'the usage mod', 'the question survives the detour');
  second.__accept('the usage mod');
  await finding;

  assert.deepEqual([runs[0].model, runs[0].effort], ['small', 'high']);
  assert.ok(runs[0].prompt.includes('"the usage mod"') && runs[0].prompt.includes('Search the fake transcripts.'));
});

test('Resume opens a found session in its Agntree row, importing it into the owning root only once', async (t) => {
  const { root, storage, catalog, opened, activated } = setup(t);
  const node = found({ sessionId: 's1', cwd: path.join(root, 'sub') });

  await runCommand('agntree.resumeSearchMatch', node);
  await runCommand('agntree.resumeSearchMatch', node);
  await runCommand('agntree.revealSearchMatch', node);

  const chats = storage.getChats();
  assert.equal(chats.length, 1);
  assert.deepEqual([chats[0].harnessSessionId, chats[0].worktreeId], ['s1', catalog.owner(root)?.id]);
  assert.deepEqual(opened.map((chat) => chat.id), [chats[0].id, chats[0].id]);
  assert.deepEqual(activated.map((chat) => chat.id), [chats[0].id]);
});

test('a found session outside every root resumes in a terminal at its folder, and its command copies with that folder', async (t) => {
  const { outside, storage } = setup(t);
  const node = found({ sessionId: 's2', cwd: outside });

  await runCommand('agntree.resumeSearchMatch', node);
  await runCommand('agntree.copySearchMatchCommand', node);

  const [terminal] = stub.window.terminals;
  assert.equal(terminal.options.cwd, outside);
  assert.deepEqual(terminal.sent, ['claude --resume s2']);
  assert.equal(await vscode.env.clipboard.readText(), `cd ${outside} && claude --resume s2`);
  assert.deepEqual(storage.getChats(), [], 'nothing is added to the tree');
});

/** The finder over a fake harness whose agent replies `answer` and whose record confirms with `verify`. */
function finderWith(
  t: { after(fn: () => void): void },
  answer: object,
  verify: NonNullable<HarnessAdapter['sessionSearch']>['verify']
) {
  const dir = tempDir(t);
  const storage = makeStorage();
  const registry = new HarnessRegistry([
    fakeAdapter('claude', {
      sessionSearch: { instructions: () => '', readableDirs: () => [dir], verify },
      sessionSearchRunner: {
        defaultModel: 'small',
        suggestedModels: ['small'],
        efforts: ['medium'],
        run: async () => ({ reply: JSON.stringify(answer) }),
      },
    }),
  ]);
  const finder = new SessionSearchService(storage, registry, dir);
  t.after(() => finder.dispose());
  return { dir, storage, finder };
}

const session = (cwd: string) => sessionRecord('claude', 'abc', { cwd, summary: 'Usage mod' });

test('Stop pressed while the found sessions are being checked cancels the search', async (t) => {
  let checking!: () => void;
  const checked = new Promise<void>((resolve) => (checking = resolve));
  let release!: () => void;
  const { dir, storage, finder } = finderWith(
    t,
    { answer: 'Found it.', matches: [{ harness: 'claude', sessionId: 'abc', quote: 'install', reason: 'Built it.' }] },
    async () => {
      checking();
      await new Promise<void>((resolve) => (release = resolve));
      return { session: session(dir) };
    }
  );

  const pending = finder.search('usage mod', finder.engine()!);
  await checked;
  finder.cancel();
  release();

  assert.equal((await pending).state, 'cancelled');
  assert.deepEqual(storage.getSessionSearches(), []);
});
