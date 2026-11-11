#!/usr/bin/env node
/**
 * A stand-in for `pi --print --mode json` used by the Find Session runner.
 * It records each invocation in FAKE_PI_STATE and plays one reply per call
 * from that state's `replies`, so a test can prove the first turn and the
 * follow-up reached the same session without a real model or Pi install.
 */
const fs = require('fs');

const stateFile = process.env.FAKE_PI_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
// The runner sends the prompt on stdin, as it must for a multi-line question.
const prompt = fs.readFileSync(0, 'utf8');
state.calls = state.calls ?? [];
state.calls.push({ args, prompt });
fs.writeFileSync(stateFile, JSON.stringify(state));

const index = state.calls.length - 1;
const reply = state.replies?.[index] ?? state.replies?.[state.replies.length - 1] ?? '{}';

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

send({
  type: 'session',
  version: 3,
  id: 'fake-pi-search',
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
});
send({
  type: 'tool_execution_start',
  toolCallId: 'call-1',
  toolName: 'grep',
  args: { pattern: 'banana', path: '/records' },
});
send({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'I will search the records.' }],
    stopReason: 'toolUse',
  },
});
send({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
    stopReason: 'stop',
  },
});
send({
  type: 'turn_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: reply }],
    stopReason: 'stop',
    usage: { cost: { total: 0.002 } },
  },
});
send({ type: 'agent_settled', aborted: false });
