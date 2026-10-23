# Changelog

All notable changes to Agntree will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **opencode v2 harness** — opencode is now a first-class harness alongside Claude Code. Create, resume, import, search, fork (same worktree and to a new worktree), auto-name, and inspect opencode sessions from the sidebar. Sessions are discovered and manipulated through the `opencode` CLI/API (`session.list`, `session.get`, `session.fork`, `session.move`, `session export`), never by reading its SQLite database.
- **Harness submenu** — Worktree `+` action and context menu now open a **New Session** submenu with **New Claude Code Session** and **New opencode Session**. Entries are hidden when the corresponding CLI is not installed.
- **Harness-aware quick actions** — Quick actions can set `harness`, `agent`, `model`, and `auto`. Claude keeps `prompt` + `allowedTools`; opencode runs `opencode run <prompt> --auto`. Actions without a harness use the new `agntree.defaultHarness` setting.
- **`agntree.harnessCommands`** — Override the CLI command per harness (wrappers, custom installs, or a CLI not on `PATH`).
- **Harness logos and state badges** — Chat rows now use custom SVG marks for Claude Code and opencode. Generated variants add a green running badge, a grey mark for closed sessions, and a hollow ring for sessions that have not started yet. Harnesses without custom art fall back to a text label when more than one is installed.
- **Quiet tree layout** — Session rows show only what changes: a short relative time (`16m`, `2h`, `3d`) or `new`, a star when set, and the harness mark. Repository rows are neutral; worktree color is reserved for state — amber for the open workspace, blue for a PR checkout, green for the main worktree, neutral otherwise — and worktrees show `↑n`/`↓n` when they are ahead of or behind their upstream.
- **Session brief tooltip** — Hovering a session now shows what the row cannot: the latest recap (with its age) or the last exchange, followed by message count, model, agent, tokens, and cost. Redundant harness/status/star lines are gone.
- **Numbered fork names** — Forking `Fix icons` creates `Fix icons (1)`; forking that session creates `Fix icons (1) (1)`. Sibling forks increment to `(2)`, `(3)`, … so names stay unique in the target worktree.
- **Operation log** — Destructive file and worktree actions (delete, rename, paste, discard, worktree removal, orphan fork cleanup) are recorded with a timestamp in the **Agntree Operations** output channel, along with any refusal or failure.

### Changed

- **Less destructive toolbar and context menus** — Only the primary action stays inline: Add Repository in the view title, New Session and Open Terminal on worktrees, and star/rename on sessions. Clone, search, starred sessions, settings, refresh, remove, delete, and fork-to-worktree moved into the `…` and context menus, and commands that open dialogs now end in `…`.
- **Quiet Search Sessions picker** — Rows are now one line: harness mark, title, relative time, and message count, grouped by worktree with the main worktree first. Five-prompt previews under every row are gone; the highlighted row expands with a brief (recap or last exchange, then message count, model, agent, tokens, cost). Imported sessions show a check instead of the word "imported", and harness/branch text is no longer repeated.
- **Changes panel polish** — Section headers read `3 files · +12 -4` (with a green check for staged and a yellow edit icon for unstaged), nested files show their directory to disambiguate same-named files, rows sort by status then path, tooltips show the full path and a readable status, and a clean tree shows a green "No uncommitted changes".
- **All Files panel polish** — Names sort naturally (`file2` before `file10`), rows tooltip their worktree-relative path, and an unselected panel shows "Select a worktree or chat" instead of an empty list.
- **Panels keep their expansion state** — Changes sections and All Files folders have stable row ids, so auto-refresh on file writes no longer collapses what you had open.
- **Session storage model** — Chats now store `harness` and `harnessSessionId` instead of `claudeSessionId`. Existing chats are migrated to Claude on first read, so upgrades are seamless.
- **Generic session wording** — Import, search, remove, and clear dialogs now refer to the native harness session rather than `~/.claude/`.
- **Adapter architecture** — Added `HarnessAdapter`, `HarnessRegistry`, `ClaudeHarness`, and `OpencodeHarness`, plus a harness-aware watcher registry, leaving a seam for Codex and other agents.

### Security

- **Guards against destructive mistakes** — Deleting in All Files requires the path to be inside the active worktree and sends files and folders to the Trash. Creating a file refuses to overwrite one that already exists. Rename and create reject names containing path separators. Pasting refuses to copy a folder into itself or a descendant, and cut-paste into the same folder is a no-op instead of a "copy" rename.
- **Worktree removal checks the path** — The one directory delete done by Node (recovering a corrupted worktree) now refuses the filesystem root, the repository, the user's home, any ancestor of those, and any directory `git worktree list` does not report for that repository.
- **Discard says exactly what it deletes** — Discarding a single untracked file asks to move it to the Trash; discarding all changes names the worktree and spells out how many tracked changes and untracked files `git clean` will permanently remove.
- **No shell interpolation** — Git operations run through argument arrays (`execFileSync`), so branch names, remote URLs and file paths are never interpreted by a shell. The last interpolated command (`git cat-file`) was replaced with an API call.
- **Session copy never overwrites** — Forking a Claude session into a worktree copies with `errorOnExist`, so a name collision fails instead of clobbering an existing transcript. opencode orphan-fork cleanup accepts only `ses_…` IDs.

### Fixed

