# 0003 — Discovery follows Claude's physical path encoding

- **Status:** Accepted
- **Date:** 2026-10-24

## Context

Claude stores transcripts under `<config>/projects/<encoded-cwd>/<session-id>.jsonl`, and the
encoding has several non-obvious properties:

- It encodes the physical path (realpath, NFC-normalized); the symlink path is not used.
- Every character outside `[A-Za-z0-9]` becomes `-`, not just separators and dots.
- A directory name longer than 200 characters is truncated and a six-character hash is
  appended, which Claude does not document.
- `CLAUDE_CONFIG_DIR` moves the profile. `CLAUDE_CODE_PROJECT_DIR_NAME` overrides the project
  directory name, but only alongside an explicit config directory.
- A session can be relocated, recorded in `relocated` / `relocatedCwd` entries.
- The same session can exist in more than one project directory.

## Decision

- Encode `canonicalPath()` (realpath plus NFC) and memoize it.
- Match project directories in one helper (`claudeProjectDirMatches`): exact for short paths, a
  `root-` prefix for repository roots, and a 200-character prefix for long paths. Verify the
  match against the session's parsed `cwd`.
- Deduplicate sessions by ID, keeping the newest; resolve one ID to the newest mtime across
  candidate files.
- Apply `relocatedCwd` when present.
- Canonicalize `CLAUDE_CONFIG_DIR`; warn for a relative value; honor
  `CLAUDE_CODE_PROJECT_DIR_NAME` only with an explicit config directory.

## Alternatives

- **Encode `path.resolve`.** Hides every session opened through a symlinked worktree, which is
  how many worktrees are opened.
- **Reproduce Claude's six-character hash.** Undocumented and brittle; a wrong guess fails the
  same way as no guess.
- **Accept any directory whose name starts with the encoded path.** Over-includes sibling
  directories that share a prefix, so the `cwd` filter remains necessary.
- **Trust the directory name over the transcript.** The parsed `cwd` is the source of truth.

## Consequences

- Symlinked worktrees, unicode paths, and paths with spaces discover their sessions.
- If Claude changes the long-path format, discovery degrades to no sessions for those paths.
  A test pins the current shape.
- A relative `CLAUDE_CONFIG_DIR` cannot be resolved per worktree; it is used as given and the
  user is warned.
- Resolving duplicates costs one `stat` per candidate file.
