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

class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}

class TabInputCustom {
  constructor(uri, viewType) {
    this.uri = uri;
    this.viewType = viewType;
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
  constructor(scheme, pathValue, authority = '', query = '') {
    this.scheme = scheme;
    this.path = pathValue;
    this.fsPath = pathValue;
    this.authority = authority;
    this.query = query;
  }

  static file(pathValue) {
    return new Uri('file', pathValue);
  }

  static from({ scheme, authority = '', path, query = '' }) {
    return new Uri(scheme, path, authority, query);
  }

  static parse(value) {
    const match = String(value).match(/^([^:]+):\/\/(.*)$/);
    return match ? new Uri(match[1], match[2]) : new Uri('', String(value));
  }

  toString() {
    const authority = this.authority ? `${this.authority}` : '';
    const query = this.query ? `?${this.query}` : '';
    return `${this.scheme}://${authority}${this.path}${query}`;
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

const fileWatchers = [];
class FakeWatcher {
  constructor(pattern) {
    this.pattern = pattern;
    this.changeListeners = new Set();
    this.createListeners = new Set();
    this.deleteListeners = new Set();
    this.disposed = false;
    fileWatchers.push(this);
  }
  onDidChange(listener) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }
  onDidCreate(listener) {
    this.createListeners.add(listener);
    return { dispose: () => this.createListeners.delete(listener) };
  }
  onDidDelete(listener) {
    this.deleteListeners.add(listener);
    return { dispose: () => this.deleteListeners.delete(listener) };
  }
  dispose() {
    this.disposed = true;
    this.changeListeners.clear();
    this.createListeners.clear();
    this.deleteListeners.clear();
  }
  /** Test helper: deliver a filesystem event to the registered listeners. */
  __fireChange() {
    for (const listener of [...this.changeListeners]) listener({});
  }
  __fireCreate() {
    for (const listener of [...this.createListeners]) listener({});
  }
  __fireDelete() {
    for (const listener of [...this.deleteListeners]) listener({});
  }
}

const configurationValues = new Map();
const configuration = {
  get(key, fallback) {
    if (key === 'harnessCommands') {
      return { claude: 'claude', opencode: 'opencode', codex: 'codex' };
    }
    return configurationValues.has(key)
      ? configurationValues.get(key)
      : fallback;
  },
};

const commandHandlers = new Map();
const outputChannels = [];
const messages = [];
const openTerminals = [];
const closeListeners = new Set();
const openTerminalListeners = new Set();
const activeTerminalListeners = new Set();
const executionStartListeners = new Set();
const tabChangeListeners = new Set();
const tabGroupChangeListeners = new Set();
const configurationChangeListeners = new Set();
let activeTerminal;
let nextTerminalPid = 4100;
let silentExecutionEvents = false;
const warningResponses = [];
const quickPickResponses = [];
const inputResponses = [];
const openDialogResponses = [];
let quickPickHandler = null;
const installedExtensions = new Set();
const extensionChangeListeners = new Set();
const openExternalCalls = [];
let openExternalResult = true;

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
  TabInputWebview,
  TabInputCustom,
  ThemeIcon,
  ThemeColor,
  Uri,
  MarkdownString,
  RelativePattern,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
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
    createFileSystemWatcher: (pattern) => new FakeWatcher(pattern),
    onDidChangeConfiguration: (listener) => {
      configurationChangeListeners.add(listener);
      return {
        dispose: () => configurationChangeListeners.delete(listener),
      };
    },
  },
  window: {
    terminals: openTerminals,
    get activeTerminal() {
      return activeTerminal;
    },
    state: { focused: false },
    tabGroups: {
      all: [],
      get activeTabGroup() {
        return this.all.find((group) => group.isActive);
      },
      close: (tab) => {
        for (const group of module.exports.window.tabGroups.all) {
          const index = group.tabs.indexOf(tab);
          if (index !== -1) {
            group.tabs.splice(index, 1);
            return Promise.resolve(true);
          }
        }
        return Promise.resolve(false);
      },
      onDidChangeTabs: (listener) => {
        tabChangeListeners.add(listener);
        return { dispose: () => tabChangeListeners.delete(listener) };
      },
      onDidChangeTabGroups: (listener) => {
        tabGroupChangeListeners.add(listener);
        return { dispose: () => tabGroupChangeListeners.delete(listener) };
      },
    },
    createOutputChannel,
    onDidCloseTerminal: (listener) => {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    onDidOpenTerminal: (listener) => {
      openTerminalListeners.add(listener);
      return { dispose: () => openTerminalListeners.delete(listener) };
    },
    onDidChangeActiveTerminal: (listener) => {
      activeTerminalListeners.add(listener);
      return { dispose: () => activeTerminalListeners.delete(listener) };
    },
    onDidChangeTerminalShellIntegration: () => ({ dispose: () => undefined }),
    onDidStartTerminalShellExecution: (listener) => {
      executionStartListeners.add(listener);
      return { dispose: () => executionStartListeners.delete(listener) };
    },
    __fireDidCloseTerminal: (terminal) => {
      for (const listener of closeListeners) {
        listener(terminal);
      }
    },
    __fireDidOpenTerminal: (terminal) => {
      for (const listener of openTerminalListeners) {
        listener(terminal);
      }
    },
    __fireDidStartTerminalShellExecution: (terminal, commandLine = '') => {
      for (const listener of executionStartListeners) {
        listener({ terminal, execution: { commandLine } });
      }
    },
    __setActiveTerminal: (terminal) => {
      activeTerminal = terminal;
      for (const listener of activeTerminalListeners) {
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
        __pid: options.__pid ?? nextTerminalPid++,
        exitStatus: options.__exitStatus,
        shellIntegration: {},
        get processId() {
          return Promise.resolve(this.__pid);
        },
        sendText(text) {
          this.sent.push(text);
          if (silentExecutionEvents) {
            return;
          }
          for (const listener of executionStartListeners) {
            listener({ terminal: this, execution: { commandLine: text } });
          }
        },
        show() {
          this.shown += 1;
          activeTerminal = this;
          for (const listener of activeTerminalListeners) {
            listener(this);
          }
        },
        dispose() {
          this.disposed = true;
          const index = openTerminals.indexOf(this);
          if (index >= 0) {
            openTerminals.splice(index, 1);
          }
          if (activeTerminal === this) {
            activeTerminal = undefined;
            for (const listener of activeTerminalListeners) {
              listener(undefined);
            }
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
    showOpenDialog: async (options) => {
      messages.push([options]);
      return openDialogResponses.shift();
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
  extensions: {
    getExtension: (id) =>
      installedExtensions.has(id)
        ? { id, isActive: true, activate: async () => undefined }
        : undefined,
    onDidChange: (listener) => {
      extensionChangeListeners.add(listener);
      return { dispose: () => extensionChangeListeners.delete(listener) };
    },
    all: [],
  },
  env: {
    openExternal: async (uri) => {
      openExternalCalls.push(uri);
      return openExternalResult;
    },
  },
  commands: {
    registerCommand: (id, handler) => {
      commandHandlers.set(id, handler);
      return { dispose: () => commandHandlers.delete(id) };
    },
    getCommands: async () => Array.from(commandHandlers.keys()),
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
  __fileWatchers: fileWatchers,
  __messages: messages,
  __warningResponses: warningResponses,
  __quickPickResponses: quickPickResponses,
  __inputResponses: inputResponses,
  __openDialogResponses: openDialogResponses,
  __openExternalCalls: openExternalCalls,
  __setExtensionInstalled: (id, installed = true) => {
    if (installed) {
      installedExtensions.add(id);
    } else {
      installedExtensions.delete(id);
    }
  },
  __setOpenExternalResult: (value) => {
    openExternalResult = Boolean(value);
  },
  __quickPicks: quickPicks,
  __setQuickPickHandler: (handler) => {
    quickPickHandler = handler;
  },
  __setConfiguration: (key, value) => {
    if (value === undefined) {
      configurationValues.delete(key);
    } else {
      configurationValues.set(key, value);
    }
    const changed = `agntree.${key}`;
    for (const listener of configurationChangeListeners) {
      listener({
        affectsConfiguration: (section) =>
          changed === section || changed.startsWith(`${section}.`),
      });
    }
  },
  /** Test helper: model a shell that never reports a command start. */
  __setSilentExecutionEvents: (value) => {
    silentExecutionEvents = Boolean(value);
  },
};
