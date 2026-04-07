# Research: Task Chunking with Session Restart

## Problem Context

Claude Code sessions have a finite context window. For large implementations, accumulated context from reading spec files, implementing tasks, and tracking progress can exhaust the window mid-implementation. Observed on generacy-ai/generacy-cloud#133 (7 tasks, failed during test rewrites).

The implement operation already has idempotency — tasks marked `[X]` in `tasks.md` are skipped on restart. This means we can safely stop and restart with a fresh session.

## Design Decisions

### 1. Increment Size: 10 (default)

10 tasks is a conservative default. Context exhaustion in practice depends on task complexity and file sizes read. The parameter is configurable per-invocation via `max_tasks_per_increment`. No dynamic sizing (would require predicting token usage per task).

### 2. Sentinel Communication Protocol

**Alternatives considered:**
- **A) Parse tool_result chunks**: The `ImplementOutput` JSON travels back to Claude CLI as a nested MCP tool result. Extracting it requires parsing the MCP protocol envelope — fragile and format-dependent.
- **B) Extend PhaseResult directly in cli-spawner**: Would require claude CLI to exit with a different exit code or write to a specific FD, breaking the simple stdout/stderr model.
- **C) Text sentinel (chosen)**: `implement.md` command outputs `SPECKIT_IMPLEMENT_PARTIAL: {...}` as a text line. `output-capture.ts` parses it. Explicit, testable, no protocol coupling.

**Chosen**: Option C. The sentinel is clearly intentional, easy to test, and doesn't require changes to the Claude CLI protocol.

### 3. Commit Responsibility: Phase Loop

The implement operation already commits per task (`feat: complete T001`). Adding a boundary commit inside `executeImplement` would create a redundant commit when the phase loop calls `commitPushAndEnsurePr`. Per the existing architecture, `commitPushAndEnsurePr` is the canonical safety net for all commit/push/PR creation.

### 4. Parallel Batch Atomicity

When a parallel batch would start after the limit is already reached, it is deferred to the next increment (batch starts in next session). If a batch is already in progress when it completes over the limit, the overage is accepted — batch atomicity is more important than strict limit adherence. The limit is a soft guideline, not a hard cap.

### 5. Infinite Loop Guard: Measure Forward Progress

**Alternatives:**
- **A) Max invocation limit**: `ceil(totalTasks / MAX_TASKS) + 1` invocations maximum. Fragile: if tasks fail without erroring (treated as skipped), loop could exhaust limit before completion.
- **B) tasks_remaining decreased (chosen)**: Directly measures forward progress. If no tasks were completed in an increment, there's no point retrying — surface as an error.
- **C) No guard**: Dangerous — consistent soft failures produce infinite loops.

This mirrors the existing retry logic (`hasChanges` check before allowing implement retry).

### 6. Relationship to Existing Retry Logic

The existing retry (`implementRetryCount`) handles **failures** (non-zero exit code). This feature handles **partial success** (exit code 0, but more tasks remain). They are complementary:
- Chunking: prevents context exhaustion proactively
- Retry: recovers from task failures reactively

Both use the same mechanism: fresh session + task idempotency.

## Implementation Patterns

### Pattern: Re-run phase by decrementing loop index

Existing pattern in phase-loop.ts (implement retry):
```typescript
i--;
continue;
```
This feature uses the same pattern for partial re-invocation.

### Pattern: commitPushAndEnsurePr for boundary commits

Existing: called after every phase completes. For partial increments, called proactively before re-invoking.

### Pattern: currentSessionId = undefined for fresh context

Existing: used in retry path. Used identically for increment boundaries.

## References

- Root cause analysis: generacy-ai/generacy-cloud#133
- Spec: `specs/360-summary-issues-many-tasks/spec.md`
- Clarifications: `specs/360-summary-issues-many-tasks/clarifications.md`
- Key files: `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`, `packages/orchestrator/src/worker/phase-loop.ts`
