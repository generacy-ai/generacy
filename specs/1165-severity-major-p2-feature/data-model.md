# Data Model: Flag-matrix guardrails (#1165)

This feature adds no new persisted entities and no new schema. It touches existing
in-flight state and one function's return value. The "entities" below are the
existing shapes the four corners read or mutate.

## E1 — `WorkflowPhase` sequence (Corner 4)

- **Type**: `WorkflowPhase[]` returned by `getPhaseSequence(workflowName,
  reviewPhaseEnabled)` (`packages/orchestrator/src/worker/types.ts:85`).
- **`PHASE_SEQUENCE`**: `['specify','clarify','plan','tasks','implement','review','validate']`.
- **`WORKFLOW_PHASE_SEQUENCES`** (known workflows only):
  - `speckit-feature` → `PHASE_SEQUENCE`
  - `speckit-bugfix` → `PHASE_SEQUENCE`
  - `speckit-epic` → `['specify','clarify','plan','tasks']`
- **Current rule**: `base = WORKFLOW_PHASE_SEQUENCES[workflowName] ?? PHASE_SEQUENCE;
  return reviewPhaseEnabled ? base : base.filter(p => p !== 'review')`.
- **New rule (Corner 4)**: when `WORKFLOW_PHASE_SEQUENCES[workflowName] ===
  undefined` (unknown workflow), the result **never** contains `review`,
  regardless of `reviewPhaseEnabled`. Known workflows keep the flag-conditional
  behavior.
- **Truth table**:

  | workflow          | reviewPhaseEnabled | `review` in result? |
  |-------------------|--------------------|---------------------|
  | speckit-feature   | false              | no                  |
  | speckit-feature   | true               | yes                 |
  | speckit-bugfix    | true               | yes                 |
  | speckit-epic      | true               | no (not in its seq) |
  | *unknown-custom*  | false              | no                  |
  | *unknown-custom*  | **true**           | **no** (was: yes)   |

  Only the last row changes. `remediate` is off-sequence in all rows (never a
  linear member) — excluding `review` removes the loop's only entry point.

## E2 — Review artifact sidecar (Corner 1)

- **Read/write**: `readReviewArtifact` / `writeReviewArtifact` /
  `readReviewArtifactSync` (`packages/orchestrator/src/worker/review-artifact.ts`),
  keyed by `workflowId = `${owner}/${repo}#${issueNumber}``, stored at the
  checkout sidecar path.
- **Shape** (existing, unchanged): `{ findings: ReviewFinding[]; verdict:
  'clean' | 'changes-required'; round: number; lastReviewedCommitSha: string;
  remediationCount: number; markedReadyByEngine: boolean }`.
- **`ReviewFinding`** (existing): `{ id, severity: 'critical'|'major'|'minor',
  file, title, detail, round, status: 'open'|'resolved' }`.
- **Corner 1 usage**: the flag-OFF fallback synthesizes the **same**
  `changes-required` artifact the flag-ON path writes at `phase-loop.ts:1038-1075`
  — one `critical` open finding citing `effectiveValidateCommand` +
  fenced/bounded validate output, carrying `remediationCount` and
  `markedReadyByEngine` forward. `RemediateExecutor.execute` then reads this
  artifact to build its charter and bumps `remediationCount`. No new fields.

## E3 — Block-local loop flags (Corner 1)

- **Existing**: `pendingValidateRemediation: boolean` (block-local in
  `executeLoopInner`) marks a validate-origin backtrack so the following `review`
  re-entry runs the real executor.
- **New**: `flagOffValidateFixAttempted: boolean` (block-local in
  `executeLoopInner`, initialized `false`). Set `true` when the flag-OFF fallback
  fires; guards the fallback branch so it runs **at most once** per phase-loop
  execution. Not persisted — a fresh run (or worker restart) resets it, which is
  the intended "one attempt per run" semantics.

## E4 — Gate definitions (Corner 3, read-only)

- **Shape**: `GateDefinition = { phase: WorkflowPhase; gateLabel: string;
  condition: GateCondition }` in `config.gates: Record<string, GateDefinition[]>`.
- **speckit-bugfix `implementation-review` gate** across flag states (the test's
  assertion target — no mutation):
  - `ciMergeGateEnabled === false`: `{ phase: 'implement', gateLabel:
    'waiting-for:implementation-review', condition: 'on-request' }`.
  - `ciMergeGateEnabled === true`: `{ phase: 'validate', gateLabel:
    'waiting-for:implementation-review', condition: 'on-ci-green' }` (via the
    #1133 transform at `config.ts:229-247`).

## E5 — `blocked:stuck-feedback-loop` label (Corner 2, read-only)

- **Constant**: `BLOCKED_STUCK_FEEDBACK_LOOP_LABEL = 'blocked:stuck-feedback-loop'`
  (`pr-feedback-handler.ts:45`), applied at `:632`. No schema/behavior change —
  the only change for Corner 2 is prose in the migration guide. The invariant
  (FR-004): the flag-OFF PR-feedback monitor's `blocked:*` skip continues to bound
  the #883 runaway.
