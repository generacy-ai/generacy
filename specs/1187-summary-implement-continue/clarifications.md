# Clarifications

## Batch 2026-08-24

### Q1: Sentinel authority vs tasks.md
**Context**: FR-001 gates the fallback on `result.implementResult === undefined`, so it never fires when the sentinel is present. But the Summary ("tasks.md becomes the source of truth for whether the implement phase is actually complete") and US2's acceptance criterion ("advances only when tasks.md has zero unchecked tasks") imply tasks.md should override even a present sentinel. These conflict when the agent emits a sentinel reporting completion (partial=false) while tasks.md still has unchecked `- [ ]` tasks.
**Question**: When the sentinel is present and reports the implement complete but tasks.md still has unchecked tasks, should the engine trust the sentinel and advance, or re-enter implement?
**Options**:
- A: Trust sentinel — fallback only runs when the sentinel is ABSENT (matches FR-001's `=== undefined` gate and SC-005 byte-identical). A present sentinel stays authoritative.
- B: tasks.md always wins — re-enter whenever tasks.md has unchecked tasks regardless of the sentinel (matches US2 and the Summary). Closes the honesty hole but changes sentinel-present behavior.

**Answer**: — Sentinel authority vs tasks.md
FR-001 only runs the fallback when the sentinel is **absent** (`implementResult === undefined`), but the Summary and US2 say tasks.md is the true source of truth for completion. When the agent emits a sentinel reporting **complete** yet tasks.md still has unchecked tasks:
- **A**: Trust the sentinel and advance (fallback runs only when sentinel absent; SC-005 byte-identical).
- **B**: tasks.md always wins — re-enter whenever unchecked tasks remain, regardless of the sentinel (closes the honesty hole, changes sentinel-present behavior).

### Q2: No-progress guard count source
**Context**: The no-progress guard (`phase-loop.ts:877`) compares `tasks_remaining` across two increments. Sentinel increments feed the agent's self-reported `tasks_remaining`; fallback increments would feed the tasks.md unchecked count. These two numbers can differ, so a run mixing sentinel and fallback increments may compare across incompatible sources, risking a false abort or a missed abort.
**Question**: Should the guard always source `tasks_remaining` from the tasks.md unchecked count on both paths, or keep each path's own source?
**Options**:
- A: tasks.md count for both — derive the guard's `tasks_remaining` from the tasks.md unchecked count on both paths for apples-to-apples comparison (slightly changes the sentinel path's guard input; SC-005 caveat).
- B: Per-path source — sentinel self-report on sentinel increments, tasks.md count on fallback; preserves sentinel byte-identical behavior but a mixed run may compare across sources.

**Answer**: — No-progress guard count source
The guard compares `tasks_remaining` across two increments. Sentinel increments use the agent's self-reported count; fallback increments would use the tasks.md unchecked count — mixing them can misfire.
- **A**: Derive the guard's count from tasks.md on **both** paths (apples-to-apples; slight change to sentinel path input).
- **B**: Keep each path's own source (sentinel byte-identical; mixed runs may compare across sources).

### Q3: Absolute increment cap
**Context**: US3 references "maxImplementRetries-style limits," but today's increment loop (`phase-loop.ts:873–937`) enforces only the no-progress guard — there is no absolute cap on the number of increments. FR-002/FR-003 say to reuse that existing block.
**Question**: Should the fallback add an absolute maximum increment/iteration count, or rely solely on the existing no-progress guard?
**Options**:
- A: No absolute cap — rely only on the no-progress guard (unchanged from today); as long as the unchecked count decreases each round, keep re-entering until zero.
- B: Add absolute cap — enforce a maximum number of fallback increments; on exceed, fail with the no-progress-style escalation even if progress is being made.

**Answer**: — Absolute increment cap
Today's increment loop has only the no-progress guard — no absolute cap on increment count. US3 references "maxImplementRetries-style limits."
- **A**: No absolute cap — rely solely on the no-progress guard (matches "reuse existing block").
- **B**: Add an absolute max-increment cap; on exceed, fail/escalate even if progress is being made.

### Q4: FR-006 fail-open scope
**Context**: FR-006 fails open (advances) when tasks.md "cannot be located or read." FR-004 says advance when "no tasks.md / no task lines exist." It is unclear whether a tasks.md that is found but contains zero recognizable `- [ ]`/`- [x]` task lines should be treated as a legitimately task-less story (advance normally) or lumped in with error conditions, and how multiple/zero matching spec dirs are classified.
**Question**: How should the engine classify a found-but-taskless tasks.md, multiple matching spec dirs, and read/parse errors?
**Options**:
- A: Zero tasks = complete — tasks.md found with no task lines advances as a task-less story (per FR-004); only genuine I/O/parse failure or missing/ambiguous dir logs the FR-006 "cannot read" reason.
- B: Any ambiguity = fail-open — missing dir, multiple matching spec dirs, zero task lines, and read errors all fail open and log the FR-006 reason via one code path.

**Answer**: — FR-006 fail-open scope
How to classify a tasks.md that is **found but has zero task lines**, plus multiple/zero matching spec dirs and read errors?
- **A**: Zero task lines → advance as a task-less story (FR-004); only true I/O/parse failure or missing/ambiguous dir logs the FR-006 "cannot read" reason.
- **B**: Any ambiguity (missing dir, multiple matches, zero task lines, read error) → all fail open + log FR-006 via one path.
