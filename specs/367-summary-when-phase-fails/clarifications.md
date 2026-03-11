# Clarifications for #367 — Phase-loop should clean working tree after phase failure or timeout

## Batch 1 — 2026-03-11

### Q1: WIP Commit Push for Non-Implement Phases
**Context**: The spec assumes `commitPushAndEnsurePr()` can be reused for WIP commits on non-implement phase failures (Assumption 3). This function both commits AND pushes to remote, and may create/update a PR. For the implement phase this makes sense — partial code progress is valuable. But for phases like `clarify` or `plan`, pushing WIP state (e.g., a half-written `clarifications.md`) to remote could pollute the branch with unintended commits visible in the PR.
**Question**: Should WIP commits from failed non-implement phases (clarify, plan, specify) be pushed to remote via `commitPushAndEnsurePr()`, or should they only be committed locally before hard cleanup?
**Options**:
- A: Push all WIP commits to remote (reuse `commitPushAndEnsurePr()` for all phases)
- B: Only push WIP for implement phase; for other phases, commit locally then discard (or skip WIP entirely and go straight to hard cleanup)
- C: Push all, but use a distinct branch prefix or commit message convention so reviewers can identify auto-cleanup WIP

**Answer**: *Pending*

### Q2: Success-Path Safety Net
**Context**: The spec targets cleanup for failure/timeout paths only (US1, FR-001). However, there could be edge cases where a phase completes successfully but still leaves dirty state — for example, if `commitPushAndEnsurePr()` commits some but not all changes, or if the phase creates temporary files outside the commit scope. The companion fix #366 already adds defensive cleanup in `repo-checkout.ts` `updateRepo()`, so there is a defense-in-depth layer at checkout time.
**Question**: Should the phase-loop also run cleanup (or at least a dirty-state check with warning log) after successful phase completion as a defense-in-depth measure? Or rely on #366's checkout-time cleanup for any successful-phase edge cases?
**Options**:
- A: Run cleanup after ALL phase completions (success, failure, timeout) — maximum safety
- B: Only run cleanup on failure/timeout; rely on #366 for success-path edge cases — simpler, less noise
- C: After success, only log a warning if dirty state is detected (no cleanup action) — observability without intervention

**Answer**: *Pending*
