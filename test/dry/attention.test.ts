import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NEEDS_INPUT_COOLDOWN_MS,
  SessionAttentionService,
  shouldNotifyNeedsInput,
} from '../../src/services/SessionAttentionService';
import { escapeAppleScript, NotificationService } from '../../src/services/NotificationService';
import { HarnessAdapter, HarnessLiveState } from '../../src/harnesses/types';
import { ChatSession } from '../../src/types';
import { chatRecord, fakeAdapter, sessionRecord, stub, worktreeRecord } from './support';

beforeEach(() => stub.__reset());

/** An attention service over one chat whose adapter the test drives. */
function attention(chat: ChatSession, adapter: HarnessAdapter, options: { terminalOpen?: boolean; isChatOpen?: (chat: ChatSession) => boolean; isChatVisible?: () => boolean } = {}) {
  const notified: string[] = [];
  const service = new SessionAttentionService(
    { getChats: () => [chat], getRepository: () => ({ name: 'repo' }) } as never,
    { get: () => adapter } as never,
    { notify: (kind: string, target: { detail?: string }) => notified.push(target.detail ? `${kind}:${target.detail}` : kind) } as never,
    () => worktreeRecord(),
    () => undefined,
    options.isChatOpen ?? (() => options.terminalOpen ?? true),
    options.isChatVisible
  );
  return { service, notified };
}

const linkedChat = (overrides: Partial<ChatSession> = {}) =>
  chatRecord({ harnessSessionId: 'session-1', status: 'active', ...overrides });

test('a new or changed waiting reason notifies at once; a repeat waits out the cooldown', () => {
  assert.ok(shouldNotifyNeedsInput(undefined, 'permission prompt', undefined, 0));
  assert.ok(!shouldNotifyNeedsInput('permission prompt', 'permission prompt', 0, 1));
  assert.ok(shouldNotifyNeedsInput('permission prompt', 'permission prompt', 0, NEEDS_INPUT_COOLDOWN_MS));
  assert.ok(shouldNotifyNeedsInput('permission prompt', 'idle question', 0, 1));
});

test('each finished turn and each wait notifies once; startup state never does', async () => {
  let live: HarnessLiveState = { turnState: 'done', turnEndedAt: 500, waitingFor: 'permission prompt' };
  const adapter = fakeAdapter('claude', { getLiveStates: async () => new Map([['session-1', live]]) });
  const { service, notified } = attention(linkedChat(), adapter);
  const step = async (next: HarnessLiveState) => {
    live = next;
    await service.poll();
  };

  await service.poll(true);
  await service.poll();
  assert.deepEqual(notified, [], 'a session already waiting at startup is primed silently');

  await step({ turnState: 'working', turnEndedAt: null });
  await step({ turnState: 'done', turnEndedAt: 1000 });
  await step({ turnState: 'done', turnEndedAt: 1000 });
  assert.deepEqual(notified, ['finished'], 'one turn end, one notification');

  await step({ turnState: 'done', turnEndedAt: 1000, waitingFor: 'permission prompt' });
  await step({ turnState: 'done', turnEndedAt: 2000, waitingFor: 'permission prompt' });
  await step({ turnState: 'done', turnEndedAt: 2000 });
  assert.deepEqual(notified, ['finished', 'needs-input:permission prompt'], 'a turn end at a wait is not announced twice');

  await step({ turnState: 'done', turnEndedAt: 3000 });
  await step({ turnState: 'done', turnEndedAt: 3000, waitingFor: 'permission prompt' });
  await step({ turnState: 'working', turnEndedAt: null });
  assert.deepEqual(notified, ['finished', 'needs-input:permission prompt', 'finished', 'needs-input:permission prompt']);
  assert.equal(service.getTurnState('chat-1'), 'working', 'the tree reads the latest state');
});

test('a session needs you from an unseen turn end or wait until you visit it, it works again, or it closes', async () => {
  let live: HarnessLiveState = { turnState: 'done', turnEndedAt: 500 };
  let visible = false;
  let open = true;
  const adapter = fakeAdapter('claude', { getLiveStates: async () => new Map([['session-1', live]]) });
  const { service } = attention(linkedChat(), adapter, { isChatOpen: () => open, isChatVisible: () => visible });
  const step = async (next: HarnessLiveState) => {
    live = next;
    await service.poll();
  };

  await service.poll(true);
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a turn that ended before startup is not news');

  await step({ turnState: 'working', turnEndedAt: null });
  await step({ turnState: 'done', turnEndedAt: 1000 });
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1']);
  service.markSeen('chat-1');
  assert.deepEqual(service.sessionsNeedingYou(), [], 'visiting clears it');

  await step({ turnState: 'working', turnEndedAt: null, waitingFor: 'permission prompt' });
  assert.deepEqual(service.sessionsNeedingYou(), ['chat-1'], 'a wait mid-turn needs you too');
  await step({ turnState: 'working', turnEndedAt: null });
  assert.deepEqual(service.sessionsNeedingYou(), [], 'answered: the agent is working again');

  visible = true;
  await step({ turnState: 'done', turnEndedAt: 2000 });
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a turn that ends in front of you is already seen');

  visible = false;
  await step({ turnState: 'working', turnEndedAt: null });
  await step({ turnState: 'done', turnEndedAt: 3000 });
  open = false;
  await service.poll();
  assert.deepEqual(service.sessionsNeedingYou(), [], 'a closed session is forgotten');
});

test('a harness without live states is polled through discovery', async () => {
  let turnState: 'working' | 'done' = 'working';
  const adapter = fakeAdapter('opencode', {
    listSessionsForWorktree: async () => [
      sessionRecord('opencode', 'session-1', { cwd: worktreeRecord().path, turnState, turnEndedAt: turnState === 'done' ? 1000 : null }),
    ],
  });
  const { service, notified } = attention(linkedChat({ harness: 'opencode' }), adapter);
  await service.poll(true);
  turnState = 'done';
  await service.poll();
  assert.deepEqual(notified, ['finished']);
});

test('a chat open only in its native UI is still polled', async () => {
  const chat = linkedChat({ status: 'closed' });
  const adapter = fakeAdapter('claude', {
    getLiveStates: async () => new Map([['session-1', { turnState: 'done' as const, turnEndedAt: 1000 }]]),
  });
  const { service } = attention(chat, adapter, { terminalOpen: false, isChatOpen: (entry) => entry.id === chat.id });
  await service.poll(true);
  assert.equal(service.getTurnState(chat.id), 'done');
});

test('a notification is suppressed while its session has focus; AppleScript text is escaped', () => {
  stub.__setConfiguration('notifications.nativeBanner', false);
  const state = (stub.window as unknown as { state: { focused: boolean } });
  const notifications = new NotificationService(() => undefined, () => true);
  const target = { chat: linkedChat(), context: 'repo · main', detail: 'permission prompt' };

  state.state = { focused: true };
  notifications.notify('needs-input', target);
  assert.equal(stub.__messages.length, 0);
  state.state = { focused: false };
  notifications.notify('needs-input', target);
  assert.equal(stub.__messages.length, 1);

  assert.equal(escapeAppleScript('He said "hi"\nbye'), 'He said \\"hi\\" bye');
});
