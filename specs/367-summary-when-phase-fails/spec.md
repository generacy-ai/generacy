# Phase-loop should clean working tree after phase failure or timeout

**Branch**: `367-summary-when-phase-fails` | **Date**: 2026-03-11 | **Status**: Draft

## Summary

When a phase fails or times out, the working tree is left dirty. The phase-loop commits partial progress for the `implement` phase specifically, but other phases (e.g., `clarify`) can also leave uncommitted changes. These dirty files block subsequent checkout operations on the same worker.

## Impact

On 2026-03-10, all 5 workers had dirty state across multiple repos:

| Worker | Repo | Dirty Files | Cause |
|--------|------|-------------|-------|
| 1 | generacy | clarifications.md | Clarify phase leftover |
| 1 | generacy-cloud | 7 files | Implement timeout (#133) |
| 2 | agency | 2 implement.md files | Implement phase |
| 3 | generacy-cloud | 8 files + 1 untracked | Implement phase |
| 4 | generacy-cloud, generacy | clarifications.md files | Clarify phase |
| 5 | generacy-cloud, generacy | 12 files + 2 untracked | Implement + clarify |

## Root Cause

The `clarify` phase modifies `clarifications.md` via the Claude CLI, but when the gate condition `on-questions` is not met (no pending clarifications), the file is never committed. The orchestrator's `commitPushAndEnsurePr()` only runs after a successful phase (line 302 of `phase-loop.ts`), and for the clarify phase it runs — but if the clarifications file was modified without being staged, `git diff` may not detect it as a "change" depending on the commit logic.

For the `implement` phase, timeouts kill the Claude process (SIGTERM), and while the retry logic does attempt `commitPushAndEnsurePr()`, if the timeout handler doesn't catch all cases or if the working tree has untracked files, they persist.

## Related

- #366 — `updateRepo()` should clean dirty state before checkout (companion fix, defensive cleanup on checkout side)

## Files

- `packages/orchestrator/src/worker/phase-loop.ts` — main fix location
- `packages/orchestrator/src/worker/repo-checkout.ts` — already has cleanup logic that can be referenced

## User Stories

### US1: Worker recovers from phase failure without manual intervention

**As a** platform operator,
**I want** the phase-loop to automatically clean the working tree after any phase failure or timeout,
**So that** workers can continue processing the next item without manual cleanup of dirty git state.

**Acceptance Criteria**:
- [ ] After a phase fails, the working tree is clean (no modified, staged, or untracked files)
- [ ] After a phase times out, the working tree is clean
- [ ] Partial progress from `implement` phase failures is still committed before cleanup
- [ ] Cleanup works for all phase types (clarify, plan, implement, etc.)
- [ ] No worker requires manual intervention to recover from dirty state

### US2: Phase failure changes are preserved when possible

**As a** developer reviewing feature progress,
**I want** partial changes from failed phases to be committed as WIP when meaningful,
**So that** progress is not lost and I can see what the agent attempted.

**Acceptance Criteria**:
- [ ] Implement phase failures still commit partial progress (existing behavior preserved)
- [ ] Non-implement phases with dirty state commit changes as WIP before cleanup
- [ ] If WIP commit fails, the working tree is still cleaned (discard as fallback)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a `finally` block or cleanup step after phase execution that ensures working tree is clean | P1 | Core fix |
| FR-002 | Before discarding, attempt to commit dirty state as WIP with descriptive message | P2 | Preserves partial progress |
| FR-003 | Cleanup must handle both tracked modified files and untracked files | P1 | Use `git add -A` + `git reset --hard` + `git clean -fd` pattern |
| FR-004 | Cleanup must not interfere with the existing implement-phase retry logic | P1 | Retry path already calls `commitPushAndEnsurePr()` |
| FR-005 | Log when dirty state is detected and cleaned up for observability | P2 | Helps diagnose recurring issues |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Workers with dirty state after phase failure | 0 | Monitor worker checkouts over 24h |
| SC-002 | Manual worker interventions needed | 0 per week | Ops log review |
| SC-003 | Partial progress preserved on implement failures | 100% | Check WIP commits exist on failed implement phases |

## Assumptions

- The `repo-checkout.ts` cleanup in #366 provides a complementary defense-in-depth fix, but this fix addresses the root cause in the phase-loop itself
- `git reset --hard HEAD` + `git clean -fd` is safe to run after phase completion since all meaningful changes should have been committed by `commitPushAndEnsurePr()`
- The existing `commitPushAndEnsurePr()` function can be reused for WIP commits on non-implement phase failures

## Out of Scope

- Changes to the CLI spawner timeout mechanism itself
- Modifications to `repo-checkout.ts` (covered by #366)
- Retry logic for non-implement phases
- Root cause fix for why `clarify` phase modifies files without committing them

---

*Generated by speckit*
