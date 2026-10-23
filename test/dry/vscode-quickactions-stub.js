/**
 * `vscode` stub for the quick-action tests.
 *
 * Overrides the harness commands so tests can point at fake CLI scripts, and
 * supplies a deterministic set of quick actions.
 */
const base = require('./vscode-stub.js');

const quickActions = [
  {
    name: 'Opencode Dry',
    harness: 'opencode',
    prompt: 'say ok',
    agent: 'build',
    model: 'enmaas/rits/model#high',
  },
  {
    name: 'Claude Dry',
    harness: 'claude',
    prompt: 'say ok',
    allowedTools: 'Read',
  },
  {
    name: 'Command Dry',
    command:
      "node -e \"require('fs').writeFileSync(process.env.AGNTREE_TEST_COMMAND_OUTPUT,'ok')\"",
  },
  {
    name: 'Bad Claude',
    harness: 'claude',
    prompt: 'missing tools',
  },
];

const configuration = {
  get(key, fallback) {
    if (key === 'quickActions') {
      return quickActions;
    }
    if (key === 'harnessCommands') {
      return {
        claude: process.env.AGNTREE_FAKE_CLAUDE || 'claude',
        opencode: process.env.AGNTREE_FAKE_OPENCODE || 'opencode',
      };
    }
    if (key === 'defaultHarness') {
      return 'claude';
    }
    return fallback;
  },
};

module.exports = {
  ...base,
  workspace: {
    ...base.workspace,
    getConfiguration: () => configuration,
  },
  __quickActions: quickActions,
};
