#!/usr/bin/env node
/**
 * Integration-test runner.
 *
 * Launches a real VS Code instance (Extension Development Host) with this
 * extension loaded, points it at the temp profile below, and runs the suite in
 * test/integration/suite. No extension is installed permanently.
 *
 * Usage:
 *   npm run test:integration
 *
 * Environment:
 *   VSCODE_EXECUTABLE  path to the VS Code executable (optional; defaults are
 *                      probed per platform below)
 *   AGNTREE_TEST_KEEP  set to 1 to keep the temp user-data/extensions dirs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runTests } = require('@vscode/test-electron');
const { resolveVSCodeExecutable } = require('../vscodeExecutable');

async function main() {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agntree-vscode-test-'));
  const userDataDir = path.join(profileRoot, 'user-data');
  const extensionsDir = path.join(profileRoot, 'extensions');

  console.log(`VS Code:      ${resolveVSCodeExecutable()}`);
  console.log(`Profile:      ${profileRoot}`);

  try {
    await runTests({
      vscodeExecutablePath: resolveVSCodeExecutable(),
      extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
      extensionTestsPath: path.join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        '--skip-welcome',
        '--skip-release-notes',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
      ],
    });
    console.log('INTEGRATION RUN COMPLETE');
  } finally {
    if (process.env.AGNTREE_TEST_KEEP === '1') {
      console.log(`Kept profile at ${profileRoot}`);
    } else {
      fs.rmSync(profileRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error('INTEGRATION RUN FAILED', error);
  process.exit(1);
});
