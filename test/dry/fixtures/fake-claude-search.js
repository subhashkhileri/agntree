#!/usr/bin/env node
/**
 * A stand-in for `claude --print --input-format stream-json` as the session
 * finder runs it. Each stream-json user message on stdin plays the next turn
 * of the scenario in the JSON file named by FAKE_CLAUDE_SEARCH, and every
 * message is recorded in `<scenario>.call.json`:
 * { args, prompts, cwd, pid, grandchildPid? }. Each start appends its pid to
 * `<scenario>.starts`.
 *
 * Scenario shape: { turns?: object[][], stderr?: string, exitCode?: number,
 *                   hang?: boolean, leftover?: boolean, grandchild?: boolean }
 * `grandchild` starts an idle process that shares the fake's output pipes, as
 * the ripgrep behind a Grep does.
 * The fake exits when its stdin closes, or right after the last turn when
 * `exitCode` is set; either way it writes `stderr` first. `leftover` writes a
 * tool result into the project directory Claude keeps for the cwd, as the
 * real CLI does even with --no-session-persistence.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const scenarioFile = process.env.FAKE_CLAUDE_SEARCH;
const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
const turns = scenario.turns ?? [];
const args = process.argv.slice(2);
const cwd = fs.realpathSync(process.cwd());
const prompts = [];
let grandchildPid;
fs.appendFileSync(`${scenarioFile}.starts`, `${process.pid}\n`);

const lines = readline.createInterface({ input: process.stdin });
// Exit by letting the event loop drain, so stdout written to a pipe is not cut off.
lines.on('close', () => {
  if (scenario.stderr) {
    process.stderr.write(scenario.stderr);
  }
  process.exitCode = scenario.exitCode ?? 0;
});
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type !== 'user' || message.message?.role !== 'user' || typeof message.message.content !== 'string') {
    throw new Error(`not a stream-json user message: ${line}`);
  }
  prompts.push(message.message.content);
  if (scenario.grandchild && prompts.length === 1) {
    grandchildPid = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
      stdio: ['ignore', 'inherit', 'inherit'],
    }).pid;
  }
  fs.writeFileSync(`${scenarioFile}.call.json`, JSON.stringify({ args, prompts, cwd, pid: process.pid, grandchildPid }));

  if (scenario.leftover && prompts.length === 1) {
    const projects = args[args.indexOf('--add-dir') + 1];
    const dir = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), 'tool-results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'toolu_1.txt'), 'large grep output');
  }
  if (scenario.hang) {
    setInterval(() => undefined, 1_000);
    return;
  }
  for (const event of turns[prompts.length - 1] ?? []) {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
  if (scenario.exitCode !== undefined && prompts.length >= turns.length) {
    lines.close();
    process.stdin.destroy();
  }
});
