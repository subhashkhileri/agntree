# Changelog

All notable changes to Agntree will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
