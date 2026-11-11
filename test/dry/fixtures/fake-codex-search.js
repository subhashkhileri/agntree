#!/usr/bin/env node
/**
 * A stand-in for `codex exec` and `codex exec resume` used by the Find
 * Session runner. It records each invocation in FAKE_CODEX_STATE and plays
 * one reply per call from that state's `replies`. The session ID it reports
 * is stable, so a test can prove the correction resumed the first thread.
 */
const fs = require('fs');
const path = require('path');

const stateFile = process.env.FAKE_CODEX_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
// The runner sends the prompt on stdin, as it must for a multi-line question.
const prompt = fs.readFileSync(0, 'utf8');
state.calls = state.calls ?? [];
state.calls.push({ args, prompt });
const home = process.env.CODEX_HOME;
state.homes = state.homes ?? [];
state.homes.push({
  home,
  auth: home ? fs.existsSync(path.join(home, 'auth.json')) : false,
});
fs.writeFileSync(stateFile, JSON.stringify(state));

const index = state.calls.length - 1;
const reply = state.replies?.[index] ?? state.replies?.[state.replies.length - 1] ?? '{}';
const threadId = state.threadId ?? 'thread-search-1';

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

send({ type: 'thread.started', thread_id: threadId });
send({ type: 'turn.started' });
send({
  type: 'item.started',
  item: { id: 'cmd-1', type: 'command_execution', command: 'rg banana' },
});
send({
  type: 'item.completed',
  item: { id: 'cmd-1', type: 'command_execution', command: 'rg banana' },
});
send({
  type: 'item.completed',
  item: { id: 'msg-1', type: 'agent_message', text: reply },
});
send({
  type: 'turn.completed',
  usage: { input_tokens: 10, output_tokens: 2 },
});
