import * as vscode from 'vscode';
import { deriveTurnState } from '../../src/services/OpencodeSessionService';
import {
  NEEDS_INPUT_COOLDOWN_MS,
  SessionAttentionService,
  shouldNotifyNeedsInput,
} from '../../src/services/SessionAttentionService';
import { escapeAppleScript, NotificationService } from '../../src/services/NotificationService';

let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* opencode turn state                                                 */
/* ------------------------------------------------------------------ */

function testOpencodeTurnState(): void {
  check(
    deriveTurnState({ created: 1, updated: 10, idle: 10 }).turnState === 'done',
    'opencode idle session is done'
  );
  check(
    deriveTurnState({ created: 1, updated: 20, idle: 10 }).turnState === 'working',
    'opencode session updated after idle is working'
  );
  check(
    deriveTurnState({ created: 1, updated: 20 }).turnState === 'working',
    'opencode session without idle is working'
  );
}

/* ------------------------------------------------------------------ */
/* Needs-you decisions and transitions                                 */
/* ------------------------------------------------------------------ */

function testNeedsInputDecision(): void {
  check(
    shouldNotifyNeedsInput(undefined, 'permission prompt', undefined, 0),
    'a new waiting reason notifies'
  );
  check(
    !shouldNotifyNeedsInput('permission prompt', 'permission prompt', 0, 1),
    'a repeated reason inside the cooldown stays quiet'
  );
  check(
    shouldNotifyNeedsInput(
      'permission prompt',
      'permission prompt',
      0,
      NEEDS_INPUT_COOLDOWN_MS
    ),
    'a repeated reason re-notifies after the cooldown'
  );
  check(
    shouldNotifyNeedsInput('permission prompt', 'idle question', 0, 1),
    'a changed reason notifies immediately'
  );
}

async function testAttentionTransitions(): Promise<void> {
  const chat = {
    id: 'chat-1',
    worktreeId: 'wt-1',
    name: 'Session one',
    harness: 'claude' as const,
    harnessSessionId: 'session-1',
    createdAt: 1,
    lastAccessedAt: 1,
    status: 'active' as const,
    baseCommit: null,
  };

  let live: {
    turnState: 'working' | 'done';
    turnEndedAt: number | null;
    waitingFor?: string;
  } = { turnState: 'working', turnEndedAt: null };

  const calls: { kind: string; detail?: string }[] = [];
  const adapter = {
    id: 'claude',
    displayName: 'Claude Code',
    capabilities: {
      fork: true,
      move: false,
      newSessionId: true,
      preview: 'inline',
    },
    getLiveStates: async () =>
      new Map<string, typeof live>([['session-1', live]]),
  };
  const storage = {
    getChats: () => [chat],
    getRepository: () => ({ name: 'repo' }),
  };
  const terminalManager = { isActive: () => true };
  const registry = { get: () => adapter };
  const notifications = {
    notify: (kind: string, target: { detail?: string }) => {
      calls.push({ kind, detail: target.detail });
    },
  };
  const getWorktree = () => ({
    id: 'wt-1',
    repoId: 'repo-1',
    name: 'main',
    path: '/tmp/worktree',
    isMain: true,
  });

  const service = new SessionAttentionService(
    storage as any,
    terminalManager as any,
    registry as any,
    notifications as any,
    getWorktree as any
  );

  await service.poll(true);
  check(calls.length === 0, 'priming a working session is silent');

  live = { turnState: 'done', turnEndedAt: 1000 };
  await service.poll();
  check(
    calls.length === 1 && calls[0]?.kind === 'finished',
    'a finished turn notifies'
  );

  await service.poll();
  check(calls.length === 1, 'the same turn end does not notify twice');

  live = { turnState: 'done', turnEndedAt: 1000, waitingFor: 'permission prompt' };
  await service.poll();
  check(
    calls.length === 2 &&
      calls[1]?.kind === 'needs-input' &&
      calls[1]?.detail === 'permission prompt',
    'a waiting reason notifies with the raw detail'
  );

  live = { turnState: 'done', turnEndedAt: 2000, waitingFor: 'permission prompt' };
  await service.poll();
  check(
    calls.length === 2,
    'a turn end at the same prompt is suppressed until the reason changes'
  );

  live = { turnState: 'done', turnEndedAt: 2000 };
  await service.poll();
  check(calls.length === 2, 'clearing the wait does not replay the skipped turn end');

  live = { turnState: 'done', turnEndedAt: 3000 };
  await service.poll();
  check(
    calls.length === 3 && calls[2]?.kind === 'finished',
    'turn-end notifications resume after the wait clears'
  );

  live = { turnState: 'done', turnEndedAt: 3000, waitingFor: 'permission prompt' };
  await service.poll();
  check(
    calls.length === 4 && calls[3]?.kind === 'needs-input',
    'the next wait notifies again after being cleared'
  );

  live = { turnState: 'working', turnEndedAt: null };
  await service.poll();
  check(
    service.getTurnState('chat-1') === 'working',
    'the tree sees the latest turn state'
  );
  check(calls.length === 4, 'starting a new turn is silent');
}

