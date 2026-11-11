#!/usr/bin/env node
/**
 * A stand-in for the `opencode` CLI. It answers the commands
 * OpencodeSessionService runs from a JSON state file named by
 * FAKE_OPENCODE_STATE, and appends each invocation to that file's `calls`.
 *
 * State shape: { sessions: OpencodeSessionInfo[], exports: { [id]: { messages } },
 *                failMove?: boolean, serviceDown?: boolean, calls: string[][] }
 */
const fs = require('fs');

const stateFile = process.env.FAKE_OPENCODE_STATE;
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
state.calls.push(args);
// A delayed call must be visible while it hangs, so the test can abort it.
if (state.listDelayMs || state.messageDelayMs) save();
process.on('SIGTERM', () => {
  state.terminated = (state.terminated ?? 0) + 1;
  save();
  process.exit(143);
});
const reply = (value) => {
  save();
  process.stdout.write(JSON.stringify(value));
};
const fail = (message) => {
  save();
  process.stderr.write(message);
  process.exit(1);
};
const later = (ms, action) => setTimeout(action, ms);

/** `--param key=value` pairs and the `--data` body of an `api` call. */
function apiRequest(rest) {
  const params = {};
  let data;
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === '--param') {
      const [key, ...value] = rest[i + 1].split('=');
      params[key] = value.join('=');
    } else if (rest[i] === '--data') {
      data = JSON.parse(rest[i + 1]);
    }
  }
  return { params, data };
}

if (args[0] === 'api') {
  const standalone = args[1] === '--standalone';
  const operation = standalone ? args[2] : args[1];
  const { params, data } = apiRequest(args.slice(standalone ? 3 : 2));
  if (state.serviceDown && !standalone) {
    fail('Error: connect ECONNREFUSED 127.0.0.1:4096');
  }
  const find = () => state.sessions.find((session) => session.id === params.sessionID);
  switch (operation) {
    case 'session.list': {
      let listed = state.sessions;
      if (params.parentID === 'null') {
        listed = listed.filter((session) => !session.parentID);
      }
      if (params.archived === 'false') {
        listed = listed.filter((session) => !session.time?.archived);
      }
      // Two pages, so the client must follow the cursor.
      const start = params.cursor ? Number(params.cursor) : 0;
      const page = listed.slice(start, start + 2);
      const next = start + 2 < listed.length ? String(start + 2) : undefined;
      later(state.listDelayMs ?? 0, () =>
        reply({ data: page, ...(next ? { cursor: { next } } : {}) })
      );
      break;
    }
    case 'session.message.list': {
      const messages = state.exports[params.sessionID]?.messages ?? [];
      const data = messages
        .map((message, index) => ({ message, index }))
        .filter(
          ({ message }) =>
            message.type === 'user' && typeof message.text === 'string'
        )
        .map(({ message, index }) => ({
          id: `user-message-${index}`,
          type: 'user',
          text: message.text,
          time: message.time ?? {},
        }));
      later(state.messageDelayMs ?? 0, () => reply({ data }));
      break;
    }
    case 'session.get':
      return find() ? reply({ data: find() }) : fail('session not found');
    case 'session.fork': {
      const source = find();
      if (!source) return fail('session not found');
      const fork = { ...source, id: `ses_fork${state.sessions.length}`, title: `${source.title} (fork)` };
      state.sessions.push(fork);
      return reply({ data: fork });
    }
    case 'session.move': {
      if (state.failMove) return fail('move failed');
      const session = find();
      session.location = { directory: data.directory };
      return reply({ data: session });
    }
    default:
      return fail(`unknown operation ${operation}`);
  }
} else if (args[0] === 'session' && args[1] === 'export') {
  const info = state.sessions.find((session) => session.id === args[2]);
  reply({ info, messages: state.exports[args[2]]?.messages ?? [] });
} else if (args[0] === 'session' && args[1] === 'delete') {
  state.sessions = state.sessions.filter((session) => session.id !== args[2]);
  reply({});
} else {
  fail(`unexpected arguments: ${args.join(' ')}`);
}