- Session resume/fork now checks with the harness adapter (and the worktree directory) before launching, so a missing opencode session produces the same cleanup prompt as a missing Claude session.
- Sessions that are not open now render with the grey closed icon. Previously only sessions whose terminal close was observed live were dimmed; sessions left idle by a window restart or by import kept the full-color mark.

## [1.2.1] - 2026-05-17

### Added

- **Search in Files** — New search button in the All Files panel toolbar. Opens VS Code's native Search panel pre-scoped to the active worktree directory, so results are limited to that branch's files.
- **Focus on Startup** — New `agntree.focusOnStartup` setting (default `false`). When enabled, Agntree automatically focuses its sidebar panel when VS Code starts instead of the File Explorer. Toggle directly from the Workspaces panel toolbar via the eye icon.
- **Panel size defaults** — Initial panel proportions are now set so Workspaces gets the most space (4), All Files next (3), Changes after that (2), and Quick Actions the least (1).
- **Quick Actions collapsed by default** — The Quick Actions panel now starts collapsed on first install for a cleaner initial layout.

## [1.2.0] - 2026-05-16

### Added

- **Star Sessions** — Mark important sessions with a star for quick access and visual distinction in the sidebar.
- **Discard All Changes** — One-click discard of all unstaged changes from the Changes panel, with confirmation dialog.
- **Rebase onto Upstream** — Rebase the current branch onto upstream (or origin) with a pre-flight conflict check that warns before proceeding.

### Fixed

- **Discard destroying staged changes** — Discard file and discard all used `git checkout HEAD --` which reset to HEAD, wiping staged changes. Now uses `git checkout --` to restore from the index, preserving staged changes.
- **Staged new files shown as Modified** — Newly staged files (not yet committed) incorrectly showed status `M` instead of `A` because `git ls-files` considers staged files as tracked. Now checks against `HEAD` with `git cat-file` for staged changes.
- **Session auto-rename race condition** — `fs.watch` could miss the initial session file write, causing auto-rename to fail silently. Added a fallback directory scan to reliably detect new sessions.
- **Memory leaks and excessive refreshes** — Fixed leaked file watchers, added refresh coalescing to batch rapid tree updates, and ensured child processes are cleaned up on extension deactivation.
- **Auto-rename polling reliability** — Improved polling logic for session auto-rename to handle edge cases where the session file is not immediately available.

## [1.1.0] - 2026-02-24

### Added

- **Search Sessions** — Repository-level command to find and import all Claude Code sessions across all worktrees. Sessions are grouped by worktree with previews of recent prompts, message counts, and relative timestamps. Already-imported sessions are marked and excluded from re-import.
- **PR Checkout** — Check out any GitHub pull request into a new worktree. Uses `gh` CLI for remote resolution, supporting PRs from both same-repo branches and forks. Local branches are named `pr-<number>` to avoid collisions.

### Fixed

- **PR checkout failing with "invalid reference"** — Previously used `git fetch origin <branchName>` which failed for PRs from forks or when the branch didn't exist on `origin`. Now uses `gh pr checkout` which handles remote resolution automatically.
- **PR checkout ignoring fetch failures** — The return value of `fetchBranch()` was not checked, causing `createWorktree()` to proceed with a non-existent branch reference. Now aborts early with a clear error message on fetch failure.

## [1.0.0] - 2026-02-16

### Added

- **GitHub Pages landing site** — `docs/index.html` with SEO meta tags, Open Graph, Twitter Card, and JSON-LD structured data (SoftwareApplication + FAQPage)
- **Sitemap and robots.txt** — For Google Search Console indexing
- **CONTRIBUTING.md** — Full contribution guide with "Adding Support for New AI Coding Agents" section
- **CHANGELOG.md** — Version history in Keep a Changelog format
- **SECURITY.md** — Data privacy notes and vulnerability reporting policy
- **CODE_OF_CONDUCT.md** — Contributor Covenant v2.1
- **GitHub issue templates** — Bug report, feature request, and new agent support request (YAML forms with agent/IDE dropdowns)
- **Pull request template** — Checklist for code quality and testing
- **Release workflow update** — Keyword-rich release body with Marketplace install link

## [0.1.0] - 2025-01-01

### Added

- **AI Agent Session Management** — Create, resume, rename, and remove Claude Code sessions from the sidebar
- **Git Worktree Integration** — Automatically detect and manage git worktrees for each repository
- **Session Forking** — Fork sessions within the same worktree or to a new worktree with uncommitted changes
- **Session Import** — Import existing Claude Code sessions from `~/.claude/projects/` with multi-select support
- **Changes Panel** — View staged/unstaged changes with inline diffs, stage/unstage/discard actions
- **Quick Actions** — Run Claude prompts or shell commands with one click (configurable)
- **Multi-Repository Management** — Add and organize multiple git repositories in one sidebar
- **Clone from GitHub** — Clone repositories directly from GitHub URLs or shorthand notation
- **Auto-Naming** — Sessions are automatically named based on their first prompt or summary
- **Workspace Switching** — Optionally switch VS Code workspace folder when selecting a worktree
- **State Persistence** — Active worktree and session selection persists across VS Code restarts
- **Session Previews** — Hover over sessions to see the last 3 messages in a tooltip
- **Terminal Sync** — Switching between terminal tabs auto-selects the corresponding session
- **Worktree Merge** — Merge branches between worktrees directly from the extension
- **Dynamic View Titles** — Changes and Quick Actions panels show active worktree and repository name
- **Open PR in Browser** — Open the pull request for a worktree's branch directly in the browser
