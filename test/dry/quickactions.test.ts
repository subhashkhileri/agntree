import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { HarnessRegistry } from '../../src/harnesses/HarnessRegistry';
import { ClaudeHarness } from '../../src/harnesses/ClaudeHarness';
import { OpencodeHarness } from '../../src/harnesses/OpencodeHarness';
import { QuickActionsTreeProvider } from '../../src/providers/QuickActionsTreeProvider';
import { registerQuickActionCommands } from '../../src/commands/quickActions';

const WORK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-quickactions-'));
const FAKE_CLAUDE = path.join(WORK_ROOT, 'fake-claude.sh');
const FAKE_OPENCODE = path.join(WORK_ROOT, 'fake-opencode.sh');
const CLAUDE_ARGS = path.join(WORK_ROOT, 'claude.args');
const OPENCODE_ARGS = path.join(WORK_ROOT, 'opencode.args');
const COMMAND_OUTPUT = path.join(WORK_ROOT, 'command.args');

let failures = 0;
function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`PASS  ${message}`);
  } else {
    failures++;
    console.error(`FAIL  ${message}`);
  }
}

function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(filePath)) {
        clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 100);
  });
}

function writeFakeScript(filePath: string, argsFile: string): void {
  fs.writeFileSync(
    filePath,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nexit 0\n`
  );
  fs.chmodSync(filePath, 0o755);
}

async function main(): Promise<void> {
  writeFakeScript(FAKE_CLAUDE, CLAUDE_ARGS);
  writeFakeScript(FAKE_OPENCODE, OPENCODE_ARGS);

  process.env.AGNTREE_FAKE_CLAUDE = FAKE_CLAUDE;
  process.env.AGNTREE_FAKE_OPENCODE = FAKE_OPENCODE;
  process.env.AGNTREE_TEST_COMMAND_OUTPUT = COMMAND_OUTPUT;

  const context = { subscriptions: [] as { dispose(): void }[] };
  const changesProvider = { refresh: () => undefined };
  const registry = new HarnessRegistry([new ClaudeHarness(), new OpencodeHarness()]);
  const quickProvider = new QuickActionsTreeProvider(registry);

  registerQuickActionCommands(
    context as any,
    changesProvider as any,
    quickProvider as any,
    registry
  );

  const commands = (vscode as any).commands;

  console.log('\n== opencode quick action ==');
  await commands.executeCommand('agntree.runQuickActionByIndex', 0, WORK_ROOT);
  const opencodeRan = await waitForFile(OPENCODE_ARGS, 5000);
  check(opencodeRan, 'opencode action spawned the configured harness command');
  if (opencodeRan) {
    const args = fs.readFileSync(OPENCODE_ARGS, 'utf8').trim().split('\n');
    check(
      args.join(' ') ===
        'run say ok --auto --agent build --model enmaas/rits/model#high --title Opencode Dry',
      `opencode args: ${args.join(' ')}`
    );
  }

  console.log('\n== claude quick action ==');
  await commands.executeCommand('agntree.runQuickActionByIndex', 1, WORK_ROOT);
  const claudeRan = await waitForFile(CLAUDE_ARGS, 5000);
  check(claudeRan, 'claude action spawned the configured harness command');
  if (claudeRan) {
    const args = fs.readFileSync(CLAUDE_ARGS, 'utf8').trim().split('\n');
    check(args.join(' ') === '-p say ok --allowedTools Read', `claude args: ${args.join(' ')}`);
  }

  console.log('\n== command quick action ==');
  await commands.executeCommand('agntree.runQuickActionByIndex', 2, WORK_ROOT);
  const commandRan = await waitForFile(COMMAND_OUTPUT, 5000);
  check(commandRan, 'command action ran through the shell');
  if (commandRan) {
    check(
      fs.readFileSync(COMMAND_OUTPUT, 'utf8') === 'ok',
      'command action produced the expected output'
    );
  }

  console.log('\n== misconfiguration ==');
  const messagesBefore = (vscode as any).__messages.length;
  await commands.executeCommand('agntree.runQuickActionByIndex', 3, WORK_ROOT);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const newMessages = (vscode as any).__messages.slice(messagesBefore);
  check(
    newMessages.some(
      (args: unknown[]) =>
        typeof args[0] === 'string' && args[0].includes('requires "allowedTools"')
    ),
    'missing allowedTools produces a clear error'
  );

  console.log('\n== output channel ==');
  const channel = (vscode as any).__outputChannels.find(
    (candidate: { name: string }) => candidate.name === 'Agntree Quick Actions'
  );
  check(Boolean(channel), 'quick actions output channel was created');
  const log = channel ? channel.lines.join('\n') : '';
  check(
    log.includes(`$ ${FAKE_OPENCODE} run "say ok" --auto --agent build`),
    'opencode command line is logged'
  );
  check(
    log.includes(`$ ${FAKE_CLAUDE} -p "say ok" --allowedTools Read`),
    'claude command line is logged'
  );
  check(log.includes('$ node -e'), 'command action line is logged');

  quickProvider.dispose();
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  console.log(
    `\n${failures === 0 ? 'ALL QUICK ACTION CHECKS PASSED' : `${failures} FAILURE(S)`}`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('UNEXPECTED FAILURE', error);
  fs.rmSync(WORK_ROOT, { recursive: true, force: true });
  process.exit(1);
});
