# Research: Fix pre-existing test failures in claude-cli-worker.test.ts

## Root Cause Analysis

### The `PHASES_REQUIRING_CHANGES` Guard

`phase-loop.ts:14` defines:
```typescript
const PHASES_REQUIRING_CHANGES: ReadonlySet<WorkflowPhase> = new Set(['implement']);
```

When the implement phase succeeds but `prManager.commitPushAndEnsurePr()` returns `hasChanges: false`, the phase is marked as failed. This is correct production behavior — an implement phase that produces no file changes is suspicious.

### Mock Default Conflict

`claude-cli-worker.test.ts` has two locations setting `getStatus` mock defaults:

1. **Line 24** (initial declaration): `has_changes: false` — This is the problematic default
2. **Line 193** (`beforeEach` reset): `has_changes: true` — This is the correct default

The `beforeEach` block runs `vi.clearAllMocks()` which clears call history but retionally the mocks get re-set on line 193. However, the initial declaration at line 24 creates an inconsistency: if any test or setup code reads the mock before `beforeEach` fires, it gets the wrong value.

### Why 15 Tests Fail

Tests that exercise the implement phase path rely on `getStatus` returning `has_changes: true`. When the mock returns `false`, the `PHASES_REQUIRING_CHANGES` check marks the phase as failed, causing assertion mismatches.

## Technology Decision

**Approach**: Single-line fix to align initial mock declaration with `beforeEach` reset.

**Alternatives Considered**:
- Remove the initial mock value entirely and rely solely on `beforeEach` — rejected because the mock object needs a default implementation at declaration time
- Add per-test overrides — rejected because this is exactly what the `beforeEach` consolidation approach avoids
- Modify `PHASES_REQUIRING_CHANGES` in production code — explicitly out of scope per spec

## Audit Results

| Test File | `has_changes` Default | Needs Fix? |
|-----------|----------------------|------------|
| `claude-cli-worker.test.ts` | `false` (line 24) / `true` (line 193 beforeEach) | Yes — align line 24 |
| `pr-feedback-handler.test.ts` | `false` (line 162 beforeEach) | No — doesn't test implement phase |
| All other orchestrator test files | Not referenced | N/A |