async function testPrimeWaitingIsSilent(): Promise<void> {
  const chat = {
    id: 'chat-prime',
    worktreeId: 'wt-prime',
    name: 'Session prime',
    harness: 'claude' as const,
    harnessSessionId: 'session-prime',
    createdAt: 1,
    lastAccessedAt: 1,
    status: 'active' as const,
    baseCommit: null,
  };

  const live = {
    turnState: 'done' as const,
    turnEndedAt: 1000,
    waitingFor: 'permission prompt',
  };
  const calls: string[] = [];
  const service = new SessionAttentionService(
    {
      getChats: () => [chat],
      getRepository: () => ({ name: 'repo' }),
    } as any,
    { isActive: () => true } as any,
    {
      get: () => ({
        id: 'claude',
        displayName: 'Claude Code',
        capabilities: {
          fork: true,
          move: false,
          newSessionId: true,
          preview: 'inline',
        },
        getLiveStates: async () => new Map([['session-prime', live]]),
      }),
    } as any,
    { notify: (kind: string) => calls.push(kind) } as any,
    () => ({
      id: 'wt-prime',
      repoId: 'repo-1',
      name: 'main',
      path: '/tmp/worktree',
      isMain: true,
    })
  );

  await service.poll(true);
  check(calls.length === 0, 'a waiting session at startup does not notify');
  await service.poll();
  check(calls.length === 0, 'the primed wait stays quiet on the next tick');
}

function testNotificationFocus(): void {
  const state = (vscode as any).window.state;
  const chat = {
    id: 'chat-1',
    worktreeId: 'wt-1',
    name: 'Session one',
    harness: 'claude' as const,
    harnessSessionId: 'session-1',
    createdAt: 1,
    lastAccessedAt: 1,
    status: 'active' as const,
    baseCommit: null,
  };

  (vscode as any).__setConfiguration('notifications.nativeBanner', false);
  try {
    const notifications = new NotificationService(
      () => undefined,
      () => true
    );

    (vscode as any).window.state = { focused: true };
    const before = (vscode as any).__messages.length;
    notifications.notify('needs-input', {
      chat,
      context: 'repo · main',
      detail: 'permission prompt',
    });
    check(
      (vscode as any).__messages.length === before,
      'a focused terminal suppresses the notification'
    );

    (vscode as any).window.state = { focused: false };
    notifications.notify('needs-input', {
      chat,
      context: 'repo · main',
      detail: 'permission prompt',
    });
    check(
      (vscode as any).__messages.length === before + 1,
      'an unfocused terminal shows the notification'
    );
  } finally {
    (vscode as any).window.state = state;
    (vscode as any).__setConfiguration('notifications.nativeBanner', undefined);
  }

  check(
    escapeAppleScript('He said "hi"') === 'He said \\"hi\\"',
    'AppleScript text escapes quotes'
  );
  check(
    escapeAppleScript('one\ntwo') === 'one two',
    'AppleScript text flattens newlines'
  );
}

async function testAttentionFallback(): Promise<void> {
  const chat = {
    id: 'chat-2',
    worktreeId: 'wt-2',
    name: 'Session two',
    harness: 'opencode' as const,
    harnessSessionId: 'ses_1',
    createdAt: 1,
    lastAccessedAt: 1,
    status: 'active' as const,
    baseCommit: null,
  };

  let turnState: 'working' | 'done' = 'working';
  const calls: string[] = [];
  const adapter = {
    id: 'opencode',
    displayName: 'opencode',
    capabilities: {
      fork: true,
      move: true,
      newSessionId: false,
      preview: 'lazy',
    },
    listSessionsForWorktree: async () => [
      {
        harness: 'opencode' as const,
        sessionId: 'ses_1',
        cwd: '/tmp/worktree',
        summary: 'Session two',
        gitBranch: null,
        lastUpdated: null,
        lastActivity: null,
        messageCount: 0,
        turnState,
        turnEndedAt: turnState === 'done' ? 1000 : null,
      },
    ],
  };

  const service = new SessionAttentionService(
    {
      getChats: () => [chat],
      getRepository: () => ({ name: 'repo' }),
    } as any,
    { isActive: () => true } as any,
    { get: () => adapter } as any,
    {
      notify: (kind: string) => {
        calls.push(kind);
      },
    } as any,
    () => ({
      id: 'wt-2',
      repoId: 'repo-1',
      name: 'main',
      path: '/tmp/worktree',
      isMain: true,
    })
  );

  await service.poll(true);
  check(calls.length === 0, 'priming a discovery-only harness is silent');

  turnState = 'done';
  await service.poll();
  check(
    calls.length === 1 && calls[0] === 'finished',
    'a discovery-only harness still notifies on turn end'
  );
}

async function main(): Promise<void> {
  console.log('\n== opencode turn state ==');
  testOpencodeTurnState();

  console.log('\n== needs-you decisions ==');
  testNeedsInputDecision();

  console.log('\n== attention transitions ==');
  await testAttentionTransitions();

  console.log('\n== priming a waiting session ==');
  await testPrimeWaitingIsSilent();

  console.log('\n== attention fallback ==');
  await testAttentionFallback();

  console.log('\n== notification focus ==');
  testNotificationFocus();

  console.log(`\n${failures === 0 ? 'ALL ATTENTION CHECKS PASSED' : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
