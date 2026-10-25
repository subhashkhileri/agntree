const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Find the installed VS Code executable. Shared by the integration suite and
 * the optional terminal-restore E2E test.
 *
 * `VSCODE_EXECUTABLE` overrides the platform defaults.
 */
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

module.exports = { resolveVSCodeExecutable };
