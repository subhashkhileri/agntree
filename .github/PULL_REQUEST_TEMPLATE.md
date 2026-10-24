## Summary

<!-- Brief description of what this PR does -->

## Changes

<!-- List the key changes -->
-

## Type

- [ ] Bug fix
- [ ] New feature
- [ ] New agent support
- [ ] Refactoring
- [ ] Documentation
- [ ] Other

## Testing

<!-- How was this tested? -->
- [ ] Ran `npm run typecheck` with no errors
- [ ] Ran `npm run test:dry` (all passing)
- [ ] Ran `npm run test:integration` (when commands, menus, settings, or activation changed)
- [ ] Tested in Extension Development Host (F5)
- [ ] Tested on VS Code
- [ ] Tested on Cursor (if applicable)

## Checklist

- [ ] Code follows the project's working agreement in [AGENTS.md](../AGENTS.md)
- [ ] Reviewed the diff for duplicated mechanisms or invariants, unbounded caches, unowned
      lifetimes, dead code, and sleeps in tests ([guide](../AGENTS.md#reviewing-your-own-diff))
- [ ] No harness conditionals outside `src/harnesses/` or per-harness watchers
- [ ] No new lint/type errors or diagnostics
- [ ] Extension activates without errors
- [ ] State persists correctly across restarts (if applicable)
- [ ] `CHANGELOG.md` and relevant docs are updated
