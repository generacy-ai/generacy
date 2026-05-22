# Implementation Plan: Track Linked Sibling PRs in WorkflowState

**Feature**: Add `linkedPRs` storage slot to `WorkflowState` for cross-repo fan-out tracking
**Branch**: `689-phase-1-multi-repo`
**Status**: Complete

## Summary

Extend the workflow-engine's `WorkflowState` type with an optional `linkedPRs` array to track PRs created in sibling repos during cross-repo fan-out. Add a pure-function helper `addLinkedPR()` for idempotent append/update. This is a foundational, non-user-visible change — producers (Issue E) and consumers (Issue F) come in later phases.

## Technical Context

- **Language**: TypeScript (ESM, strict mode)
- **Package**: `packages/workflow-engine`
- **Test framework**: Vitest
- **Persistence**: JSON via `FilesystemWorkflowStore` (standard `JSON.stringify`/`JSON.parse`)
- **No new dependencies required**

## Project Structure

```
packages/workflow-engine/src/
├── types/
│   ├── store.ts          # MODIFY: Add LinkedPR type + linkedPRs field to WorkflowState
│   └── index.ts          # MODIFY: Re-export LinkedPR type
├── store/
│   ├── filesystem-store.ts       # MODIFY: Add linkedPRs validation in validateWorkflowState
│   ├── filesystem-store.test.ts  # MODIFY: Add round-trip + validation tests for linkedPRs
│   ├── linked-pr.ts              # CREATE: addLinkedPR() helper function
│   ├── linked-pr.test.ts         # CREATE: Unit tests for addLinkedPR()
│   └── index.ts                  # MODIFY: Re-export addLinkedPR and LinkedPR
```

## Implementation Steps

### Step 1: Add `LinkedPR` type and `linkedPRs` field

**File**: `packages/workflow-engine/src/types/store.ts`

- Define `LinkedPR` interface with `repo`, `number`, `branch`, `url` fields
- Add optional `linkedPRs?: LinkedPR[]` to `WorkflowState`
- Export `LinkedPR` type

### Step 2: Update validation in `FilesystemStore`

**File**: `packages/workflow-engine/src/store/filesystem-store.ts`

- Add validation block for `linkedPRs` in `validateWorkflowState()` (lines ~72-88, after `pendingReview` block)
- Validate: if present, must be an array; each entry must have string `repo`, number `number`, string `branch`, string `url`
- Absent field passes validation (backward compatible)

### Step 3: Create `addLinkedPR()` helper

**File**: `packages/workflow-engine/src/store/linked-pr.ts` (new)

- Pure function: `addLinkedPR(state: WorkflowState, entry: LinkedPR): WorkflowState`
- Returns a new state object (immutable pattern, matches existing codebase conventions)
- De-duplicate key: `repo + number`
- If existing entry with same key, update it (replace with new values)
- If no existing entry, append
- Initialize `linkedPRs` to `[]` if `undefined`

### Step 4: Update barrel exports

**Files**: `types/index.ts`, `store/index.ts`

- Re-export `LinkedPR` from `types/index.ts`
- Re-export `addLinkedPR` from `store/index.ts`

### Step 5: Add tests

**File**: `packages/workflow-engine/src/store/filesystem-store.test.ts`

- Round-trip test: save state with `linkedPRs`, load it back, verify equality
- Backward compat test: load state without `linkedPRs`, verify loads cleanly
- Validation tests for malformed `linkedPRs`

**File**: `packages/workflow-engine/src/store/linked-pr.test.ts` (new)

- Append to empty/undefined `linkedPRs`
- Append distinct entries
- De-duplicate on `repo + number` (same key replaces)
- URL update on duplicate
- Original state not mutated (immutability)

### Step 6: Verify

- `pnpm tsc --noEmit` in workflow-engine (SC-001)
- Existing tests pass unchanged (SC-002)
- New tests pass (SC-003, SC-004)

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| Pure function returning new state (not mutating) | Matches immutable patterns in the codebase (e.g., `save()` spreads state) |
| Separate `linked-pr.ts` file | Keeps helper isolated; easy to find for Issue E consumers |
| Validation in `validateWorkflowState` only | `FilesystemStore` already calls it on both save and load paths |
| No schema version bump | Field is optional — existing `1.0` states load cleanly without migration |

## Risks

| Risk | Mitigation |
|------|------------|
| Large `linkedPRs` arrays bloating state files | Unlikely in practice (repos have few sibling PRs); can add a cap in Phase 2 if needed |
| Future `LinkedPR` shape changes | Fields added as optional properties — non-breaking |

## Constitution Check

No `constitution.md` found — no governance constraints to verify against.
