---
name: build-extension
description: Build and package the Agntree VS Code extension. Use when asked to build, compile, package, or create a VSIX file.
allowed-tools:
  - Bash
  - Read
---

# Build Extension

Build and package the Agntree VS Code extension.

## Quick Build

```bash
cd /Users/skhileri/Documents/tools/claude-workspaces
npm run compile
```

## Package as VSIX

```bash
cd /Users/skhileri/Documents/tools/claude-workspaces
npx @vscode/vsce package --allow-missing-repository
```

The packaged extension will be at: `agntree-0.1.0.vsix`

## Install the Extension

```bash
code --install-extension agntree-0.1.0.vsix
```

## Development Workflow

1. Make changes to source files in `src/`
2. Run `npm run compile` to check for errors
3. Package with `npx @vscode/vsce package --allow-missing-repository`
4. Install and test in VS Code

## Troubleshooting

- If compile fails, check TypeScript errors in the output
- If packaging fails, ensure all dependencies are installed with `npm install`
- The `--allow-missing-repository` flag is needed since this is a local project
