# Clarification Questions

## Status: Pending

## Questions

### Q1: Gate Re-firing on Resume Creates Infinite Loop
**Context**: The spec says `resolveFromContinue` returns `'clarify'` when `completed:clarification` is detected. But the phase loop (phase-loop.ts:184-209) checks gates AFTER each phase completes, and the gate for `speckit-feature` is `{ phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'always' }`. If the worker resumes at `clarify`, it will re-execute the clarify phase, hit the gate again, and pause — creating an infinite resume loop. The spec's Fix 3 normalizes gate names but doesn't address this re-firing problem.
**Question**: How should the resume flow avoid re-triggering the gate on the phase it just resumed from?
**Options**:
- A) Resume at the NEXT phase: `resolveFromContinue` should return `'plan'` (the phase after `clarify`), not `'clarify'`. The `reviewToPhase` map already does this for review gates (e.g., `'spec-review' → 'clarify'` means "after spec-review, start at clarify"). Add `'clarification' → 'plan'` to follow the same pattern.
- B) Skip gates for the resumed phase: Pass a "skip gate for phase X" flag through `WorkerContext` so the gate checker knows not to re-fire the gate the worker just resumed from.
- C) Check `completed:` labels in gate checker: Before firing a gate, check if `completed:<gateLabel>` already exists on the issue. If so, the gate was already satisfied and should be skipped.
- D) Remove the gate definition on resume: The worker removes the gate config entry for the current phase before entering the phase loop when `command === 'continue'`.
**Answer**:

### Q2: Semantic Mismatch in Proposed GATE_TO_PHASE Mapping
**Context**: The spec proposes `GATE_TO_PHASE = { 'spec-review': 'specify', ... }` in FR-006, meaning "spec-review is a gate ON the specify phase." But the existing `reviewToPhase` map in `phase-resolver.ts` uses the opposite semantic: `{ 'spec-review': 'clarify' }` means "after spec-review completes, resume FROM clarify." These two maps serve different purposes but use similar structures, which is confusing and error-prone. The spec's proposed mapping in the Implementation Details section lists `'clarification': 'clarify'` and `'spec-review': 'specify'`, but doesn't clarify which semantic is intended or how it interacts with `reviewToPhase`.
**Question**: Should `GATE_TO_PHASE` map gate names to the phase they gate (e.g., `spec-review → specify`) or to the phase to resume from after the gate (e.g., `spec-review → clarify`), and should it replace or coexist with `reviewToPhase`?
**Options**:
- A) Map to the gated phase + coexist: `GATE_TO_PHASE` maps gate names to the phase they belong to (for `resolveFromProcess` normalization), and `reviewToPhase` stays as-is for `resolveFromContinue` (maps to next phase). Two maps, two purposes.
- B) Unify into one map: Replace both with a single `GATE_MAPPING` that has both fields: `{ 'clarification': { phase: 'clarify', resumeFrom: 'plan' } }`. Eliminates ambiguity.
- C) Map to resume phase + replace: `GATE_TO_PHASE` maps to the resume-from phase (same semantic as `reviewToPhase`), and replaces `reviewToPhase` entirely. Add clarification entry to this unified map.
**Answer**:

### Q3: Missing `workflow:` Label — Fallback Behavior
**Context**: FR-003 says the label monitor should read the `workflow:*` label to determine `workflowName`. But what happens if the label is missing? This could occur for issues created before this fix is deployed, or if the label was accidentally removed. The spec doesn't define fallback behavior for this case.
**Question**: What should happen when a resume event fires but no `workflow:*` label is found on the issue?
**Options**:
- A) Fall back to existing behavior: Use `parsedName` from the label as `workflowName` (current buggy behavior, but at least the event is processed).
- B) Fall back to `process:*` label lookup: Scan issue labels for `process:speckit-feature` or `process:speckit-bugfix` to infer the workflow name.
- C) Skip the event with a warning: Log a warning and do not enqueue the item. The operator must manually add the `workflow:` label and re-trigger.
- D) Default to `speckit-feature`: Since it's the most common workflow, assume `speckit-feature` when no `workflow:` label is found.
**Answer**:

### Q4: When Exactly to Apply the `workflow:` Label
**Context**: FR-002 says to apply `workflow:<name>` when a workflow starts, either in a new `onWorkflowStart()` method or integrated into the first `onPhaseStart` call. The spec doesn't specify which approach to use or what "first phase" means when a workflow is re-processed (e.g., `process:speckit-feature` is added to an issue that already ran some phases).
**Question**: Where should the `workflow:` label be applied, and should it be idempotent (safe to call multiple times)?
**Options**:
- A) In label-monitor-service on `process:` events: When a `process:*` label is detected, immediately apply `workflow:<name>` before enqueueing. This ensures the label exists before any worker runs.
- B) In `onPhaseStart` for the first phase only: Apply `workflow:<name>` only when `phase === 'specify'` (the first phase). Skip for other phases.
- C) In a new `onWorkflowStart` method called by the worker: The worker calls `labelManager.onWorkflowStart(workflowName)` before entering the phase loop. This method is idempotent (checks if label already exists).
- D) In `onPhaseStart` idempotently: Every `onPhaseStart` call checks if the `workflow:` label exists and adds it if missing. Simple but slightly more API calls.
**Answer**:

