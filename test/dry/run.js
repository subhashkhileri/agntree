#!/usr/bin/env node
/**
 * Dry-test runner.
 *
 * Bundles every `*.test.ts` under test/dry with esbuild, aliases the `vscode`
 * module to a stub, and runs the result under plain Node. No extension install
 * and no extension host required.
 *
 * Usage:
 *   npm run test:dry             # run everything
 *   npm run test:dry -- claude   # run files whose name contains "claude"
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');

const TEST_DIR = __dirname;
const BUILD_DIR = path.join(TEST_DIR, '.build');
const DEFAULT_STUB = path.join(TEST_DIR, 'vscode-stub.js');
const TIMEOUT_MS = Number(process.env.AGNTREE_TEST_TIMEOUT_MS || 180_000);

const filter = process.argv[2];
const testFiles = fs
  .readdirSync(TEST_DIR)
  .filter((file) => file.endsWith('.test.ts'))
  .filter((file) => !filter || file.includes(filter))
  .sort();

if (testFiles.length === 0) {
  console.error(`No dry tests matched${filter ? ` "${filter}"` : ''}.`);
  process.exit(1);
}

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });

let failed = 0;
for (const file of testFiles) {
  const entry = path.join(TEST_DIR, file);
  const outfile = path.join(BUILD_DIR, file.replace(/\.ts$/, '.cjs'));

  console.log(`\n${'='.repeat(70)}\n### ${file}\n${'='.repeat(70)}`);

  try {
    esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      outfile,
      alias: { vscode: DEFAULT_STUB },
      logLevel: 'silent',
    });
  } catch (error) {
    failed++;
    console.error(`BUILD FAILED: ${file}`);
    console.error(error.message || error);
    continue;
  }

  const result = spawnSync(process.execPath, [outfile], {
    stdio: 'inherit',
    env: process.env,
    timeout: TIMEOUT_MS,
  });

  if (result.error) {
    failed++;
    console.error(`RUN FAILED: ${file}: ${result.error.message}`);
  } else if (result.status !== 0) {
    failed++;
  }
}

fs.rmSync(BUILD_DIR, { recursive: true, force: true });

console.log(
  `\n${failed === 0 ? 'ALL DRY TESTS PASSED' : `${failed} DRY TEST FILE(S) FAILED`}`
);
process.exit(failed === 0 ? 0 : 1);
