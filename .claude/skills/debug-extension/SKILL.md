---
name: debug-extension
description: Debug and troubleshoot the Agntree VS Code extension. Use when there are errors, the extension isn't working, or when investigating issues.
allowed-tools:
  - Bash
  - Read
  - Grep
---

# Debug Extension

Troubleshoot issues with the Agntree VS Code extension.

## Check Compilation Errors

```bash
cd /Users/skhileri/Documents/tools/claude-workspaces
npm run compile
```

Look for TypeScript errors in the output.

## View Extension Logs

In VS Code:
1. Open Command Palette (Cmd+Shift+P)
2. Run "Developer: Show Logs"
3. Select "Extension Host" from the dropdown

Or check the Output panel:
1. View > Output
2. Select "Extension Host" or "Agntree"

## Common Issues

### Extension Not Activating

Check `package.json` activation events:
```json
"activationEvents": ["onStartupFinished"]
```

Verify the extension is installed:
```bash
code --list-extensions | grep agntree
```

### Commands Not Appearing

1. Check command is defined in `package.json` under `contributes.commands`
2. Verify menu entries have correct `when` clauses
3. Ensure `contextValue` matches the menu filter

### Tree View Empty

1. Check if repositories are stored in globalState
2. Verify `getChildren()` is returning items
3. Look for errors in Extension Host logs

### File Watcher Not Working

1. Verify worktree path is correct
2. Check if file patterns are matching
3. Look for watcher disposal issues

### Git Diff Not Opening

1. Ensure Git extension is enabled in VS Code
2. Check if the file is tracked by git
3. Verify `git.openChange` command is available

## Reinstall Extension

```bash
cd /Users/skhileri/Documents/tools/claude-workspaces
code --uninstall-extension agntree.agntree
npm run compile
npx @vscode/vsce package --allow-missing-repository
code --install-extension agntree-0.1.0.vsix
```

Then reload VS Code window (Cmd+Shift+P > "Developer: Reload Window").

## Debug with Breakpoints

1. Open the extension project in VS Code
2. Press F5 to launch Extension Development Host
3. Set breakpoints in TypeScript files
4. Interact with extension in the new window
5. Breakpoints will trigger in the original window

## Check Storage State

To inspect what's stored in globalState, add temporary logging:

```typescript
console.log('Stored repos:', storageService.getRepositories());
console.log('Stored chats:', storageService.getAllChats());
```

## Reset Extension State

To clear all stored data, run in VS Code developer console:
```javascript
// Get the extension context and clear globalState
// (requires modifying extension.ts temporarily)
```

Or uninstall and reinstall the extension.
