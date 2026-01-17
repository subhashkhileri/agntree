---
name: add-feature
description: Add a new feature to the Claude Workspaces extension following project architecture. Use when implementing new functionality, adding commands, or extending the extension.
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
---

# Add Feature to Claude Workspaces

Follow this guide when adding new features to the extension.

## Project Architecture

```
src/
├── extension.ts           # Entry point, activation, event handlers
├── types.ts               # Shared interfaces and types
├── commands/              # Command handlers
│   ├── repository.ts      # Repository management commands
│   ├── worktree.ts        # Worktree commands
│   └── chat.ts            # Chat session commands
├── providers/             # VS Code TreeDataProviders
│   ├── WorkspacesTreeProvider.ts  # Main tree view
│   └── ChangesTreeProvider.ts     # Changes panel
└── services/              # Business logic services
    ├── StorageService.ts      # Persistence (globalState)
    ├── GitService.ts          # Git operations
    ├── TerminalManager.ts     # Terminal lifecycle
    └── ClaudeSessionService.ts # Claude session discovery
```

## Adding a New Command

### Step 1: Define in package.json

Add to `contributes.commands`:

```json
{
  "command": "claude-workspaces.yourCommand",
  "title": "Your Command Title",
  "icon": "$(icon-name)"
}
```

Add menu entries in `contributes.menus.view/item/context`:

```json
{
  "command": "claude-workspaces.yourCommand",
  "when": "view == workspacesView && viewItem == chat",
  "group": "navigation"
}
```

### Step 2: Implement the Command

Add to appropriate file in `src/commands/`:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand(
    'claude-workspaces.yourCommand',
    async (item?: WorkspaceTreeItem) => {
      // Implementation
    }
  )
);
```

### Step 3: Register in extension.ts

If creating a new command file, import and call the register function.

## Adding a Tree Item Feature

### Update the Provider

In `WorkspacesTreeProvider.ts` or `ChangesTreeProvider.ts`:

1. Add properties to the TreeItem class if needed
2. Update `getChildren()` to include new items
3. Update `getTreeItem()` for custom rendering
4. Set appropriate `contextValue` for menu filtering

### Add Context Menu Actions

In `package.json`, add menu entries with `when` clause matching `viewItem`:

```json
{
  "command": "claude-workspaces.action",
  "when": "view == workspacesView && viewItem == yourItemType",
  "group": "inline"  // or "navigation", "1_actions", etc.
}
```

## Adding a Service

Create a new service in `src/services/`:

```typescript
export class YourService {
  constructor() {}

  public yourMethod(): ReturnType {
    // Implementation
  }
}
```

Instantiate in `extension.ts` and pass to providers/commands as needed.

## Data Persistence

Use `StorageService` for persistence:

```typescript
// Store data
storageService.set('key', value);

// Retrieve data
const value = storageService.get<Type>('key');
```

## UI Patterns Used

### Icons with Colors

```typescript
item.iconPath = new vscode.ThemeIcon(
  'icon-name',
  new vscode.ThemeColor('charts.green')
);
```

### File Icons from Theme

```typescript
item.resourceUri = vscode.Uri.file(filePath);
```

### Rich Tooltips

```typescript
const md = new vscode.MarkdownString();
md.appendMarkdown(`**Header**\n\nContent`);
item.tooltip = md;
```

### Inline Actions

Add to package.json with `"group": "inline"`.

## Testing Changes

1. Compile: `npm run compile`
2. Package: `npx @vscode/vsce package --allow-missing-repository`
3. Install: `code --install-extension claude-workspaces-0.1.0.vsix`
4. Reload VS Code window

## Code Style

- Use TypeScript strict mode
- Prefer async/await over callbacks
- Use descriptive variable names
- Add JSDoc comments for public methods
- Handle errors gracefully with try/catch
