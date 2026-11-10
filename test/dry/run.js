#!/usr/bin/env node
/**
 * Dry-test runner.
 *
 * Bundles every `*.test.ts` under test/dry with esbuild, aliases the `vscode`
 * module to a stub, and runs the bundles with Node's built-in test runner. Each
 * file runs in its own process; tests within a file run in order. No extension
 * install and no extension host required.
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
const STUB = path.join(TEST_DIR, 'vscode-stub.js');
const TIMEOUT_MS = Number(process.env.AGNTREE_TEST_TIMEOUT_MS || 60_000);

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

let status = 0;
try {
  const bundles = testFiles.map((file) => {
    const outfile = path.join(BUILD_DIR, file.replace(/\.ts$/, '.cjs'));
    esbuild.buildSync({
      entryPoints: [path.join(TEST_DIR, file)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile,
      alias: { vscode: STUB },
      sourcemap: 'inline',
      logLevel: 'error',
    });
    return outfile;
  });

  const result = spawnSync(
    process.execPath,
    [
      '--enable-source-maps',
      '--test',
      '--test-reporter=spec',
      `--test-timeout=${TIMEOUT_MS}`,
      ...bundles,
    ],
    { stdio: 'inherit', env: process.env }
  );
  status = result.status ?? 1;
} catch (error) {
  console.error(error.message || error);
  status = 1;
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

process.exit(status);
