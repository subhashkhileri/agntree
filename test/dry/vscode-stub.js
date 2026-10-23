/**
 * Minimal `vscode` module stub for dry tests.
 *
 * The extension's service/adapter/provider modules import `vscode`, which only
 * exists inside the extension host. Tests bundle the module under test with
 * esbuild and alias `vscode` to this file, so the real logic can run under
 * plain Node without installing the extension.
 */
const fs = require('fs');
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
    const joined = [base && base.path, ...parts].filter(Boolean).join('/').replace(/\/+/g, '/');
    return new Uri((base && base.scheme) || 'file', joined);
  }
}

const quickPicks = [];

/** Minimal QuickPick: tests drive activity/accept/hide explicitly. */
class FakeQuickPick {
  constructor() {
    this.items = [];
    this.activeItems = [];
    this.selectedItems = [];
    this.value = '';
    this.placeholder = '';
    this.title = '';
    this.matchOnDescription = false;
    this.matchOnDetail = false;
    this.busy = false;
    this.disposed = false;
    this.shown = false;
    this.activeListeners = new Set();
    this.acceptListeners = new Set();
    this.hideListeners = new Set();
    quickPicks.push(this);
  }

  onDidChangeActive(listener) {
    this.activeListeners.add(listener);
    return { dispose: () => this.activeListeners.delete(listener) };
  }

  onDidAccept(listener) {
    this.acceptListeners.add(listener);
    return { dispose: () => this.acceptListeners.delete(listener) };
  }

  onDidHide(listener) {
    this.hideListeners.add(listener);
    return { dispose: () => this.hideListeners.delete(listener) };
  }

  show() {
    this.shown = true;
  }

  hide() {
    this.dispose();
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const listener of [...this.hideListeners]) {
      listener();
    }
  }

  /** Test helper: simulate the user highlighting an item. */
  __setActive(item) {
    this.activeItems = item ? [item] : [];
    for (const listener of [...this.activeListeners]) {
      listener(this.activeItems);
    }
  }

  /** Test helper: simulate the user pressing Enter. */
  __accept() {
    for (const listener of [...this.acceptListeners]) {
      listener();
    }
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
  onDidDelete() {}
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
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: {
    fs: {
      readDirectory: async (uri) => {
        const entries = fs.readdirSync(uri.fsPath, { withFileTypes: true });
        return entries.map((entry) => [
          entry.name,
          entry.isDirectory() ? 2 : 1,
        ]);
      },
    },
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
    createQuickPick: () => new FakeQuickPick(),
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
      // Context keys are bookkeeping for menus; nothing to execute in tests.
      if (id === 'setContext') {
        return undefined;
      }
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
  __quickPicks: quickPicks,
  __setQuickPickHandler: (handler) => {
    quickPickHandler = handler;
  },
};
