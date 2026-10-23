---
name: build-extension
description: Build, package, and install the Agntree VS Code extension. Use when asked to build, compile, package, create a VSIX, or install/update the extension.
allowed-tools:
  - Bash
  - Read
---

# Build Extension

Build, package, and install the Agntree VS Code extension. Run these from the repository root.

## Build

```bash
npm run compile
```

This bundles `src/` into `out/extension.js` with esbuild. Fix any errors before packaging.

Optionally type-check and run the fast tests:

```bash
npx tsc --noEmit
npm run test:dry
```

## Package as VSIX

```bash
npx @vscode/vsce package --allow-missing-repository
```

The output is `agntree-<version>.vsix` in the repo root (for example `agntree-1.2.1.vsix`).
Read the version from `package.json` rather than assuming one.

## Install the Extension

```bash
code --install-extension ./agntree-<version>.vsix --force
```

- No need to uninstall the existing copy first. `--force` replaces it in place, even when
  the version number is unchanged (the usual case during local development).
- Reinstalling keeps repositories and sessions: the extension ID is unchanged, so
  `globalState` (stored per extension ID) survives.
- If `code` is not found, the user has to run the command themselves; suggest they prefix
  it with `!` in the prompt so the output lands in the conversation.

## Reload VS Code — tell the user

After installing, **always tell the user to reload the window**:

> VS Code loads extensions at startup. Installing from the CLI writes the new files but the
> open window keeps running the old code. Run **Developer: Reload Window** from the Command
> Palette (`Cmd+Shift+P`), or quit and reopen VS Code.

There is no CLI command that reloads a specific running window, so this step cannot be done
for them. Do not report the change as visible until they have reloaded.

## Verify the install (when the user says they see no changes)

Check the installed files rather than re-packaging:

```bash
node -p "require('./package.json').publisher + '.' + require('./package.json').name + '@' + require('./package.json').version"
ls -l ~/.vscode/extensions/<publisher>.<name>-<version>/out/extension.js
```

If the timestamp is current, the install succeeded and only the reload is missing. For
VS Code Insiders the directory is under `~/.vscode-insiders/extensions`; for other forks
use that fork's `code` CLI.

## Development Workflow

1. Make changes to source files in `src/`
2. `npm run compile` to check for errors
3. Package with `npx @vscode/vsce package --allow-missing-repository`
4. Install with `code --install-extension ./agntree-<version>.vsix --force`
5. Tell the user to reload: **Command Palette** (`Cmd+Shift+P`) → **Developer: Reload Window**
6. Test in VS Code

## Troubleshooting

- Compile errors: read the esbuild/`tsc` output; `tsc --noEmit` gives the full diagnostics.
- Packaging failures: run `npm install` first. The `--allow-missing-repository` flag is
  needed because this is a local project without a public repository URL.
- "Extension is already installed": add `--force`.
- Changes not visible after install: the window was not reloaded — see the section above.