### Q5: Per-Issue Sequential Processing Guarantee
**Context**: The spec assumes (in the Assumptions section) that "deferring waiting-for removal to the worker does not introduce new race conditions because the worker processes items sequentially per issue." However, the `WorkerDispatcher` limits total concurrency but does not enforce per-issue serialization. If two events for the same issue are enqueued close together (e.g., `completed:clarification` added twice rapidly, or a `process:` and `completed:` event), two workers could process them concurrently.
**Question**: Is per-issue sequential processing actually guaranteed, or does this need to be addressed?
**Options**:
- A) Already guaranteed by dedup tracker: The existing dedup tracker prevents duplicate processing for the same issue, so this is a non-issue. Confirm this is correct.
- B) Add per-issue locking: Add a lock mechanism in the worker dispatcher so only one worker processes a given issue at a time. Other items for the same issue wait.
- C) Accept the risk: The race is unlikely in practice (events are seconds apart, processing takes minutes). Document it as a known limitation.
**Answer**:

### Q6: PR Feedback Monitor Also Uses workflowName Resolution
**Context**: The `PrFeedbackMonitorService` (pr-feedback-monitor-service.ts) has its own `resolveWorkflowName()` method that scans `process:*` and `completed:*` labels to guess the workflow name. It would benefit from reading `workflow:*` labels too, but the spec doesn't mention updating this service. If left unchanged, PR feedback events may still use incorrect workflow names.
**Question**: Should the `PrFeedbackMonitorService.resolveWorkflowName()` also be updated to read the `workflow:*` label?
**Options**:
- A) Yes, update it: Add `workflow:*` label lookup to `resolveWorkflowName()` as the primary source, falling back to the existing logic. Include this in scope.
- B) No, separate concern: The PR feedback monitor's workflow name resolution is a separate issue. Track it as a follow-up and keep this fix focused on the resume flow.
**Answer**:

### Q7: Color for New `workflow:` Labels
**Context**: FR-001 says to add `workflow:speckit-feature` and `workflow:speckit-bugfix` labels to `WORKFLOW_LABELS` in `label-definitions.ts`. Each label definition requires a color. The spec doesn't specify what colors to use for these new labels.
**Question**: What colors should be used for the `workflow:speckit-feature` and `workflow:speckit-bugfix` labels?
**Options**:
- A) Match existing label color scheme: Use colors consistent with other label categories in `label-definitions.ts` (inspect existing patterns and pick appropriate colors).
- B) Distinct category color: Use a unique color not used by other label prefixes to make `workflow:` labels visually distinct (e.g., a dark blue or teal).
- C) Implementer's choice: Let the implementer pick reasonable colors; this is a cosmetic detail that doesn't affect functionality.
**Answer**:

### Q8: Handling `on-questions` and `on-failure` Gate Conditions on Resume
**Context**: The current gate checker returns gate definitions for ALL conditions (`always`, `on-questions`, `on-failure`), and the phase loop only short-circuits for `condition === 'always'` (phase-loop.ts:186). The spec focuses on `always` gates but doesn't address how resume should work for `on-questions` or `on-failure` gates. If these gate types are added in the future, will the same resume flow work?
**Question**: Should the gate re-firing prevention (from Q1) also handle `on-questions` and `on-failure` gate conditions, or is `always` the only condition that needs addressing now?
**Options**:
- A) Only handle `always` for now: The phase loop only pauses for `always` gates currently. Other conditions are evaluated by the caller and may not pause. No changes needed for them now.
- B) Handle all conditions: Design the gate-skip mechanism to work for any condition type, future-proofing the resume flow.
**Answer**:

### Q9: Existing Test Assertions That Validate Buggy Behavior
**Context**: The existing test suite has assertions that explicitly verify the current (buggy) behavior. For example, `label-monitor-service.test.ts` asserts `workflowName: 'spec-review'` for resume events (the bug this spec fixes). The spec's test plan lists new tests but doesn't mention updating existing tests that assert wrong behavior.
**Question**: Should the spec explicitly list existing tests that need to be updated to reflect the corrected behavior?
**Options**:
- A) Yes, list them explicitly: Add a section identifying existing test assertions that will break and need updating. This prevents surprises during implementation.
- B) No, implied by the changes: It's understood that fixing the code will require fixing the tests. The implementer will handle this naturally.
**Answer**:

### Q10: Label Removal Timing in Worker — Before or After Phase Execution
**Context**: FR-005 says to move `waiting-for:` label removal to `label-manager.ts`, called after successful phase resolution in the worker. But "after phase resolution" is ambiguous — it could mean (a) immediately after `resolveStartPhase` returns (before the phase executes), or (b) after the resumed phase completes successfully. The timing affects what labels are visible on the issue during execution, which matters for debugging and observability.
**Question**: When exactly should the worker remove the `waiting-for:` and `agent:paused` labels?
**Options**:
- A) After phase resolution, before execution: Remove them right after `resolveStartPhase` succeeds but before the phase loop starts. The issue shows the phase is actively running (no stale `waiting-for:` label).
- B) After the first phase completes: Remove them after the resumed phase executes successfully. If the phase fails, the `waiting-for:` label remains, signaling the gate wasn't actually cleared.
- C) At the start of `onPhaseStart`: Remove them as part of `labelManager.onPhaseStart()` for the resumed phase. This integrates naturally into the existing label lifecycle.
**Answer**:
