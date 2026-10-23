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

function resolveVSCodeExecutable() {
  if (process.env.VSCODE_EXECUTABLE) {
    return process.env.VSCODE_EXECUTABLE;
  }

  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
      path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/MacOS/Code')
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      path.join(programFiles, 'Microsoft VS Code', 'Code.exe')
    );
  } else {
    candidates.push('/usr/share/code/code', '/usr/bin/code', '/snap/bin/code');
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      'Could not find a VS Code executable. Set VSCODE_EXECUTABLE to the ' +
        `executable path. Tried:\n  ${candidates.join('\n  ')}`
    );
  }
  return found;
}

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
