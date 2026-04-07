# Implementation Plan: Failed Phase Labels for Workflow Errors

**Feature**: Add `failed:<phase>` labels when workflow phases fail, so users can see at a glance which phase failed
**Branch**: `328-problem-when-workflow-phase`
**Status**: Complete

## Summary

When a workflow phase fails, the system currently only adds `agent:error` — there's no indication of *which* phase failed without checking worker logs. This feature adds `failed:<phase>` labels (e.g., `failed:validate`) alongside `agent:error`, and clears them when issues are reprocessed.

## Technical Context

- **Language**: TypeScript
- **Framework**: Node.js monorepo (pnpm workspaces)
- **Key Packages**:
  - `packages/workflow-engine` — Label definitions, GitHub actions
  - `packages/orchestrator` — Worker logic, label management, label monitoring
- **Testing**: Vitest

## Changes Required

### 1. Add `failed:*` label definitions
**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`

Add 6 new labels to `WORKFLOW_LABELS` array:
- `failed:specify`, `failed:clarify`, `failed:plan`, `failed:tasks`, `failed:implement`, `failed:validate`
- Color: `D73A4A` (red, matching `agent:error`)
- Description: `"Phase {phase} failed"`

Place them after the existing `completed:*` block for consistency.

### 2. Update `LabelManager.onError()` to add `failed:<phase>`
**File**: `packages/orchestrator/src/worker/label-manager.ts` (lines 104-119)

Change the `addLabels` call from:
```typescript
await this.github.addLabels(..., ['agent:error']);
```
To:
```typescript
await this.github.addLabels(..., [`failed:${phase}`, 'agent:error']);
```

### 3. Clear `failed:*` labels on `process` events
**File**: `packages/orchestrator/src/services/label-monitor-service.ts`

- Add constant: `const FAILED_LABEL_PREFIX = 'failed:';`
- Update the label cleanup in `processLabelEvent()` (around line 325) to also filter and remove `failed:*` labels alongside `completed:*` labels

### 4. Update tests

**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
- Update the `onError` test to expect `failed:<phase>` in the `addLabels` call

**File**: `packages/orchestrator/tests/unit/services/label-monitor-service.test.ts`
- Add test verifying `failed:*` labels are removed on `process` events

## Project Structure

```
packages/
├── workflow-engine/
│   └── src/actions/github/
│       └── label-definitions.ts          # [MODIFY] Add failed:* labels
├── orchestrator/
│   ├── src/
│   │   ├── worker/
│   │   │   ├── label-manager.ts          # [MODIFY] Add failed:<phase> in onError()
│   │   │   ├── types.ts                  # [READ-ONLY] WorkflowPhase type
│   │   │   └── __tests__/
│   │   │       └── label-manager.test.ts # [MODIFY] Update onError test
│   │   └── services/
│   │       └── label-monitor-service.ts  # [MODIFY] Clear failed:* on process
│   └── tests/unit/services/
│       └── label-monitor-service.test.ts # [MODIFY] Add failed:* cleanup test
```

## Implementation Order

1. `label-definitions.ts` — Add label definitions (no dependencies)
2. `label-manager.ts` — Update onError() (depends on label concept, not import)
3. `label-monitor-service.ts` — Add cleanup logic
4. Tests — Update both test files

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| GitHub label API rate limits | Low | Already handled by `retryWithBackoff` |
| Labels not pre-created in repos | Low | Label definitions auto-sync via existing `ensureLabels` flow |
| Stale `failed:*` labels on reprocess | Medium | Explicitly cleared in `processLabelEvent` alongside `completed:*` |

## Constitution Check

No `.specify/memory/constitution.md` exists — no governance constraints to verify against.
