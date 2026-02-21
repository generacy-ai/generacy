# Feature Specification: Fix resume-after-clarification failure

**Branch**: `215-summary-when-orchestrator` | **Date**: 2026-02-21 | **Status**: Draft

## Summary

When the orchestrator resumes after `completed:clarification` is added to an issue, the job immediately fails. Three interacting bugs in the resume flow prevent correct phase resolution: (1) `workflowName` is set to the phase/gate name instead of the workflow name, (2) the `waiting-for:` label is removed before the worker can read it, and (3) the gate name `clarification` doesn't match the phase name `clarify` in fallback resolution. These bugs cascade so that every resume after a clarification gate fails immediately.

**Observed in**: generacy-ai/agency#244

```
[20:19:35] INFO: Marked phase as processed  key: "phase-tracker:generacy-ai:agency:244:resume:clarification"
[20:19:35] INFO: Job status updated  jobId: "0e096518-..."  status: "running"
[20:19:35] INFO: Job result reported  jobId: "0e096518-..."  status: "failed"
```

## Root Cause Analysis

### Bug 1: `workflowName` set to phase name instead of workflow name

In `label-monitor-service.ts`, when a resume event is enqueued, `workflowName` is set to `parsedName` — which is extracted from the label suffix. For `process:speckit-feature`, `parsedName` = `'speckit-feature'` (correct). But for `completed:clarification` resume events, `parsedName` = `'clarification'` — a gate name, not a workflow name. This causes the gate checker to look up `config.gates['clarification']` → `undefined`, so the configured gate at `config.gates['speckit-feature']` is never consulted.

### Bug 2: Race condition — `waiting-for:` label removed before worker reads labels

The label monitor removes `waiting-for:clarification` after enqueueing but before the worker runs. When the worker later fetches labels and calls `resolveFromContinue()`, the `waitingForSet` is empty. The explicit clarification check in `phase-resolver.ts` fails because `waitingForSet.has('clarification')` returns false.

### Bug 3: Phase naming mismatch in fallback resolution

After the `continue` check fails, resolution falls back to `resolveFromProcess()`, which iterates `PHASE_SEQUENCE` using short names (`['specify', 'clarify', 'plan', ...]`). But the label on the issue is `completed:clarification` (full gate name). The resolver doesn't recognize `clarification` as the `clarify` phase being done, and incorrectly tries to re-run `clarify` from scratch.

### The Failure Cascade

1. Label monitor correctly detects `completed:clarification` + `waiting-for:clarification` pair
2. Enqueues with wrong `workflowName: 'clarification'` (should be `'speckit-feature'`)
3. Removes `waiting-for:clarification` label from the issue
4. Worker picks up item, fetches labels (now missing `waiting-for:`)
5. `resolveFromContinue` can't match — falls through to `resolveFromProcess`
6. `resolveFromProcess` can't match `'clarification'` to `'clarify'` — returns `'clarify'`
7. Worker runs with `workflowName: 'clarification'`, no gates configured → job fails

## User Stories

### US1: Orchestrator resumes correctly after clarification gate

**As a** developer using the speckit-feature workflow,
**I want** the orchestrator to correctly resume execution after I add `completed:clarification` to an issue,
**So that** the workflow continues to the next phase (plan) without failing or re-running clarification.

**Acceptance Criteria**:
- [ ] Adding `completed:clarification` to an issue with `waiting-for:clarification` resumes the workflow and advances to the `plan` phase
- [ ] The queue item has the correct `workflowName` (e.g., `speckit-feature`), not the gate name
- [ ] Gate checks use the correct workflow configuration during resume
- [ ] The `completed:clarification` label is correctly recognized as the clarify phase being done

### US2: Orchestrator resumes correctly after any gate completion

**As a** developer using any workflow with gates,
**I want** all gate resume events to correctly resolve the workflow name and next phase,
**So that** every gate-to-resume transition works reliably, not just clarification.

**Acceptance Criteria**:
- [ ] Resume after `completed:spec-review` correctly identifies the workflow and advances to `clarify`
- [ ] Resume after `completed:plan-review` correctly identifies the workflow and advances to `tasks`
- [ ] Resume after `completed:implementation-review` correctly identifies the workflow and advances to `validate`
- [ ] All gate names are correctly mapped to their corresponding phase names

### US3: Workflow identity persists across the issue lifecycle

