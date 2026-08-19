# Clarifications: Review/remediate foundations wired end-to-end (stub executors)

Issue: generacy-ai/generacy#1123

## Batch 1 — 2026-08-19

### Q1: Dependency landing strategy
**Context**: The spec (Assumptions §80) assumes #1121 and #1122 are merged so `WorkflowPhase` includes `review`/`remediate` and per-workflow config is parseable. But neither is present on this branch **or** on `develop`: `packages/orchestrator/src/worker/types.ts:9` still declares the 6-phase union, and there is no `maxRemediations`/review-profile schema anywhere. Every P1 test depends on those members existing. This is the top blocker.
**Question**: How should #1123 obtain the `review`/`remediate` union members and per-workflow config?
**Options**:
- A: This branch **co-lands** the minimal union + config additions itself (adds `review`/`remediate` to `WorkflowPhase` and the `maxRemediations`/review-profile fields), i.e. #1121/#1122 are absorbed here.
- B: Assume #1121/#1122 merge to `develop` first; this branch is **rebased** on them and adds only tests + the contract note (implement phase blocks until they land).
- C: Add the union/config members as **test-only fixtures/doubles** in the harness, leaving production types unchanged until #1121/#1122 land.

**Answer**: B — Assume #1121/#1122 merge to `develop` first; this branch is rebased on them and adds only tests + the contract note (implement phase blocks until they land). Rationale: #1123 is the epic's integration checkpoint whose purpose is to prove #1121+#1122 wired together; they are orthogonal and land as their own independent PRs. Co-landing (A) collapses three issues into one and conflicts with #1121/#1122's PRs; test-only doubles (C) would test a fake universe that never exercises the real production types (FR-006's audit must run on the real union).

### Q2: How the stub harness enters `remediate` (loop-control seam)
**Context**: FR-003 calls `remediate` "reachable off-sequence via loop control" and names this "the loop-control seam of record" (FR-007). To assert it, the harness needs a concrete trigger, but the mechanism is unspecified.
**Question**: What is the trigger that steers the loop off-sequence into `remediate`?
**Options**:
- A: The **stub review executor returns a verdict** ("needs remediation") that the phase loop reads to schedule `remediate`.
- B: A **gate/label** (e.g. `waiting-for:remediation`) drives entry, resolved by the existing resume/gate machinery.
- C: A **direct loop-control return value** from the phase-loop step contract (a new discriminated outcome, e.g. `{ next: 'remediate' }`) independent of any review verdict.

**Answer**: C — A direct loop-control return value from the phase-loop step contract (a new discriminated outcome, e.g. `{ next: 'remediate' }`) independent of any review verdict. Rationale: the design has three remediate entry points (review verdict, validate failure, external PR feedback) all converging on "entered only via loop control", so a general discriminated loop-control outcome is the seam-of-record that P3 (absorbing validate-fix + pr-feedback) can reuse. A review-verdict-only trigger (A) serves just one path; a gate/label (B) requires a `waiting-for:remediation` label #1121 Q3=A does not add.

### Q3: Resume target when paused mid-`remediate`
**Context**: US2's acceptance criterion is explicitly unresolved: "Pausing in `remediate` and resuming lands the loop back at `remediate` (**or** its documented re-`review` target, per the seam)." The `GATE_MAPPING` entry's `resumeFrom` must pick exactly one.
**Question**: On resume after a pause during `remediate`, which phase should the loop resolve to?
**Options**:
- A: Back to **`remediate`** (re-enter the remediation step).
- B: To **`review`** (the delta-scoped re-review that remediate always backtracks to).

**Answer**: A — Back to `remediate` (re-enter the remediation step). Rationale: the design doc's remediation-limit gate specifies "human answer resumes into remediate and resets the counter", and remediate must be resumable and partial-work-safe; resuming into remediate to finish is the design-faithful semantics, not re-reviewing incomplete work. The pause-context sidecar already resumes the exact interrupted phase (merge-conflict precedent).

### Q4: Where per-workflow config is observed inside the loop
**Context**: FR-004/SC-003 require `maxRemediations` (feature 3 / bugfix 2) and the review profile to be "observable inside the phase loop." The read surface is unspecified, and the stub test needs a definite place to read from. Worker gate/config lives in `packages/orchestrator/src/worker/config.ts`; broader config lives in `@generacy-ai/config`.
**Question**: Through which surface does the loop expose these values, and where does the schema live?
**Options**:
- A: On **`WorkerConfig`/`WorkerContext`** already threaded into the loop; schema added to `packages/orchestrator/src/worker/config.ts` (alongside `gates`).
- B: In **`@generacy-ai/config`** (workspace/workflow config) and read via the config object the worker already holds.
- C: A **new phase-loop dependency** (injected value on the loop deps) that the stub executor reads directly.

**Answer**: B — In `@generacy-ai/config` (workspace/workflow config), read via the config object the worker already holds. Rationale: per #1122 Q1=A the per-workflow schema lives in OrchestratorSettings (`@generacy-ai/config`), and per #1122 Q4=A the resolved values come from a `worker/config.ts` resolver over the OrchestratorSettings the worker already loaded — so the loop reads them via that held config object, not a `WorkerConfig` field. Option A contradicts #1122 Q1; a new injected loop dependency (C) is unnecessary plumbing.

### Q5: Stage + gate-label assignment for the new phases
**Context**: US3's phase-union audit requires every total `Record<WorkflowPhase, …>` to enumerate the new phases. `PHASE_TO_STAGE` (types.ts) maps each phase to `specification|planning|implementation`, and `GATE_MAPPING`/`WORKFLOW_GATE_MAPPING` (phase-resolver.ts) map gate labels to phases. Both need entries for `review`/`remediate`, and pause/resume (FR-005) depends on the gate labels.
**Question**: What `StageType` do `review` and `remediate` map to, and what gate labels back them?
**Options**:
- A: Both map to **`implementation`** stage; gates `waiting-for:review` and `waiting-for:remediation` (following the existing `waiting-for:*` convention).
- B: A **new `StageType`** (e.g. `review`) is introduced for these phases; new gate labels as above.
- C: Defer stage/gate naming to the plan phase — assert only *that* entries exist and round-trip, not their specific names.

**Answer**: C — Defer stage/gate naming to the plan phase; assert only *that* entries exist and round-trip, not their specific names. Rationale: option B (new StageType) contradicts #1121 FR-002, which fixes review/remediate → implementation stage; option A invents a `waiting-for:review` gate the design explicitly does not want (review is autonomous — the only human gates are remediation-limit and final approval). C neither re-decides #1121's implementation-stage nor hardcodes design-wrong / upstream-owned gate labels.
