/**
 * Minimal `vscode` module stub for dry tests.
 *
 * The extension's service/adapter/provider modules import `vscode`, which only
 * exists inside the extension host. Tests bundle the module under test with
 * esbuild and alias `vscode` to this file, so the real logic can run under
 * plain Node without installing the extension.
 */
class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (listener) => {
      this.listeners.add(listener);
      return { dispose: () => this.listeners.delete(listener) };
    };
  }

  fire(value) {
    for (const listener of this.listeners) {
      listener(value);
    }
  }

  dispose() {
    this.listeners.clear();
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class Uri {
  constructor(scheme, pathValue) {
    this.scheme = scheme;
    this.path = pathValue;
    this.fsPath = pathValue;
  }

  static file(pathValue) {
    return new Uri('file', pathValue);
  }

  static joinPath(base, ...parts) {
    const basePath = typeof base === 'string' ? base : (base && base.path) || '';
    const joined = [basePath.replace(/\/+$/, ''), ...parts].join('/');
    return new Uri((base && base.scheme) || 'file', joined);
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value;
    this.supportHtml = false;
  }

  appendMarkdown(value) {
    this.value += value;
    return this;
  }
}

class RelativePattern {
  constructor(base, pattern) {
    this.base = base;
    this.pattern = pattern;
  }
}

class FakeWatcher {
  onDidChange() {}
  onDidCreate() {}
  dispose() {}
}

const configuration = {
  get(key, fallback) {
    if (key === 'harnessCommands') {
      return { claude: 'claude', opencode: 'opencode' };
    }
    if (key === 'defaultHarness') {
      return 'claude';
    }
    return fallback;
  },
};

const commandHandlers = new Map();
const outputChannels = [];
const messages = [];
const openTerminals = [];
const closeListeners = new Set();
const warningResponses = [];
const quickPickResponses = [];
const inputResponses = [];
let quickPickHandler = null;

function createOutputChannel(name) {
  const channel = {
    name,
    lines: [],
    appendLine: (line) => channel.lines.push(line),
    append: (line) => channel.lines.push(line),
    show: () => undefined,
    clear: () => {
      channel.lines.length = 0;
    },
    dispose: () => undefined,
  };
  outputChannels.push(channel);
  return channel;
}

module.exports = {
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  Uri,
  MarkdownString,
  RelativePattern,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TerminalLocation: { Editor: 2, Panel: 1 },
  workspace: {
    getConfiguration: () => configuration,
    workspaceFolders: [],
    createFileSystemWatcher: () => new FakeWatcher(),
  },
  window: {
    terminals: openTerminals,
    createOutputChannel,
    onDidCloseTerminal: (listener) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    __fireDidCloseTerminal: (terminal) => {
      for (const listener of closeListeners) {
        listener(terminal);
      }
    },
    createTerminal: (options) => {
      const terminal = {
        name: options.name,
        options,
        sent: [],
        shown: 0,
        disposed: false,
        sendText(text) {
          this.sent.push(text);
        },
        show() {
          this.shown += 1;
        },
        dispose() {
          this.disposed = true;
          const index = openTerminals.indexOf(this);
          if (index >= 0) {
            openTerminals.splice(index, 1);
          }
        },
      };
      openTerminals.push(terminal);
      return terminal;
    },
    showWarningMessage: async (...args) => {
      messages.push(args);
      return warningResponses.shift();
    },
    showErrorMessage: async (...args) => {
      messages.push(args);
      return undefined;
    },
    showInformationMessage: async (...args) => {
      messages.push(args);
      return undefined;
    },
    showQuickPick: async (items, options) => {
      messages.push([items, options]);
      if (quickPickHandler) {
        return quickPickHandler(items, options);
      }
      return quickPickResponses.shift();
    },
    showInputBox: async (options) => {
      messages.push([options]);
      return inputResponses.shift();
    },
    withProgress: async (_options, task) => task(),
  },
  commands: {
    registerCommand: (id, handler) => {
      commandHandlers.set(id, handler);
      return { dispose: () => commandHandlers.delete(id) };
    },
    executeCommand: async (id, ...args) => {
      const handler = commandHandlers.get(id);
      if (!handler) {
        throw new Error(`No command registered: ${id}`);
      }
      return handler(...args);
    },
  },
  __commandHandlers: commandHandlers,
  __outputChannels: outputChannels,
  __messages: messages,
  __warningResponses: warningResponses,
  __quickPickResponses: quickPickResponses,
  __inputResponses: inputResponses,
  __setQuickPickHandler: (handler) => {
    quickPickHandler = handler;
  },
};