**As a** system operator,
**I want** the workflow type to be discoverable from issue labels at any point in the workflow,
**So that** resume events can always determine the correct workflow configuration.

**Acceptance Criteria**:
- [ ] A `workflow:speckit-feature` or `workflow:speckit-bugfix` label is applied when a workflow starts
- [ ] The `workflow:` label persists for the lifetime of the issue (not removed during phase transitions)
- [ ] The label monitor reads the `workflow:` label to determine `workflowName` for resume events
- [ ] Label sync creates the `workflow:` labels in target repositories

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `workflow:speckit-feature` and `workflow:speckit-bugfix` labels to `WORKFLOW_LABELS` in `label-definitions.ts` | P1 | Enables label sync to create these labels in repos |
| FR-002 | Apply the `workflow:<name>` label when a workflow starts in `label-manager.ts` | P1 | Add to `onPhaseStart` (first phase) or new `onWorkflowStart` method |
| FR-003 | Read `workflow:*` label from issue labels in `label-monitor-service.ts` to set `workflowName` on resume events | P1 | Replaces using `parsedName` from the completed/waiting-for label |
| FR-004 | Defer removal of `waiting-for:` labels — let the worker remove them after phase resolution succeeds | P1 | Fixes race condition; label monitor should not remove `waiting-for:` |
| FR-005 | Move `waiting-for:` label removal to `label-manager.ts`, called after successful phase resolution in the worker | P1 | Pairs with FR-004 |
| FR-006 | Add gate-name-to-phase-name mapping in `types.ts` (e.g., `clarification` → `clarify`) | P1 | Used by `resolveFromProcess` fallback |
| FR-007 | Update `resolveFromProcess` in `phase-resolver.ts` to normalize gate names to phase names when checking `completedPhases` | P1 | Ensures `completed:clarification` is recognized as `clarify` done |
| FR-008 | Add `reviewToPhase` entries for any missing gate-to-phase mappings in `resolveFromContinue` | P2 | The existing `reviewToPhase` map handles review gates; ensure clarification is covered |
| FR-009 | Retain `resolveFromContinue` clarification special-case as defense-in-depth, but it should no longer be the only path | P2 | With FR-004, the `waiting-for:` label will be present again, so this path works as a backup |

## Implementation Details

### Fix 1: Persistent `workflow:` label for workflow identity

**Files to change:**

| File | Change |
|------|--------|
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | Add `{ name: 'workflow:speckit-feature', color: '...' }` and `{ name: 'workflow:speckit-bugfix', color: '...' }` to `WORKFLOW_LABELS` |
| `packages/orchestrator/src/worker/label-manager.ts` | Add `onWorkflowStart(workflowName)` method that applies `workflow:<name>` label, or integrate into first `onPhaseStart` call |
| `packages/orchestrator/src/services/label-monitor-service.ts` | On resume events, find `workflow:*` label in `issueLabels` and extract the workflow name; use this instead of `parsedName` for `workflowName` |

### Fix 2: Defer `waiting-for:` label removal

**Files to change:**

| File | Change |
|------|--------|
| `packages/orchestrator/src/services/label-monitor-service.ts` | Remove the block that deletes `waiting-for:*` labels on resume events (around line 229-240) |
| `packages/orchestrator/src/worker/label-manager.ts` | Add `onResumeStart(gateName)` or extend `onPhaseStart` to remove the `waiting-for:<gate>` and `agent:paused` labels when the worker begins executing the resumed phase |

### Fix 3: Gate-name-to-phase-name normalization

**Files to change:**

| File | Change |
|------|--------|
| `packages/orchestrator/src/worker/types.ts` | Add a `GATE_TO_PHASE` mapping: `{ 'clarification': 'clarify', 'spec-review': 'specify', 'clarification-review': 'clarify', 'plan-review': 'plan', 'tasks-review': 'tasks', 'implementation-review': 'implement', 'manual-validation': 'validate' }` |
| `packages/orchestrator/src/worker/phase-resolver.ts` | In `resolveFromProcess`, normalize `completedPhases` entries through `GATE_TO_PHASE` before comparing against `PHASE_SEQUENCE` |

## Files Involved

