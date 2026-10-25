#!/usr/bin/env node
/**
 * Stand-in for `claude` in the terminal-restore E2E test. It logs the launch
 * arguments to the path in AGNTREE_E2E_RUNS and stays alive so the terminal
 * keeps a running harness, without touching a model, network, or credentials.
 */
const fs = require('fs');

const args = process.argv.slice(2);

// Install detection may ask the configured command for its version.
if (args.includes('--version')) {
  console.log('2.1.310 (Claude Code)');
  process.exit(0);
}

const runsFlag = args.indexOf('--e2e-runs');
const runsPath =
  runsFlag >= 0 && args[runsFlag + 1]
    ? args[runsFlag + 1]
    : process.env.AGNTREE_E2E_RUNS;
const isLaunch =
  args.includes('--session-id') ||
  args.includes('--resume') ||
  args.includes('--fork-session');

if (isLaunch && runsPath) {
  fs.appendFileSync(
    runsPath,
    `${JSON.stringify({
      at: Date.now(),
      pid: process.pid,
      cwd: process.cwd(),
      args,
    })}\n`
  );
}

console.log('FAKE CLAUDE SESSION READY');
setTimeout(() => undefined, 300000);
