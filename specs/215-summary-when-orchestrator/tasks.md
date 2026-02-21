# Tasks: Fix Orchestrator Resume Flow (3 Interacting Bugs)

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Label Definitions & Type Changes

Foundational changes that other phases depend on. No behavioral changes yet.

### T001 [P] Add `workflow:` labels to label definitions
**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`
- Add `workflow:speckit-feature` label entry (color `6F42C1`, description "Speckit feature workflow")
- Add `workflow:speckit-bugfix` label entry (color `6F42C1`, description "Speckit bugfix workflow")
- Insert after the process trigger labels (after line 75)

### T002 [P] Add `issueLabels` field to `LabelEvent` interface
**File**: `packages/orchestrator/src/types/monitor.ts`
- Add `issueLabels: string[]` field to the `LabelEvent` interface (line 100-115)
- Add JSDoc comment: "All labels on the issue at detection time"

---

## Phase 2: Core Bug Fixes

The three interacting bugs are fixed here. T003 and T004 are independent of each other.

### T003 Fix label monitor — workflow resolution, `workflow:` label, and `waiting-for:` removal (Bug 1 + Bug 2 partial)
**File**: `packages/orchestrator/src/services/label-monitor-service.ts`
- **A**: Include `issueLabels` in both return branches of `parseLabelEvent()` (lines 117-125 for process, lines 136-144 for resume)
- **B**: Add private `resolveWorkflowFromLabels(issueLabels: string[]): string` helper — finds `workflow:*` label, falls back to `'speckit-feature'`
- **C**: In `processLabelEvent()` (~lines 186-195), compute `workflowName` using `resolveWorkflowFromLabels()` for resume events (instead of `parsedName`). Add warning log when no `workflow:` label is found on a resume event
- **D**: On `process:` events (~line 222), apply `workflow:${parsedName}` label alongside `agent:in-progress`
- **E**: Delete the `else if (type === 'resume')` block (lines 229-239) that removes `waiting-for:*` labels — the worker will handle this now

### T004 Add unified `GATE_MAPPING` and rewrite phase resolver (Bug 2 + Bug 3)
**File**: `packages/orchestrator/src/worker/phase-resolver.ts`
- **A**: Add exported `GATE_MAPPING` constant mapping gate names to `{ phase: WorkflowPhase; resumeFrom: WorkflowPhase }`:
  - `'clarification'` → `{ phase: 'clarify', resumeFrom: 'plan' }`
  - `'spec-review'` → `{ phase: 'specify', resumeFrom: 'clarify' }`
  - `'clarification-review'` → `{ phase: 'clarify', resumeFrom: 'plan' }`
  - `'plan-review'` → `{ phase: 'plan', resumeFrom: 'tasks' }`
  - `'tasks-review'` → `{ phase: 'tasks', resumeFrom: 'implement' }`
  - `'implementation-review'` → `{ phase: 'implement', resumeFrom: 'validate' }`
  - `'manual-validation'` → `{ phase: 'validate', resumeFrom: 'validate' }`
- **B**: Rewrite `resolveFromContinue()` — remove `waiting-for:` dependency, iterate `PHASE_SEQUENCE` latest-first, match `completed:*` labels against `GATE_MAPPING`, fallback to `resolveFromProcess()`
- **C**: Update `resolveFromProcess()` — when building `completedPhases` set, normalize gate names to phase names via `GATE_MAPPING` (e.g., `'clarification'` → `'clarify'`)
- **D**: Remove the `reviewToPhase` map (lines 88-95) — fully replaced by `GATE_MAPPING`

---

## Phase 3: Worker-Side Resume Cleanup

Depends on Phase 2 (T003 removing `waiting-for:` cleanup from label monitor).

### T005 Add `onResumeStart()` to label manager (Bug 2 fix — move cleanup to worker)
**File**: `packages/orchestrator/src/worker/label-manager.ts`
- Add `onResumeStart()` method after `onWorkflowComplete()` (~line 133)
- Method fetches current issue labels, filters for `waiting-for:*` and `agent:paused`, removes them via `removeLabels()`
- Wrap in `retryWithBackoff()` consistent with other methods
- Add info-level log listing labels being removed

### T006 Call `onResumeStart()` before phase loop for `continue` commands
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- After sub-component creation (line ~253) and before phase loop execution (line ~255), add:
  ```typescript
  if (item.command === 'continue') {
    await labelManager.onResumeStart();
  }
  ```

---

## Phase 4: PR Feedback Monitor Update

Independent of Phase 3, but depends on Phase 1 (T001 for `workflow:` labels to exist).

### T007 [P] Update `resolveWorkflowName()` to prefer `workflow:*` labels
**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- In `resolveWorkflowName()` (lines 473-505), add a primary check for `workflow:*` labels before the existing `process:*` / `completed:*` fallback logic
- Existing logic remains as backward-compatible fallback for pre-migration issues

---

## Phase 5: Update Existing Tests

Depends on Phases 2-4 (implementation must be complete before fixing assertions).

### T008 Update label monitor service tests
**File**: `packages/orchestrator/tests/unit/services/label-monitor-service.test.ts`
- **parseLabelEvent tests** (~line 83): Add `issueLabels` to all expected `LabelEvent` objects
  - Line 92: add `issueLabels: ['process:speckit-feature']`
  - Line 133: add `issueLabels: ['process:speckit-bugfix']`
- **processLabelEvent tests** (~line 141): Add `issueLabels` field to all event inputs
  - Lines 143-151, 176-183, 195-201, 213-221: add `issueLabels: []` or appropriate labels
- **Resume enqueue test** (~line 268): Update event to include `issueLabels: ['completed:spec-review', 'waiting-for:spec-review', 'workflow:speckit-feature']`; change expected `workflowName` from `'spec-review'` to `'speckit-feature'`
- **Resume label removal test** (~line 289): Rewrite to assert `removeLabels` is NOT called for resume events
- **Resume dedup key test** (~line 307): Add `issueLabels` to event input
- **Resume detection tests** (~lines 237-254): Add `issueLabels` to expected outputs
- **Deduplication integration tests** (~lines 425-470): Add `issueLabels` to event inputs
- **Webhook integration tests** (~lines 477-494): Add `issueLabels` to expected outputs
- **Process event test** (~line 142): Update `addLabels` expectation to include `workflow:speckit-feature` alongside `agent:in-progress`

### T009 [P] Update phase resolver tests
**File**: `packages/orchestrator/src/worker/__tests__/phase-resolver.test.ts`
- **Continue + clarification test** (~line 59): Change expected result from `'clarify'` to `'plan'`; update test description to reflect new behavior
- **Fallback test** (~line 107): Verify behavior is unchanged (no waiting-for dependency)
- Verify all other existing tests still pass with the `GATE_MAPPING` rewrite

### T010 [P] Update claude-cli-worker tests
**File**: `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts`
- **Continue command resume test** (~line 265): Update assertion — first spawn should use `/speckit:plan` instead of `/speckit:clarify`; update test description

---

## Phase 6: Add New Tests

Can be done in parallel with Phase 5 since they add new test blocks (no conflicts with existing test edits).

### T011 [P] Add `GATE_MAPPING` integration tests
**File**: `packages/orchestrator/src/worker/__tests__/phase-resolver.test.ts`
- Add `describe('GATE_MAPPING integration')` block with:
  - Parameterized test (`it.each`) for all gate-to-phase mappings: `clarification→plan`, `spec-review→clarify`, `clarification-review→plan`, `plan-review→tasks`, `tasks-review→implement`, `implementation-review→validate`
  - Test that `continue` resolution works without `waiting-for:` labels
  - Test that `resolveFromProcess` normalizes gate names via `GATE_MAPPING` (e.g., `completed:clarification` treated as `clarify` phase done)
  - Test that most advanced gate wins when multiple `completed:` gate labels exist

### T012 [P] Add `onResumeStart()` tests
**File**: `packages/orchestrator/src/worker/__tests__/label-manager.test.ts`
- Add `describe('onResumeStart')` block with:
  - Test: removes `waiting-for:*` and `agent:paused` labels when present
  - Test: no-op when no stale labels exist (does not call `removeLabels`)

---

## Phase 7: Integration Verification

### T013 Run full test suite and fix regressions
**Files**:
- All test files in `packages/orchestrator/`
- Run `pnpm test` (or equivalent) from `packages/orchestrator`
- Fix any test failures or type errors introduced by the changes
- Verify no regressions in unmodified tests

### T014 TypeScript compilation check
**Files**:
- `packages/orchestrator/`
- `packages/workflow-engine/`
- Run `pnpm tsc --noEmit` (or equivalent) to verify no type errors across both packages

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (T002 needed for T003 `issueLabels` field)
- Phase 2 must complete before Phase 3 (T003 removes `waiting-for:` cleanup; T005/T006 add it in worker)
- Phase 4 can run after Phase 1 (only needs `workflow:` labels to exist)
- Phase 5 depends on Phases 2-4 (tests assert new behavior)
- Phase 6 can run in parallel with Phase 5
- Phase 7 depends on all prior phases

**Parallel opportunities within phases**:
- Phase 1: T001 and T002 are fully independent [P]
- Phase 2: T003 and T004 modify different files, no shared code [P within phase but T003 semantically relates to T005]
- Phase 4: T007 is independent of Phase 3 [P]
- Phase 5: T009 and T010 are independent [P]; T008 is independent of T009/T010
- Phase 6: T011 and T012 modify different test files [P]

**Critical path**:
T002 → T003 → T005 → T006 → T008 → T013 → T014

**Alternate parallel path**:
T001 → T007 (can run alongside critical path)
T004 → T009/T011 (can run alongside T003 chain)
