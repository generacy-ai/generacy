# Feature Specification: Task Chunking with Session Restart for Large Task Lists

**Branch**: `360-summary-issues-many-tasks` | **Date**: 2026-03-10 | **Status**: Draft

## Summary

For issues with many tasks (>10), break implementation into increments of ~8-10 tasks per Claude session. After each increment, commit/push and re-invoke the implement phase with a fresh session. This prevents context exhaustion proactively rather than recovering from it after the fact.

## Background

Claude Code sessions have a finite context window. For large implementations, the accumulated context from reading spec files, implementing tasks, and tracking progress can exhaust the window before all tasks complete. This was observed on generacy-ai/generacy-cloud#133 (7 tasks, failed during test rewrites due to context exhaustion).

The implement operation already has idempotency — it skips tasks marked `[X]` in `tasks.md`. This means we can safely stop and restart with a fresh session, and it will pick up where it left off.

## Changes Required

### `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`

Add increment boundary logic:

```typescript
interface ImplementInput {
  // ... existing fields ...
  max_tasks_per_increment?: number; // Default: 10
}

interface ImplementOutput {
  // ... existing fields ...
  partial?: boolean;        // True if more tasks remain
  tasks_remaining?: number; // Count of tasks still pending
}
```

In the execution loop:

```typescript
const MAX_TASKS = input.max_tasks_per_increment ?? 10;
let tasksThisIncrement = 0;

for (const task of pendingTasks) {
  if (tasksThisIncrement >= MAX_TASKS) {
    context.logger.info(
      `Increment limit reached (${MAX_TASKS} tasks). Returning for fresh session.`
    );
    // Commit progress before returning
    await executeCommand('git', ['add', '-A'], { ... });
    await executeCommand('git', ['commit', '-m', 'feat: complete task increment', ...], { ... });
    await executeCommand('git', ['push'], { ... }).catch(() => {});
    
    return {
      success: true,
      partial: true,
      tasks_completed: completedTasks.length,
      tasks_total: tasks.length,
      tasks_remaining: pendingTasks.length - tasksThisIncrement,
      tasks_skipped: skippedTasks.length,
      files_modified: [...filesModified],
    };
  }
  
  // ... execute task ...
  tasksThisIncrement++;
}
```

### `packages/orchestrator/src/worker/phase-loop.ts`

Add re-invocation loop for partial results:

```typescript
// After successful phase completion, before marking complete:
if (phase === 'implement' && result.output?.partial) {
  await prManager.commitPushAndEnsurePr(phase);
  currentSessionId = undefined; // Fresh session for next increment
  this.logger.info(
    { tasksRemaining: result.output.tasks_remaining },
    'Implement phase returned partial — re-invoking with fresh session',
  );
  i--; // Re-run this phase index
  continue;
}
```

### `packages/agency-plugin-spec-kit/commands/implement.md`

Document the increment behavior:

> **Task Increment Boundaries**: When executing more than 10 tasks, implementation automatically pauses after every 10 completed tasks to commit progress and restart with a fresh context. This is transparent — already-completed tasks are skipped on restart. You do not need to manage this manually.

## Design Considerations

- **Increment size**: Default 10 tasks is a conservative choice. Could be tuned based on average task complexity. The config should be per-workflow-invocation.
- **Interaction with retry**: This is complementary to the retry-after-failure feature. Chunking prevents failures; retry recovers from them. Both use the same mechanism (fresh session + task idempotency).
- **Push frequency**: Each increment boundary always pushes, ensuring remote has latest progress.
- **Session ID**: Always clear `currentSessionId` at increment boundaries — fresh session gets fresh context.

## Acceptance Criteria

- [ ] Implement operation accepts `max_tasks_per_increment` parameter (default: 10)
- [ ] After completing N tasks, operation commits and returns `partial: true`
- [ ] Phase loop detects partial result and re-invokes with fresh session
- [ ] Already-completed tasks are skipped on re-invocation
- [ ] Process continues until all tasks complete or a real error occurs
- [ ] Works correctly with parallel task batches (batch counts as number-of-tasks-in-batch toward limit)
- [ ] Stage comment reflects incremental progress

## References

- Root cause analysis: generacy-ai/generacy-cloud#133
- Related: incremental commits issue, retry logic issue
- `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`
- `packages/orchestrator/src/worker/phase-loop.ts`
- `packages/agency-plugin-spec-kit/commands/implement.md`

## User Stories

### US1: Proactive context management for large implementations

**As a** workflow orchestrator running speckit implement phases,
**I want** implementation to automatically chunk into increments of ≤10 tasks per Claude session,
**So that** context exhaustion is prevented before it causes failures, rather than requiring recovery after the fact.

**Acceptance Criteria**:
- [ ] After completing 10 tasks, the implement operation commits progress and returns `partial: true`
- [ ] The phase loop detects `partial: true` and re-invokes with a fresh session
- [ ] Already-completed tasks (marked `[X]`) are skipped on re-invocation

### US2: Transparent incremental progress

**As a** developer monitoring a workflow run,
**I want** stage comments to reflect incremental progress across session boundaries,
**So that** I can see what has been completed even when the implementation spans multiple sessions.

**Acceptance Criteria**:
- [ ] Stage comment is updated after each increment boundary
- [ ] Comment shows tasks_completed / tasks_total counts

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement operation accepts `max_tasks_per_increment` parameter (default: 10) | P1 | Per-invocation config |
| FR-002 | When task count reaches limit, operation commits progress and returns `partial: true` with `tasks_remaining` count | P1 | Uses existing git commit/push logic |
| FR-003 | Phase loop detects `partial: true` on implement result and re-invokes with `currentSessionId = undefined` | P1 | Fresh context per increment |
| FR-004 | Parallel task batches count as number-of-tasks-in-batch toward the increment limit | P2 | Prevents oversized increments |
| FR-005 | `implement.md` command documentation describes increment boundary behavior | P2 | User-facing docs |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | No context exhaustion failures on issues with >10 tasks | 0 failures | Monitor workflow runs |
| SC-002 | Incremental re-invocation correctly skips completed tasks | 100% skip accuracy | Verify `[X]` tasks are not re-executed |
| SC-003 | Total implementation output matches single-session runs | Equivalent results | Compare completed task sets |

## Assumptions

- The implement operation's idempotency (skipping `[X]` tasks) is reliable and already tested
- Committing and pushing at increment boundaries is acceptable (no "all-or-nothing" requirement)
- 10 tasks per increment is a conservative default; actual tuning can follow later

## Out of Scope

- Dynamic increment sizing based on task complexity
- User-configurable increment size in workflow YAML (config is per-invocation via operation input)
- Changes to any phase other than `implement` in the phase loop

---

*Generated by speckit*
