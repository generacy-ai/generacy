# Implementation Plan: Task Chunking with Session Restart for Large Task Lists

**Feature**: Break large implementations (>10 tasks) into ~8-10 task increments per Claude session
**Branch**: `360-summary-issues-many-tasks`
**Status**: Complete

## Summary

When an implementation has many tasks, the Claude CLI session accumulates context until it exhausts the context window before all tasks complete. This feature adds increment boundary logic: after completing N tasks, the implement operation returns `partial: true`, the orchestrator phase loop commits/pushes progress and re-invokes with a fresh session. The existing task idempotency (`[X]` markers in tasks.md) ensures already-completed tasks are skipped on restart.

## Technical Context

- **Language**: TypeScript (strict mode)
- **Package Manager**: pnpm (monorepo)
- **Key packages**:
  - `packages/workflow-engine` — implement operation, action types
  - `packages/orchestrator` — phase loop, CLI spawner, output capture
  - `agency` repo: `packages/agency-plugin-spec-kit` — Claude CLI `/implement` command

## Architecture Overview

```
implement.ts          implement.md             cli-spawner.ts / output-capture.ts      phase-loop.ts
─────────────         ─────────────            ──────────────────────────────────      ─────────────
executeImplement()    /implement command        manageProcess()                         executeLoop()
  │                     │                         │                                       │
  ├─ track counter       ├─ call speckit.implement  ├─ parse SPECKIT_IMPLEMENT_PARTIAL      ├─ check result.implementResult?.partial
  ├─ limit reached?      ├─ if partial:             │   sentinel from text chunks           ├─ if partial: commitPush, clear session
  └─ return partial:true │   output sentinel        └─ populate PhaseResult.implementResult ├─ guard: tasks_remaining decreased?
                         └─ else: normal completion                                         └─ i--; continue (re-invoke)
```

## File Changes

### 1. `packages/workflow-engine/src/actions/builtin/speckit/types.ts`

**ImplementInput**: add `max_tasks_per_increment?: number`
**ImplementOutput**: add `partial?: boolean`, `tasks_remaining?: number`

### 2. `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`

- Read `MAX_TASKS = input.max_tasks_per_increment ?? 10`
- Track `tasksThisIncrement` counter (incremented after each sequential task or after an entire parallel batch)
- Before executing each sequential task or parallel batch: check `tasksThisIncrement >= MAX_TASKS`; if so, return early with `partial: true`
- Parallel batches are atomic: check limit **before** starting the batch; if batch would start when limit is already reached, stop (do not split batch). If batch was already started and completes over the limit, that's OK — batch is atomic.
- No commit inside implement operation (per clarification Q1 Answer B — phase loop owns commits via `commitPushAndEnsurePr`)

### 3. `packages/orchestrator/src/worker/types.ts`

**PhaseResult**: add `implementResult?: ImplementPartialResult`

```typescript
export interface ImplementPartialResult {
  partial?: boolean;
  tasks_completed?: number;
  tasks_remaining?: number;
  tasks_total?: number;
}
```

### 4. `packages/orchestrator/src/worker/output-capture.ts`

Add private `_implementResult: ImplementPartialResult | undefined` field.

In `parseLine`, scan `text` chunks for the sentinel:
```
SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":8,"tasks_remaining":5,"tasks_total":13}
```

Expose via getter `implementResult`: returns `_implementResult`.

### 5. `packages/orchestrator/src/worker/cli-spawner.ts`

After building `result` in `manageProcess`, populate `result.implementResult = capture?.implementResult`.

### 6. `packages/orchestrator/src/worker/phase-loop.ts`

After a successful implement phase (exit code 0), before step 5 (commit/push):

```typescript
// Increment boundary: re-invoke with fresh session if partial
if (phase === 'implement' && result.implementResult?.partial) {
  const tasksRemaining = result.implementResult.tasks_remaining ?? 0;

  // Guard: fail if no progress made (prevents infinite loop — per clarification Q4 Answer B)
  if (lastTasksRemaining !== undefined && tasksRemaining >= lastTasksRemaining) {
    // No progress — fail
    this.logger.error({ phase, tasksRemaining, lastTasksRemaining },
      'Implement increment made no progress — failing to prevent infinite loop');
    await labelManager.onError(phase);
    // update stage comment as error ...
    return { results, completed: false, lastPhase: phase, gateHit: false };
  }
  lastTasksRemaining = tasksRemaining;

  // Commit, push, ensure PR
  const { prUrl: partialPrUrl } = await prManager.commitPushAndEnsurePr(phase, {
    message: `wip(speckit): implement increment for #${context.item.issueNumber} (${result.implementResult.tasks_completed} tasks done, ${tasksRemaining} remaining)`,
  });
  if (partialPrUrl) context.prUrl = partialPrUrl;

  // Fresh session for next increment
  currentSessionId = undefined;

  // Update stage comment with incremental progress
  await stageCommentManager.updateStageComment({
    stage,
    status: 'in_progress',
    phases: this.buildPhaseProgress(sequence, startIndex, i, phaseTimestamps, 'in_progress'),
    startedAt: phaseTimestamps.get(sequence[startIndex]!)?.startedAt ?? new Date().toISOString(),
    prUrl: context.prUrl,
    // progress detail surfaced via phases info
  });

  this.logger.info({ tasksRemaining }, 'Implement increment complete — re-invoking with fresh session');
  i--;  // Re-run implement phase
  continue;
}
```

Track `lastTasksRemaining: number | undefined` variable in the loop scope (reset to `undefined` when not in implement phase, or just carry it through — it only matters for the implement phase).

### 7. `/workspaces/agency/packages/agency-plugin-spec-kit/commands/implement.md`

Add a **Task Increment Boundaries** note to the command documentation explaining:
- When >10 tasks exist, the operation pauses after ~10 tasks to commit and restart with fresh context
- Already-completed tasks are skipped on restart (idempotent)
- When a partial result is received, output the sentinel marker `SPECKIT_IMPLEMENT_PARTIAL: {...}`

## Clarification Decisions (from clarifications.md)

| Question | Decision |
|----------|----------|
| Q1: Who commits at boundary? | Phase loop via `commitPushAndEnsurePr` (not implement operation) |
| Q2: Parallel batch at boundary? | Complete the full batch atomically, even if it exceeds limit |
| Q3: Stage comment update? | Phase loop updates; uses `tasks_completed` and `tasks_total` from partial result |
| Q4: Infinite loop guard? | Check `tasks_remaining` decreased; fail if no progress |

## Sentinel Communication Protocol

The implement operation cannot directly signal the phase loop — it communicates through the Claude CLI text output. The `implement.md` command checks the MCP result for `partial: true` and outputs:

```
SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":8,"tasks_remaining":5,"tasks_total":13}
```

`output-capture.ts` scans text chunks for this exact prefix and parses the JSON. This sentinel is only output when `partial: true`; normal completions produce no sentinel and `result.implementResult` remains undefined.

## Test Considerations

- Unit tests for `parseTasks` increment logic in `implement.ts`
- Unit tests for sentinel parsing in `output-capture.ts`
- Integration test for `phase-loop.ts` re-invocation with mock `partial: true` result
- Edge cases: `tasks_remaining = 0` on first call (all tasks done in one increment — no re-invoke), parallel batch exactly at limit (complete batch first), zero progress guard triggers correctly

## Suggested Next Step

Run `/speckit:tasks` to generate the task list from this plan.
