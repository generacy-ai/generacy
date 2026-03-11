# Clarifications for #360: Task Chunking with Session Restart for Large Task Lists

## Batch 1 — 2026-03-10

### Q1: Double-Commit at Increment Boundary
**Context**: The spec shows the implement operation committing progress (`git add -A` + `git commit`) at the increment boundary, AND the phase loop also calls `prManager.commitPushAndEnsurePr(phase)` after detecting `partial: true`. This would produce two commits per increment boundary — one from the operation and one from the phase loop.
**Question**: Should only one component commit at the increment boundary? Should the implement operation skip the commit (leaving it entirely to the phase loop), or should the phase loop skip the extra commit when it detects `partial: true`?
**Options**:
- A: Implement operation commits at boundary; phase loop skips `commitPushAndEnsurePr` when `partial: true`
- B: Implement operation does NOT commit; phase loop always handles commit/push via `commitPushAndEnsurePr`
- C: Both commit (intentional double-commit for safety)

**Answer**: B** — Implement operation does NOT commit at the boundary; phase loop handles it via `commitPushAndEnsurePr`.

This matches the existing architecture. The implement operation already commits per-task (~every 3 tasks). `commitPushAndEnsurePr` is the safety-net that catches remaining uncommitted changes, ensures the PR, and pushes. The retry-after-failure path already uses this same pattern. Adding a separate boundary commit in the implement operation would be redundant and break the established responsibility boundary.

---

---

### Q2: Parallel Batch at Increment Boundary
**Context**: FR-004 says parallel task batches count as number-of-tasks-in-batch toward the increment limit, but doesn't specify behavior when a batch would exceed the limit (e.g., 8 tasks done + parallel batch of 5 = 13 > limit of 10).
**Question**: When encountering a parallel batch that would push `tasksThisIncrement` over `MAX_TASKS`, should the operation (a) complete the full batch before stopping, (b) skip the entire batch and stop immediately, or (c) something else?
**Options**:
- A: Complete the full batch even if it exceeds the limit (simplest, batch stays atomic)
- B: Skip the batch entirely and stop — run it as the first batch of the next increment
- C: Run partial batch up to the limit (complex, may break parallel semantics)

**Answer**: A** — Complete the full batch even if it exceeds the limit (batch stays atomic).

The increment limit is a soft guideline for context management, not a hard cap. Overshooting by a few tasks is simpler and safer than splitting or deferring a parallel batch. Parallel execution is currently parsed but not implemented (`[P]` marker captured but unused), so this is forward-looking. Keeping batches atomic avoids complex partial-batch logic that could break parallel semantics.

---

---

### Q3: Stage Comment Update Responsibility
**Context**: US2 AC and the main AC both state "Stage comment reflects incremental progress" and "Stage comment is updated after each increment boundary." However, neither code snippet in the spec shows how or where this update happens.
**Question**: Which component is responsible for updating the stage comment to show incremental progress — the implement operation (before returning `partial: true`) or the phase loop (after detecting `partial: true`)? And what format should the progress update use?

**Answer**: The phase loop** updates the stage comment, consistent with existing patterns.

All stage comment updates currently flow through `StageCommentManager` owned by the phase loop. The implement operation has no access to it. After detecting `partial: true`, the phase loop should update the implement phase row to reflect increment progress (e.g., using `tasks_completed` and `tasks_total` from the partial result).

---

---

### Q4: Infinite Loop Protection in Phase Loop
**Context**: The phase loop uses `i--; continue` to re-invoke the implement phase when `partial: true`. If the implement phase keeps returning `partial: true` without completing any new tasks (e.g., all remaining tasks consistently fail), this becomes an infinite loop.
**Question**: Should the phase loop include a guard against runaway re-invocations (e.g., max re-invocation count, or check that `tasks_remaining` is decreasing)? Or is this handled by existing error/retry logic?
**Options**:
- A: Add a max re-invocation limit (e.g., `maxIncrements = ceil(totalTasks / MAX_TASKS) + 1`)
- B: Check that `tasks_remaining` decreased between invocations; fail if no progress
- C: No guard needed — existing task failure handling will surface errors naturally

**Answer**: B** — Check that `tasks_remaining` decreased between invocations; fail if no progress.

This directly measures forward progress, which is the actual invariant we care about. Option A (max limit) is fragile for varying task counts. Option C (no guard) is dangerous — if remaining tasks consistently fail without erroring the phase, you get an infinite loop. This mirrors how existing retry logic checks `hasChanges` before allowing a retry — same principle, only re-invoke if the previous increment made progress.
