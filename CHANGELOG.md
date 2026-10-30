# Changelog

All notable changes to Agntree will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Open a Claude Code session in the Claude Code UI** — Right-click a linked Claude Code session and choose **Open in Claude Code UI**. Agntree closes the session's terminal after confirmation, then asks the Claude Code extension to open that exact session in its native chat surface in the active editor group, honoring `claudeCode.preferredLocation`. The active group is where the session's terminal or your files are, so the UI does not create and lock a new right-hand group. The matching row is selected and shown as active while its Claude UI tab is open, turn-state polling includes UI sessions, and switching back to a CLI terminal tab selects the CLI session again. It can open the session only when the session's worktree is the first folder open in VS Code, because the extension UI always runs in that folder; other worktrees get an offer to open in a new window. The action stays visible when the extension is missing and explains what to install. A session without a transcript still starts in the terminal until its first prompt; Agntree maps only the UI tabs it opened, not tabs opened directly in the extension.
- **Open a Codex session in the Codex UI** — Right-click a linked Codex session and choose **Open in Codex UI**. Agntree closes the session's terminal after confirmation and opens the thread in the Codex extension's conversation panel in the active editor group. Codex panels carry their thread ID, so Agntree also maps panels restored after a reload or opened directly from the Codex extension, even though the sidebar view is not an editor tab. The same row selection, active mark, turn-state polling, and notification suppression apply. The Codex panel resumes the thread in its own worktree, so the first-folder rule that applies to the Claude UI does not apply here. The action stays visible when the extension is missing and explains what to install.
- **An open session UI is focused, not duplicated** — Clicking a session row that is already open in the Claude Code or Codex extension reveals that panel instead of launching a second CLI for the same session. A live terminal still takes precedence when both are open.
- **Choose where a session opens** — `agntree.defaultSessionSurface` decides whether clicking a session row prefers its terminal or the agent's VS Code UI, falling back to the terminal when the UI cannot open that session. **Open Session in Terminal** and the UI hover icon override the default, and switching an open UI session back to a terminal asks before closing its tab so two agent processes never run at once. The UI context-menu action stays visible when the extension is missing and explains what to install.
- **Start a new session in the agent UI** — The New Session menu offers a UI entry for Claude Code and Codex alongside the terminal entry. Agntree creates the row immediately, opens a new conversation, and links the real session when the first prompt creates it; the row keeps the harness-assigned name. Claude starts the conversation in the first VS Code folder and Codex in a single-folder workspace, so other worktrees explain the limitation rather than running in the wrong directory.
- **Sessions started outside Agntree appear automatically** — Agntree imports recent native sessions from each folder and worktree, including sessions started in a plain terminal, another window, or an agent's own UI. Chats use the agent's session name (Claude's `ai-title`, Codex's thread name, or opencode's title) with the first prompt only as a fallback. Every row — imported or started in Agntree — ages out after `agntree.autoImport.retentionDays` quiet days (7 by default); a star keeps one indefinitely, a chat open in a terminal or UI tab is never removed, and removing a session from the list keeps it out of future imports. `agntree.autoImport.enabled` turns the automatic import off without affecting linkage for sessions Agntree launches.
- **Session names follow the agent** — Claude's `ai-title` entries now name the session, so a renamed Claude conversation appears under that name instead of its first prompt. Auto-imported chats follow a later harness title once, unless you renamed the chat yourself.

### Changed

- **Sessions keep a stable creation order** — Session rows sort by when they were created, newest first, instead of by recent activity with starred and open rows pulled to the top. Opening, resuming, or starring a chat no longer makes it jump position; the active mark and the star still show its state.
- **Auto-import pauses while the sidebar is hidden** — Agntree no longer scans the agents' sessions every two minutes in the background of a window where the Agntree view is closed. It catches up as soon as the view is visible again. A session that is still being linked after a UI launch always keeps scanning.

### Fixed

- **A starred session obeys the same open rules** — Picking a session from **Show Starred Sessions** now focuses its open Claude Code or Codex panel and follows `agntree.defaultSessionSurface`, like clicking the row, instead of always launching a terminal beside the open panel.
- **A failed UI start leaves no row behind** — If the agent's UI cannot open a new conversation, Agntree removes the placeholder row it created instead of keeping an unlinked row that held back auto-import for other sessions in that worktree.
- **Search Sessions import clears a removal** — Importing a session from **Search Sessions** now undoes an earlier removal the same way **Import Existing Sessions** does, so the session can be imported again after retention later drops the row.
- **A UI session links the right conversation after a reload** — The set of sessions that existed before a UI launch is saved with the session, so a window reload between the launch and the first prompt no longer lets the placeholder adopt an older conversation from the same worktree.
- **A background link binds only a matching Claude tab** — Linking a session from a scan no longer claims whichever Claude tab happens to be active; it binds only a tab whose title matches the session's name.

## [2.1.0] - 2026-10-25

### Added

- **Plain folders as workspace roots** — **Add Local Folder or Repository…** accepts any folder, not only git repositories. A plain folder gets a plain folder icon instead of the repository mark, sessions run directly under its row, and the Changes panel says there is no repository instead of claiming a clean tree. If the folder becomes a git repository — for example after you or an agent runs `git init` — Agntree upgrades the row automatically and keeps every session bound to the same main worktree, with no re-adding; deleting `.git` turns it back into a plain folder. Selecting a directory inside an existing repository still adds that repository's root, and a bare repository or `.git` directory is refused because it has no working tree. Git-only row actions (worktrees, merge, rebase, PR checkout) stay off a plain folder, and **Fork to New Worktree** explains that there is no branch to fork into until the folder becomes a repository.
- **Reorder workspace rows** — Repository and folder rows have **Move Up** and **Move Down** in their context menu. The order is stored with your workspace list and survives reloads; the move stops at the first and last visible row and says so.

## [2.0.1] - 2026-10-25

### Changed

- **VS Code 1.93+ is required** — Restoring a terminal's identity relies on shell-integration events.

### Fixed

- **Restored terminals are the same chats again** — After a window reload, Agntree reconnects every terminal to its chat by process ID instead of by name, so it never types into a running agent. After a quit and reopen, every restored tab resumes its own session in the background, instead of only the active tab.
- **A resumed chat runs in its own worktree** — A revived tab starts in the workspace folder, so Agntree now changes into the chat's worktree before launching the harness. A session outside the open folder no longer edits or commits on the wrong branch.
- **Terminal identity survives a workspace switch** — Terminal records now live outside the per-workspace state that VS Code replaces when `agntree.autoSwitchWorkspaceFolder` changes the folder, keyed by the folder they belong to. Switching worktrees no longer forgets the running terminals, so the next reload cannot start a second agent for a chat that is already open.
- **Startup does not wait for a harness to answer** — Adoption of terminals that survived a reload still finishes before the sidebar and commands appear, but resuming revived tabs now asks the harness whether each session exists only after that. A slow or hung `codex app-server` can no longer leave the extension looking dead for up to 30 seconds.
- **Restoring titles no longer moves the tree** — The background pass that re-applies Agntree titles to revived tabs is marked as manager-initiated, so it does not change the selected chat, the Changes and All Files worktree, or trigger auto-switch.
- **No title wait when shell integration is off** — With `terminal.integrated.shellIntegration.enabled: false`, opening a chat no longer pauses for the two-second command-start timeout that can never fire.
- **Restored tabs keep their Agntree title** — The title is re-applied after the harness starts, so the next quit restores the same chat identity instead of a tab named after the shell.
- **One tab per chat resumes** — If two restored tabs carry the same Agntree title, only the first is resumed; the duplicate is left as a plain shell instead of starting a second agent on the same session.
- **New chats still link their first session after a reload** — A restored Codex or opencode chat that had not prompted yet is registered with its watcher again, so the session created by its first message is linked instead of leaving the chat unstarted.
- **Titles cannot swap between tabs** — Overlapping focus changes during a title update no longer rename the wrong terminal, so a later restore cannot resume a chat in another chat's tab.

## [2.0.0] - 2026-10-24

### Added

- **Deterministic Claude Code linkage** — A new Claude chat chooses its session ID before launch (`claude --session-id`), so Agntree links the exact transcript that appears after the first prompt. Two chats in the same worktree can no longer claim each other’s sessions, and reopening a chat before its first prompt keeps the same ID.
- **Native Claude Code forks** — Forks launch `claude --resume <source> --fork-session --session-id <new>` and write the fork transcript in the destination worktree. Agntree no longer copies project directories. Reopening a fork terminal before its first prompt repeats the fork with the same IDs instead of starting a fresh session.
- **Automatic “needs input” alerts for Claude Code** — Agntree reads `claude agents --json` to detect permission prompts and questions, so needs-you notifications no longer require hooks.

### Changed

- **Claude Code 2.1.310+ is required** — Older versions are unsupported; there is no version detection, capability probe, or compatibility path.
- **Leaner Claude metadata** — Session tooltips and import rows now show the summary, last exchange, and last activity. Recap, model/token usage, git branch, and message count are no longer extracted; other agents are unchanged.
- **Cheaper attention polling for Claude** — The 4-second poll reads only the end of the transcript and expands in steps only when needed, instead of re-parsing the whole file.
- **An unused fork does not linger** — Closing a Claude fork's terminal before its first prompt removes the chat. Claude writes no transcript until that prompt, so the row could only ever fork from the source's newer state, not the state you forked from.
- **Claude discovery handles more paths** — Project directories now encode every non-alphanumeric character as `-`, matching Claude. Directories longer than 200 characters match by Claude’s truncated prefix, `CLAUDE_CONFIG_DIR` selects a custom profile, and `CLAUDE_CODE_PROJECT_DIR_NAME` is honored when a config directory is explicit.

### Fixed

- **Symlinked worktrees discover their Claude sessions** — Project directories now encode the physical path Claude writes, so opening a worktree through a symlink no longer hides its sessions. Duplicate transcripts resolve to the newest copy, and a `relocated` session tracks its new directory.
- **Forking a missing Claude session fails cleanly** — If the source transcript is gone, Agntree says so before asking for a branch or creating a worktree.
- **No notification replay after a window reload** — A session that was already waiting when the extension host restarted no longer re-alerts on the first attention tick.
- **A finished terminal no longer looks like a running session** — When a terminal's process exits but VS Code keeps its tab, the row now shows closed instead of the finished-turn mark, and opening the session launches a fresh terminal instead of focusing the dead tab.

### Removed

- **Claude Code notification hooks** — The install and remove hook commands, the `agntree.attentionHooks` context key, and all reads and writes of `~/.claude/settings.json` are gone. Old Agntree hook entries are inert and can be deleted by hand.

## [1.4.0] - 2026-10-24

### Added

- **Codex harness** — Codex is now a first-class harness. Create, resume, import, search, fork (same worktree and to a new worktree), auto-name, and inspect Codex threads from the sidebar. Discovery, metadata, previews, and forks go through `codex app-server`, the same experimental JSON-RPC surface used by the official IDE integrations; a private app-server starts on demand and stops after an idle period. New chats still launch `codex` in a terminal and link after the first prompt, because a thread is not materialized before then. Live turn state and token usage come from the latest rollout, which is the only live signal for a thread owned by a separate TUI process.
- **New Codex Session** — Added to both **New Session** submenus, gated on the Codex CLI being installed, and `agntree.harnessCommands.codex` overrides its launch command.
- **Codex tree mark** — The OpenAI mark, generated in the same working/done/closed/new variants as the other harness marks and colored for light and dark themes.

### Fixed

- **Fork to a new worktree with a terminal-kind harness** — The new chat no longer records the source session ID when the harness forks in the terminal (`ForkResult.kind === 'terminal'`); it stays unlinked and the watcher captures the native fork ID.
- **Codex forks open immediately** — The private app-server now unloads a forked thread and releases its writer lock before the terminal opens it, so Codex no longer reports the new fork as already open in another app.

## [1.3.0] - 2026-10-24

### Added

- **Animated "working" mark** — a session mid-turn now shows its harness mark beating like a heartbeat instead of a green dot. The whole mark contracts to 78% and dims to 72% every 1.4s, so it stands out at 16px where a tiny status glyph would not; `prefers-reduced-motion` shows it at rest. The green dot now means the turn has finished.
- **Session notifications** — Agntree now tells you when a session stops working. A finished turn is detected for every harness (Claude's transcript `stop_reason`, opencode's `time.idle`) and shown as a VS Code notification with an **Open** button; on macOS a system banner also appears while VS Code is not focused. Sessions whose terminal is already in front of you are skipped, and each turn notifies once.
- **Opt-in "needs you" alerts** — **Agntree: Enable 'Needs Input' Notifications** adds `Stop` and `Notification` hooks to `~/.claude/settings.json` (preserving your existing hooks, with a one-time backup) that append permission prompts and idle questions to `~/.agntree/attention.jsonl`. A matching remove command strips only Agntree's entries. opencode reports finished turns only; its CLI exposes no pending-permission state.
- **`agntree.notifications.*` settings** — `enabled`, `onTurnEnd`, `onNeedsInput`, and `nativeBanner` control delivery.
- **opencode v2 harness** — opencode is now a first-class harness alongside Claude Code. Create, resume, import, search, fork (same worktree and to a new worktree), auto-name, and inspect opencode sessions from the sidebar. Sessions are discovered and manipulated through the `opencode` CLI/API (`session.list`, `session.get`, `session.fork`, `session.move`, `session export`), never by reading its SQLite database.
- **Harness submenu** — Worktree `+` action and context menu now open a **New Session** submenu with **New Claude Code Session** and **New opencode Session**. Entries are hidden when the corresponding CLI is not installed.
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

### Removed

- **Quick Actions** — The Quick Actions panel, its commands, and the `agntree.quickActions` and `agntree.defaultHarness` settings are gone. The panel duplicated what a session terminal already does, and its separate process-tracking and headless-command paths were no longer worth maintaining.

### Security

- **Guards against destructive mistakes** — Deleting in All Files requires the path to be inside the active worktree and sends files and folders to the Trash. Creating a file refuses to overwrite one that already exists. Rename and create reject names containing path separators. Pasting refuses to copy a folder into itself or a descendant, and cut-paste into the same folder is a no-op instead of a "copy" rename.
- **Worktree removal checks the path** — The one directory delete done by Node (recovering a corrupted worktree) now refuses the filesystem root, the repository, the user's home, any ancestor of those, and any directory `git worktree list` does not report for that repository.
- **Discard says exactly what it deletes** — Discarding a single untracked file asks to move it to the Trash; discarding all changes names the worktree and spells out how many tracked changes and untracked files `git clean` will permanently remove.
- **No shell interpolation** — Git operations run through argument arrays (`execFileSync`), so branch names, remote URLs and file paths are never interpreted by a shell. The last interpolated command (`git cat-file`) was replaced with an API call.
- **Session copy never overwrites** — Forking a Claude session into a worktree copies with `errorOnExist`, so a name collision fails instead of clobbering an existing transcript. opencode orphan-fork cleanup accepts only `ses_…` IDs.

### Fixed

- Sessions with a running background agent no longer report a finished turn. Claude can end
  its parent turn while a launched subagent keeps working; those sessions now stay on the
  animated working mark (and skip the finished notification) until Claude's turn-end
  `turn_duration` count drops to zero, or — on older transcripts — until a task notification
  or the agent's hand-back arrives.
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