| File | Role |
|------|------|
| `packages/orchestrator/src/services/label-monitor-service.ts` | Resume detection + queue item creation |
| `packages/orchestrator/src/worker/phase-resolver.ts` | Phase resolution from labels |
| `packages/orchestrator/src/worker/label-manager.ts` | Label lifecycle management |
| `packages/orchestrator/src/worker/types.ts` | `PHASE_SEQUENCE`, `WorkflowPhase`, gate-to-phase mapping |
| `packages/orchestrator/src/worker/config.ts` | Gate definitions keyed by `workflowName` |
| `packages/orchestrator/src/worker/gate-checker.ts` | Gate lookup using `workflowName` |
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | `WORKFLOW_LABELS` for label sync |
| `packages/orchestrator/src/services/label-sync-service.ts` | Syncs `WORKFLOW_LABELS` to repos |

## Test Plan

### Unit Tests

| Test | File | Validates |
|------|------|-----------|
| `workflowName` resolution from `workflow:*` label | `label-monitor-service.test.ts` | FR-003: Resume events use the `workflow:` label, not the gate name |
| `waiting-for:` label NOT removed by label monitor | `label-monitor-service.test.ts` | FR-004: Label monitor no longer removes `waiting-for:` on resume |
| `waiting-for:` label removed by worker on resume | `label-manager.test.ts` | FR-005: Worker removes `waiting-for:` after phase resolution |
| `workflow:` label applied on workflow start | `label-manager.test.ts` | FR-002: `onWorkflowStart` or first `onPhaseStart` applies `workflow:` label |
| Gate name normalization in `resolveFromProcess` | `phase-resolver.test.ts` | FR-007: `completed:clarification` recognized as `clarify` done |
| `resolveFromContinue` with `waiting-for:` present | `phase-resolver.test.ts` | FR-009: Clarification special case works when label is present |
| Full resume-after-clarification flow | `phase-resolver.test.ts` | US1: `completed:clarification` → next phase is `plan` |
| Resume after all gate types | `phase-resolver.test.ts` | US2: Each gate type maps to correct next phase |

### Integration / E2E Scenarios

| Scenario | Steps | Expected Result |
|----------|-------|-----------------|
| Clarification resume | 1. Start `speckit-feature` workflow 2. Hit clarification gate 3. Add `completed:clarification` | Worker resumes at `plan` phase with correct `workflowName` |
| Review gate resume | 1. Start workflow 2. Hit `spec-review` gate 3. Add `completed:spec-review` | Worker resumes at `clarify` phase |
| Multiple resumes | 1. Resume after clarification 2. Hit `plan-review` gate 3. Resume after plan review | Each resume resolves correctly; `workflow:` label persists |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Resume-after-clarification success rate | 100% | All resume events after `completed:clarification` result in successful phase transitions (no immediate failures) |
| SC-002 | Correct `workflowName` on resume events | 100% | Queue items from resume events have the workflow name from the `workflow:` label, not the gate name |
| SC-003 | All existing phase-resolver tests pass | 100% | `vitest run` in `packages/orchestrator` passes all existing + new tests |
| SC-004 | No regression in `process:` event handling | 0 regressions | Process events (initial workflow starts) continue to work identically |
| SC-005 | Resume works for all gate types | 100% | Spec-review, clarification, plan-review, tasks-review, implementation-review, manual-validation all resume correctly |

## Assumptions

- The `workflow:` label approach is the simplest reliable way to persist workflow identity on an issue; alternatives (e.g., database lookup, encoding in other labels) are more complex without clear benefit
- Only one workflow runs per issue at a time (no need to handle multiple concurrent `workflow:` labels)
- The existing `PHASE_SEQUENCE` and gate definitions in `config.ts` are stable and correct; this fix does not change workflow ordering or gate conditions
- Deferring `waiting-for:` removal to the worker does not introduce new race conditions because the worker processes items sequentially per issue
- The label sync service will be re-run on target repos to create the new `workflow:` labels before this fix is deployed

## Out of Scope

- Changing the gate condition logic (always/on-questions/on-failure) — only fixing the plumbing for resume events
- Adding new workflow types beyond `speckit-feature` and `speckit-bugfix`
- Changing the `PHASE_SEQUENCE` or adding/removing phases
- Refactoring the label monitor's polling/webhook architecture
- Addressing any other label-monitor edge cases not related to the resume flow
- UI changes — this is entirely backend orchestrator logic
- Renaming existing labels (e.g., changing `completed:clarification` to `completed:clarify`) — we normalize in code instead to avoid breaking existing issues with those labels

---

*Generated by speckit*
