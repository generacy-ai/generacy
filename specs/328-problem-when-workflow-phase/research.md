# Research: Failed Phase Labels

## Technology Decisions

### Label Color Choice: `D73A4A` (Red)
**Decision**: Use the same red color as `agent:error` for `failed:*` labels.

**Rationale**: Failed phase labels are error-related metadata — using the same red creates visual consistency. Users scanning issue labels will immediately associate red labels with failure states.

**Alternatives Considered**:
- Distinct color (e.g., orange `E4E669`) — Rejected: adds visual noise without clarity benefit
- Same color as `phase:*` labels (blue) — Rejected: confusing, failure should look different from active phase

### Label Naming: `failed:<phase>` vs alternatives
**Decision**: Use `failed:<phase>` prefix pattern.

**Alternatives Considered**:
- `error:<phase>` — Rejected: conflicts conceptually with `agent:error` which is a status label
- `phase-failed:<phase>` — Rejected: verbose, inconsistent with existing `completed:<phase>` naming
- `phase:<phase>:failed` — Rejected: breaks prefix-based filtering pattern used throughout codebase

### Cleanup Strategy: Clear on `process` events
**Decision**: Clear `failed:*` labels in the same place `completed:*` labels are cleared.

**Rationale**: The existing pattern in `LabelMonitorService.processLabelEvent()` already handles `completed:*` cleanup for exactly this reason — requeued issues shouldn't carry stale state. The `failed:*` labels have identical lifecycle semantics.

## Implementation Patterns

### Existing Pattern: Label Lifecycle
```
process:* added → triggers workflow
  → phase:* added/removed as phases progress
  → completed:* added as phases succeed
  → OR failed:* added when phase fails (NEW)
  → on re-process: completed:* AND failed:* cleared
```

### Existing Pattern: Prefix-Based Label Filtering
The codebase consistently uses prefix-based filtering:
```typescript
const COMPLETED_LABEL_PREFIX = 'completed:';
labels.filter(name => name.startsWith(COMPLETED_LABEL_PREFIX));
```
The new `failed:*` labels follow this exact pattern.

## Key References

- `LabelManager.onError()` — `packages/orchestrator/src/worker/label-manager.ts:104-119`
- `WORKFLOW_LABELS` — `packages/workflow-engine/src/actions/github/label-definitions.ts`
- `processLabelEvent()` cleanup — `packages/orchestrator/src/services/label-monitor-service.ts:318-342`
- `WorkflowPhase` type — `packages/orchestrator/src/worker/types.ts:7`
