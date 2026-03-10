# Clarifications: Worker Repo Checkout Dirty State Fix (#366)

## Batch 1 — 2026-03-10

### Q1: workspace.ts / bootstrap Scope

**Context**: The "Fix" section and P1 requirements (FR-001, FR-002) only address `repo-checkout.ts`. `workspace.ts` and `bootstrap-worker.sh` appear under "Also Affected" with FR-003 marked P2 — but no decision is made between the two offered approaches. The observed dead-lettered issues (#358, #359, #360) were caused by `repo-checkout.ts`, not `workspace.ts`.

**Question**: Should changes to `workspace.ts` / `bootstrap-worker.sh` be included in this implementation, or is the fix limited to `repo-checkout.ts`?

**Options**:
- A: Fix only `repo-checkout.ts` (FR-001 + FR-002 only; treat FR-003 as out-of-scope for this issue)
- B: Also address FR-003 — add `--clean` to `bootstrap-worker.sh`'s `generacy setup workspace` calls
- C: Also address FR-003 — make `cloneOrUpdateRepo()` in `workspace.ts` always-clean (ignore the flag)

**Answer**: *Pending*

---

### Q2: Test Coverage for Dirty-State Scenarios

**Context**: Existing tests in `repo-checkout.test.ts` cover the happy path and the "local branch not found" fallback, but there are no tests that simulate dirty state causing `git checkout` to throw. SC-002 says "Existing tests pass" but doesn't explicitly require new tests.

**Question**: Should new unit tests be added to cover the dirty-state recovery path (i.e., `git reset --hard HEAD` and `git clean -fd` are called before the branch switch)?

**Options**:
- A: No — rely on SC-002 (existing tests are sufficient; the fix is trivial enough)
- B: Yes — add tests verifying `reset` and `clean` are called before `checkout` in both `updateRepo()` and `switchBranch()`

**Answer**: *Pending*

---

### Q3: Handling Untracked Ignored Files (`git clean` Flags)

**Context**: The spec proposes `git clean -fd`, which removes untracked files/directories but leaves gitignored files in place. In practice, `git checkout` only fails when tracked files have modifications, so gitignored files wouldn't trigger the bug. However, `-fdx` (also clean gitignored) is sometimes used for a fully pristine state.

**Question**: Is `git clean -fd` (untracked only) sufficient, or should `-fdx` be used to also remove gitignored build artifacts?

**Options**:
- A: `-fd` is sufficient — gitignored files don't block checkout
- B: Use `-fdx` to ensure a fully clean state (more aggressive but safer)

**Answer**: *Pending*
