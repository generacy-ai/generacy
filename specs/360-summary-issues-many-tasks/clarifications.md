# Clarifications for #360: Task Chunking with Session Restart for Large Task Lists

## Batch 1 — 2026-03-10

### Q1: Double-Commit at Increment Boundary
**Context**: The spec shows the implement operation committing progress (`git add -A` + `git commit`) at the increment boundary, AND the phase loop also calls `prManager.commitPushAndEnsurePr(phase)` after detecting `partial: true`. This would produce two commits per increment boundary — one from the operation and one from the phase loop.
**Question**: Should only one component commit at the increment boundary? Should the implement operation skip the commit (leaving it entirely to the phase loop), or should the phase loop skip the extra commit when it detects `partial: true`?
**Options**:
- A: Implement operation commits at boundary; phase loop skips `commitPushAndEnsurePr` when `partial: true`
- B: Implement operation does NOT commit; phase loop always handles commit/push via `commitPushAndEnsurePr`
- C: Both commit (intentional double-commit for safety)

**Answer**: *Pending*

---

### Q2: Parallel Batch at Increment Boundary
**Context**: FR-004 says parallel task batches count as number-of-tasks-in-batch toward the increment limit, but doesn't specify behavior when a batch would exceed the limit (e.g., 8 tasks done + parallel batch of 5 = 13 > limit of 10).
**Question**: When encountering a parallel batch that would push `tasksThisIncrement` over `MAX_TASKS`, should the operation (a) complete the full batch before stopping, (b) skip the entire batch and stop immediately, or (c) something else?
**Options**:
- A: Complete the full batch even if it exceeds the limit (simplest, batch stays atomic)
- B: Skip the batch entirely and stop — run it as the first batch of the next increment
- C: Run partial batch up to the limit (complex, may break parallel semantics)

**Answer**: *Pending*

---

### Q3: Stage Comment Update Responsibility
**Context**: US2 AC and the main AC both state "Stage comment reflects incremental progress" and "Stage comment is updated after each increment boundary." However, neither code snippet in the spec shows how or where this update happens.
**Question**: Which component is responsible for updating the stage comment to show incremental progress — the implement operation (before returning `partial: true`) or the phase loop (after detecting `partial: true`)? And what format should the progress update use?

**Answer**: *Pending*

---

### Q4: Infinite Loop Protection in Phase Loop
**Context**: The phase loop uses `i--; continue` to re-invoke the implement phase when `partial: true`. If the implement phase keeps returning `partial: true` without completing any new tasks (e.g., all remaining tasks consistently fail), this becomes an infinite loop.
**Question**: Should the phase loop include a guard against runaway re-invocations (e.g., max re-invocation count, or check that `tasks_remaining` is decreasing)? Or is this handled by existing error/retry logic?
**Options**:
- A: Add a max re-invocation limit (e.g., `maxIncrements = ceil(totalTasks / MAX_TASKS) + 1`)
- B: Check that `tasks_remaining` decreased between invocations; fail if no progress
- C: No guard needed — existing task failure handling will surface errors naturally

**Answer**: *Pending*
