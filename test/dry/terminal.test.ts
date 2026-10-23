import * as vscode from 'vscode';
import { TerminalManager } from '../../src/services/TerminalManager';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { OpencodeHarness } from '../../src/harnesses/OpencodeHarness';
import { ClaudeSessionService } from '../../src/services/ClaudeSessionService';
import { OpencodeSessionService } from '../../src/services/OpencodeSessionService';

const REPO = process.env.AGNTREE_TEST_CLAUDE_REPO || process.cwd();
const OPENCODE_CWD =
  process.env.AGNTREE_TEST_OPENCODE_WORKTREE || process.cwd();

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

async function main(): Promise<void> {
  const chats = new Map<string, any>();
  let nextId = 0;

  function addChat(partial: Record<string, unknown>): any {
    const id = `chat-${String(++nextId).padStart(3, '0')}`;
    const chat = {
      id,
      worktreeId: 'wt-1',
      name: `Session ${nextId}`,
      harness: 'claude',
      harnessSessionId: null,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      status: 'idle',
      baseCommit: null,
      ...partial,
    };
    chats.set(id, chat);
    return chat;
  }

  const storage = {
    getChat: (id: string) => chats.get(id),
    getChats: () => Array.from(chats.values()),
    updateChat: (id: string, updates: Record<string, unknown>) => {
      const chat = chats.get(id);
      if (chat) Object.assign(chat, updates);
      return chat;
    },
    deleteChat: (id: string) => chats.delete(id),
    touchChat: (id: string) => {
      const chat = chats.get(id);
      if (chat) chat.lastAccessedAt = Date.now();
    },
  };

  const registry = new HarnessRegistry([new ClaudeHarness(), new OpencodeHarness()]);
  const manager = new TerminalManager(storage as any, registry);

  await (vscode as any).commands.registerCommand(
    'agntree.refreshWorkspaces',
    () => undefined
  );

  const claudeSessions = await new ClaudeSessionService().findSessionsForWorktree(REPO);
  const claudeSession = claudeSessions.find(
    (candidate) => candidate.messageCount > 0
  )?.sessionId;

  const opencodeSessions = await new OpencodeSessionService().listSessions(
    OPENCODE_CWD,
    { force: true }
  );
  const opencodeSession = opencodeSessions[0]?.id;
  const opencodeWorktree =
    opencodeSessions[0]?.location.directory ?? OPENCODE_CWD;

  if (!claudeSession) {
    console.log(
      'SKIP  no Claude session found; set AGNTREE_TEST_CLAUDE_REPO to exercise resume/fork'
    );
  }
  if (!opencodeSession) {
    console.log(
      'SKIP  no opencode session found; set AGNTREE_TEST_OPENCODE_WORKTREE to exercise resume'
    );
  }

  console.log('\n== Claude launch commands ==');
  const claudeNew = addChat({ harness: 'claude', name: 'Claude New' });
  const claudeNewTerminal = await manager.openChat(claudeNew, { path: REPO } as any);
  check(claudeNewTerminal.sent[0] === 'claude', 'new Claude chat sends "claude"');
  check(claudeNewTerminal.options.cwd === REPO, 'terminal cwd is the worktree');
  check(
    claudeNewTerminal.options.iconPath.id === 'sparkle',
    'Claude terminal uses the sparkle icon'
  );
  check(claudeNew.status === 'active', 'opened chat is marked active');

  if (claudeSession) {
    const claudeResume = addChat({
      harness: 'claude',
      name: 'Claude Resume',
      harnessSessionId: claudeSession,
    });
    const resumeTerminal = await manager.openChat(claudeResume, { path: REPO } as any);
    check(
      resumeTerminal.sent[0] === `claude --resume ${claudeSession}`,
      'Claude resume sends --resume'
    );

    const claudeFork = addChat({
      harness: 'claude',
      name: 'Claude Fork',
      harnessSessionId: claudeSession,
    });
    const forkTerminal = await manager.openChat(
      claudeFork,
      { path: REPO } as any,
      claudeSession
    );
    check(
      forkTerminal.sent[0] === `claude --resume ${claudeSession} --fork-session`,
      'Claude fork sends --fork-session'
    );
    check(!forkTerminal.disposed, 'fork terminal stays open');
  }

  console.log('\n== missing session ==');
  const missing = addChat({
    harness: 'claude',
    name: 'Missing',
    harnessSessionId: '00000000-0000-0000-0000-000000000000',
  });
  const messagesBefore = (vscode as any).__messages.length;
  const missingTerminal = await manager.openChat(missing, { path: REPO } as any);
  check(missingTerminal === undefined, 'missing session does not open a terminal');
  check(!manager.isActive(missing.id), 'missing session does not stay active');
  const missingMessages = (vscode as any).__messages.slice(messagesBefore);
  check(
    missingMessages.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' &&
        args[0].includes('Session not found or has no conversation in Claude Code')
    ),
    'missing-session warning names the harness'
  );

  console.log('\n== opencode launch commands ==');
  const opencodeNew = addChat({ harness: 'opencode', name: 'Opencode New' });
  const opencodeNewTerminal = await manager.openChat(opencodeNew, {
    path: opencodeWorktree,
  } as any);
  check(opencodeNewTerminal.sent[0] === 'opencode', 'new opencode chat sends "opencode"');
  check(
    opencodeNewTerminal.options.iconPath.id === 'code',
    'opencode terminal uses the code icon'
  );

  if (opencodeSession) {
    const opencodeResume = addChat({
      harness: 'opencode',
      name: 'Opencode Resume',
      harnessSessionId: opencodeSession,
    });
    const opencodeResumeTerminal = await manager.openChat(opencodeResume, {
      path: opencodeWorktree,
    } as any);
    check(
      opencodeResumeTerminal.sent[0] === `opencode --session ${opencodeSession}`,
      'opencode resume sends --session'
    );
  }

  const opencodeMissing = addChat({
    harness: 'opencode',
    name: 'Opencode Missing',
    harnessSessionId: 'ses_doesnotexist',
  });
  const opencodeMissingMessages = (vscode as any).__messages.length;
  const opencodeMissingTerminal = await manager.openChat(opencodeMissing, {
    path: opencodeWorktree,
  } as any);
  check(
    opencodeMissingTerminal === undefined,
    'missing opencode session does not open a terminal'
  );
  check(
    (vscode as any).__messages
      .slice(opencodeMissingMessages)
      .some(
        (args: unknown[]) =>
          typeof args[0] === 'string' &&
          args[0].includes('Session not found or has no conversation in opencode')
      ),
    'missing opencode warning names the harness'
  );

  console.log('\n== terminal reuse + close semantics ==');
  const terminalCount = (vscode as any).window.terminals.length;
  const sameTerminal = await manager.openChat(claudeNew, { path: REPO } as any);
  check(sameTerminal === claudeNewTerminal, 'reopening a chat reuses its terminal');
  check(
    (vscode as any).window.terminals.length === terminalCount,
    'no extra terminal was created'
  );

  const closeNoSession = addChat({ harness: 'opencode', name: 'Close New' });
  await manager.openChat(closeNoSession, { path: opencodeWorktree } as any);
  const closeNoSessionTerminal = manager.getTerminal(closeNoSession.id);
  const terminals = (vscode as any).window.terminals;
  terminals.splice(terminals.indexOf(closeNoSessionTerminal), 1);
  (vscode as any).window.__fireDidCloseTerminal(closeNoSessionTerminal);
  check(!storage.getChat(closeNoSession.id), 'closing an unlinked session deletes the chat');

  if (claudeSession) {
    const closeWithSession = addChat({
      harness: 'claude',
      name: 'Close Existing',
      harnessSessionId: claudeSession,
    });
    await manager.openChat(closeWithSession, { path: REPO } as any);
    const closeWithSessionTerminal = manager.getTerminal(closeWithSession.id);
    terminals.splice(terminals.indexOf(closeWithSessionTerminal), 1);
    (vscode as any).window.__fireDidCloseTerminal(closeWithSessionTerminal);
    check(
      storage.getChat(closeWithSession.id)?.status === 'closed',
      'closing a linked session marks the chat closed'
    );
  }

  console.log('\n== sync after extension restart ==');
  const synced = addChat({
    harness: 'claude',
    name: 'Synced',
    harnessSessionId: claudeSession ?? 'unused',
    status: 'active',
  });
  chats.delete(synced.id);
  synced.id = 'abcdef00-1111-2222-3333-444455556666';
  chats.set(synced.id, synced);

  const restoredTerminal = {
    name: 'Agntree: Synced [abcdef]',
    sent: [],
    show: () => undefined,
    dispose: () => undefined,
  };
  (vscode as any).window.terminals.push(restoredTerminal);

  const secondManager = new TerminalManager(storage as any, registry);
  secondManager.syncWithExistingTerminals();
  check(
    secondManager.isActive(synced.id),
    'existing terminal is re-associated by chat short id'
  );
  check(
    storage.getChat(synced.id)?.status === 'active',
    're-associated chat is marked active'
  );

  manager.dispose();
  secondManager.dispose();
  console.log(
    `\n${failures === 0 ? 'ALL TERMINAL MANAGER CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  process.exit(1);
});
