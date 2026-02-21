# Feature Specification: ## Summary

When the orchestrator resumes after `completed:clarification` is added to an issue, the job immediately fails

**Branch**: `215-summary-when-orchestrator` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

## Summary

When the orchestrator resumes after `completed:clarification` is added to an issue, the job immediately fails. Three interacting bugs in the resume flow prevent correct phase resolution.

Observed in generacy-ai/agency#244:

```
[20:19:35] INFO: Marked phase as processed  key: "phase-tracker:generacy-ai:agency:244:resume:clarification"
[20:19:35] INFO: Job status updated  jobId: "0e096518-..."  status: "running"
[20:19:35] INFO: Job result reported  jobId: "0e096518-..."  status: "failed"
```

## Root Cause

### Bug 1: `workflowName` set to phase name instead of workflow name

In `label-monitor-service.ts:191`, when a resume event is enqueued:

```typescript
workflowName: parsedName,  // parsedName = 'clarification' (from the label)
```

For `process:speckit-feature` events, `parsedName` = `'speckit-feature'` (correct). But for `completed:clarification` resume events, `parsedName` = `'clarification'` — a **phase name**, not the workflow name. This means:
- The gate checker does `config.gates['clarification']` → `undefined` → no gates found
- The configured gate at `config.gates['speckit-feature']` is never consulted

### Bug 2: Race condition — `waiting-for:` label removed before worker reads labels

The label monitor removes `waiting-for:clarification` (line 231) *after enqueueing but before the worker runs*. When the worker later fetches labels and calls `resolveFromContinue()`, `waitingForSet` is empty. The explicit clarification check at `phase-resolver.ts:83` fails:

```typescript
// waitingForSet is empty — 'waiting-for:clarification' was already removed
if (completedSet.has('clarification') && waitingForSet.has('clarification')) {
  return 'clarify';  // Never reached
}
```

### Bug 3: Phase naming mismatch in fallback resolution

After the `continue` check fails, it falls back to `resolveFromProcess()` (line 104). This iterates `PHASE_SEQUENCE` which uses **short names**: `['specify', 'clarify', 'plan', ...]`. But the label on the issue is `completed:clarification` (full name). So:

```
completedPhases = {'specify', 'clarification'}
Iterating PHASE_SEQUENCE:
  'specify' → in completedPhases ✓ → skip
  'clarify' → NOT in completedPhases ✗ → returns 'clarify'
```

The resolver doesn't recognize `completed:clarification` as the clarify phase being done, and tries to re-run clarify from scratch.

### The cascade

1. Label monitor correctly detects `completed:clarification` + `waiting-for:clarification` pair
2. Enqueues with wrong `workflowName: 'clarification'` (should be `'speckit-feature'`)
3. Removes `waiting-for:clarification`
4. Worker picks up item, fetches labels (now missing `waiting-for:`)
5. `resolveFromContinue` can't match → falls through
6. `resolveFromProcess` can't match `'clarification'` to `'clarify'` → starts from `clarify`
7. Worker runs with `workflowName: 'clarification'`, no gates configured → fails

## Proposed Fix

### 1. Persistent `workflow:` label for workflow identity

Add a `workflow:<name>` label (e.g., `workflow:speckit-feature`) that is applied when the workflow starts and persists for the lifetime of the issue. The label monitor can read this label to determine the correct `workflowName` for resume queue items instead of using the phase name.

**Files to change:**
- `packages/workflow-engine/src/actions/github/label-definitions.ts` — add `workflow:speckit-feature` and `workflow:speckit-bugfix` to `WORKFLOW_LABELS` so label sync creates them
- `packages/orchestrator/src/worker/label-manager.ts` — add the `workflow:` label during the first phase start (or add a new `onWorkflowStart` method)
- `packages/orchestrator/src/services/label-monitor-service.ts` — on resume events, read the `workflow:*` label from `issueLabels` to populate `workflowName` correctly

### 2. Fix the `waiting-for:` race condition in `resolveFromContinue`

The phase resolver's `resolveFromContinue` should not depend on `waiting-for:*` labels still being present, since the label monitor removes them before the worker runs. Options:
- **Option A**: Don't remove `waiting-for:` in the label monitor; let the worker remove it after successful phase resolution
- **Option B**: Change `resolveFromContinue` to work without `waiting-for:` — since the command is already `'continue'`, just check which `completed:` labels are present and map to the next phase

### 3. Normalize the `completed:clarification` → `clarify` mapping

The `completed:clarification` label (used as the gate resume signal) and `completed:clarify` label (used as the phase-complete marker) are two different labels in `WORKFLOW_LABELS`. The phase resolver needs a mapping between gate-resume labels and phase names. Add a lookup in `resolveFromProcess` that maps `clarification` → `clarify` (and any other gate names that differ from phase names).

## Files Involved

| File | Role |
|------|------|
| `packages/orchestrator/src/services/label-monitor-service.ts` | Resume detection + queue item creation |
| `packages/orchestrator/src/worker/phase-resolver.ts` | Phase resolution from labels |
| `packages/orchestrator/src/worker/label-manager.ts` | Label lifecycle management |
| `packages/orchestrator/src/worker/types.ts` | `PHASE_SEQUENCE` / `WorkflowPhase` definitions |
| `packages/orchestrator/src/worker/config.ts` | Gate definitions keyed by `workflowName` |
| `packages/orchestrator/src/worker/gate-checker.ts` | Gate lookup using `workflowName` |
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | `WORKFLOW_LABELS` for label sync |
| `packages/orchestrator/src/services/label-sync-service.ts` | Syncs `WORKFLOW_LABELS` to repos |

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
