# Research: Track Linked Sibling PRs in WorkflowState

## Technology Decisions

### 1. Pure function vs. method on WorkflowState

**Decision**: Pure function `addLinkedPR(state, entry) => WorkflowState`

**Rationale**: `WorkflowState` is a plain interface (not a class). The codebase uses plain objects throughout — `FilesystemWorkflowStore.save()` spreads the state with `{ ...state, updatedAt }`. A pure function returning a new object is the natural fit.

**Alternative considered**: Adding a method to `FilesystemWorkflowStore` (e.g., `store.addLinkedPR(workflowId, entry)`). Rejected because the helper should work on in-memory state without requiring a store instance — callers in Issue E will manipulate state before saving.

### 2. De-duplication key: `repo + number`

**Decision**: Composite key of `repo` (string) and `number` (number).

**Rationale**: A PR is uniquely identified by its repository and number within that repository. This matches GitHub's own identity model. Using `url` as key would break if the URL format changes or includes different query parameters.

### 3. Update-on-duplicate vs. ignore-on-duplicate

**Decision**: Update existing entry when `repo + number` matches (replace all fields).

**Rationale**: Spec AC explicitly requires "The helper updates existing entries (e.g. URL change) rather than silently ignoring duplicates." This handles cases where a PR's branch or URL changes after initial creation (e.g., force-push to a different branch name, or URL format change).

### 4. No schema version bump

**Decision**: Keep version at `1.0`.

**Rationale**: The `linkedPRs` field is optional and defaults to `undefined`. Existing state files without the field will pass validation and load correctly. A version bump would require migration logic for a field that can simply be absent. The version field exists for breaking changes (e.g., renamed required fields).

### 5. Validation approach

**Decision**: Add validation in `validateWorkflowState()` alongside existing `pendingReview` validation.

**Rationale**: Both save and load paths already call `validateWorkflowState()`. Adding `linkedPRs` validation there ensures consistency. The pattern follows the existing `pendingReview` block: skip if `undefined`, validate structure if present.

## Implementation Patterns

### Immutable state update pattern

```typescript
export function addLinkedPR(state: WorkflowState, entry: LinkedPR): WorkflowState {
  const existing = state.linkedPRs ?? [];
  const idx = existing.findIndex(lp => lp.repo === entry.repo && lp.number === entry.number);
  const updated = idx >= 0
    ? existing.map((lp, i) => i === idx ? entry : lp)
    : [...existing, entry];
  return { ...state, linkedPRs: updated };
}
```

This mirrors how `save()` creates a new state object via spread.

### Validation pattern (from existing `pendingReview` block)

```typescript
if (state.linkedPRs !== undefined) {
  if (!Array.isArray(state.linkedPRs)) {
    errors.push('linkedPRs must be an array');
  } else {
    for (const [i, entry] of (state.linkedPRs as unknown[]).entries()) {
      // validate each entry's fields
    }
  }
}
```

## Key Sources

- Existing `WorkflowState` type: `packages/workflow-engine/src/types/store.ts`
- Existing store + validation: `packages/workflow-engine/src/store/filesystem-store.ts`
- Existing tests: `packages/workflow-engine/src/store/filesystem-store.test.ts`
- Multi-repo plan: `tetrad-development/docs/multi-repo-workflows-plan.md` (referenced in spec)
