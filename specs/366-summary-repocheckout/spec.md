# Feature Specification: ## Summary

`RepoCheckout

**Branch**: `366-summary-repocheckout` | **Date**: 2026-03-10 | **Status**: Draft

## Summary

## Summary

`RepoCheckout.updateRepo()` in `packages/orchestrator/src/worker/repo-checkout.ts` fails when the working tree has uncommitted changes, because `git checkout` throws before `git reset --hard` is reached.

## Impact

After a stop/start of the cluster, **every worker** that had leftover dirty state from a previous run fails to check out the target branch. Items are retried 3 times and then dead-lettered. Observed on 2026-03-10 where workers 1, 4, and 5 all had dirty `generacy` repos blocking issue processing (#358, #359, #360 all dead-lettered).

## Root Cause

In `updateRepo()` (lines 185-219):

```typescript
// Line 198-208: This throws if there are dirty changes
try {
  await execFileAsync('git', ['checkout', branch], { cwd: checkoutPath });
} catch {
  await execFileAsync('git', ['checkout', '-B', branch, `origin/${branch}`], {
    cwd: checkoutPath,
  });
}

// Line 211: This would fix the state, but is never reached
await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], {
  cwd: checkoutPath,
});
```

Both `git checkout` and `git checkout -B` fail when uncommitted changes would be overwritten. The `reset --hard` that follows would clean the state, but the error propagates before it runs.

## How Dirty State Accumulates

1. **Clarify phase**: modifies `clarifications.md` but doesn't commit when gate condition "on-questions" is not met
2. **Implement phase timeout**: kills the Claude process, leaving uncommitted implementation changes
3. **Phase errors**: partial changes from any phase remain in the working tree

## Fix

Add `git reset --hard HEAD` + `git clean -fd` **before** the branch switch in `updateRepo()`. Use `-fd` (not `-fdx`) — gitignored files like `node_modules/` don't block checkout and removing them would cause unnecessary reinstalls:

```typescript
private async updateRepo(checkoutPath: string, branch: string): Promise<void> {
  // Discard any leftover dirty state from previous worker runs
  await execFileAsync('git', ['reset', '--hard', 'HEAD'], { cwd: checkoutPath });
  await execFileAsync('git', ['clean', '-fd'], { cwd: checkoutPath });

  await execFileAsync('git', ['fetch', 'origin'], { cwd: checkoutPath });
  // ... rest of checkout logic
}
```

The same fix should be applied to `switchBranch()` (lines 102-121), which has the identical pattern.

## Also Affected: `generacy setup workspace`

`packages/generacy/src/cli/commands/setup/workspace.ts` `cloneOrUpdateRepo()` (line 192-196) only cleans if `--clean` flag is passed. The bootstrap script (`bootstrap-worker.sh`) doesn't pass `--clean`.

**Decision**: Add `--clean` to `bootstrap-worker.sh`'s `generacy setup workspace` calls. This ensures workers always start fresh. Making `cloneOrUpdateRepo` always-clean would be too aggressive for non-worker contexts.

## Files

- `packages/orchestrator/src/worker/repo-checkout.ts` — `updateRepo()` and `switchBranch()`
- `packages/generacy/src/cli/commands/setup/workspace.ts` — `cloneOrUpdateRepo()`
- `/workspaces/tetrad-development/.devcontainer/bootstrap-worker.sh` — doesn't pass `--clean`

## User Stories

### US1: Dirty Working Tree Recovery

**As a** worker process,
**I want** to successfully check out a branch even when the working tree has uncommitted changes from a previous run,
**So that** issues are processed without dead-lettering due to stale dirty state.

**Acceptance Criteria**:
- [ ] `updateRepo()` calls `git reset --hard HEAD` and `git clean -fd` before `git checkout`
- [ ] `switchBranch()` calls `git reset --hard HEAD` and `git clean -fd` before `git checkout`
- [ ] `bootstrap-worker.sh` passes `--clean` to `generacy setup workspace` calls
- [ ] New unit tests verify `reset` and `clean` are called before `checkout` in both `updateRepo()` and `switchBranch()`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `updateRepo()` must discard dirty state with `git reset --hard HEAD` + `git clean -fd` before branch switch | P1 | |
| FR-002 | `switchBranch()` must discard dirty state with `git reset --hard HEAD` + `git clean -fd` before branch switch | P1 | |
| FR-003 | `bootstrap-worker.sh` must pass `--clean` to `generacy setup workspace` | P2 | Add flag to bootstrap script only |
| FR-004 | New unit tests must verify `reset` + `clean` are called before `checkout` in both `updateRepo()` and `switchBranch()` | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Workers with dirty repos successfully checkout target branch | 100% | Manual test with dirty repo |
| SC-002 | Existing tests pass | 100% | `pnpm test` |
| SC-003 | New dirty-state tests pass | 100% | `pnpm test` in orchestrator package |

## Assumptions

- `git clean -fd` (without `-x`) is sufficient — gitignored files like `node_modules/` do not block `git checkout`
- `cloneOrUpdateRepo()` in `workspace.ts` itself does not need code changes — only the bootstrap flag needs updating

## Out of Scope

- Making `cloneOrUpdateRepo()` always-clean regardless of `--clean` flag (too aggressive for non-worker contexts)
- Cleaning gitignored files with `-fdx` (unnecessary performance cost)

---

*Generated by speckit*
