# Feature Specification: Worker Repo Checkout Dirty State Fix

**Branch**: `366-summary-repocheckout` | **Date**: 2026-03-10 | **Status**: Draft

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

Add `git reset --hard HEAD` + `git clean -fd` **before** the branch switch in `updateRepo()`:

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

`packages/generacy/src/cli/commands/setup/workspace.ts` `cloneOrUpdateRepo()` (line 192-196) only cleans if `--clean` flag is passed. The bootstrap script (`bootstrap-worker.sh`) doesn't pass `--clean`. Either:
- Always clean in worker mode (add `--clean` to bootstrap), or
- Make `updateRepo` defensive regardless of flag

## Files

- `packages/orchestrator/src/worker/repo-checkout.ts` — `updateRepo()` and `switchBranch()`
- `packages/generacy/src/cli/commands/setup/workspace.ts` — `cloneOrUpdateRepo()`
- `/workspaces/tetrad-development/.devcontainer/bootstrap-worker.sh` — doesn't pass `--clean`

## User Stories

### US1: Resilient worker restart after dirty repo state

**As a** platform operator,
**I want** workers to automatically recover from dirty repo state on startup,
**So that** issues are not dead-lettered after a cluster stop/start due to leftover uncommitted changes.

**Acceptance Criteria**:
- [ ] Worker successfully checks out its target branch even when the working tree has uncommitted changes
- [ ] `updateRepo()` discards dirty state before attempting branch switch
- [ ] `switchBranch()` discards dirty state before attempting branch switch

### US2: Bootstrap script produces clean worker repos

**As a** platform operator,
**I want** worker bootstrap to always start with a clean repo,
**So that** workers begin each session in a known-good state without manual intervention.

**Acceptance Criteria**:
- [ ] `bootstrap-worker.sh` produces a clean working tree
- [ ] Worker repos do not carry stale changes across cluster restarts

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `updateRepo()` must run `git reset --hard HEAD` and `git clean -fd` before any branch switch | P1 | Fixes the primary bug |
| FR-002 | `switchBranch()` must run `git reset --hard HEAD` and `git clean -fd` before any branch switch | P1 | Same pattern as `updateRepo()` |
| FR-003 | Bootstrap script must produce a clean working tree (either via `--clean` flag or always-clean logic) | P2 | Prevents dirty state from persisting across cluster restarts |
| FR-004 | The fix must not discard intentional staged changes in non-worker contexts | P2 | Only relevant in worker execution context |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Worker checkout success rate after cluster restart | 100% | No dead-lettered items due to dirty repo state |
| SC-002 | Regression: checkout still works on clean repos | 100% pass | Existing tests pass |
| SC-003 | Dirty state scenario handled without retries | 0 retries for dirty-state failures | Worker logs show no checkout errors |

## Assumptions

- Workers do not need to preserve uncommitted changes between runs — all meaningful work is committed before phase completion
- `git reset --hard HEAD` is safe to call even on a clean working tree
- The fix applies to both `updateRepo()` and `switchBranch()` identically

## Out of Scope

- Fixing the root causes that create dirty state (clarify phase not committing, implement phase timeout leaving changes)
- Changes to how phases commit their work
- Worker state persistence across restarts beyond repo cleanliness

---

*Generated by speckit*
