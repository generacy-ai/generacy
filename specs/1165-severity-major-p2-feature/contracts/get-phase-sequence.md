# Contract: `getPhaseSequence` fallback gating (Corner 4)

**File**: `packages/orchestrator/src/worker/types.ts`
**Function**: `getPhaseSequence(workflowName: string, reviewPhaseEnabled = false): WorkflowPhase[]`

## Behavior

1. Resolve `known = WORKFLOW_PHASE_SEQUENCES[workflowName]`.
2. If `known !== undefined` (known workflow): return the flag-conditional result —
   `reviewPhaseEnabled ? known : known.filter(p => p !== 'review')`. **Unchanged.**
3. If `known === undefined` (unknown/custom workflow): return `PHASE_SEQUENCE`
   with `review` **always** filtered out, regardless of `reviewPhaseEnabled`.
   `remediate` is off-sequence in `PHASE_SEQUENCE`, so no extra filter is needed to
   exclude it.

## Invariants

- **INV-1**: For any `workflowName` not in `WORKFLOW_PHASE_SEQUENCES`, the returned
  array never contains `'review'` — for either flag value. (SC-002 precondition:
  no `review` ⇒ no review↔remediate loop ⇒ no uncapped loop.)
- **INV-2**: Known workflows are byte-identical to pre-change (FR-009). In
  particular a flag-OFF `speckit-feature` still returns the review-stripped
  `PHASE_SEQUENCE`, and a flag-ON `speckit-feature` still includes `review`.
- **INV-3**: The function remains pure and side-effect-free.

## Test assertions (FR-008)

- Unknown workflow + `reviewPhaseEnabled = true` ⇒ result excludes `review`
  (the row that changes).
- Unknown workflow + `reviewPhaseEnabled = false` ⇒ result excludes `review`.
- `speckit-feature` + `true` ⇒ includes `review` (regression guard).
- `speckit-feature` + `false` ⇒ excludes `review` (regression guard).
- `speckit-epic` (any flag) ⇒ never includes `review` (its literal sequence
  omits it).
- An integration-style assertion (may live in the phase-loop test): an unknown
  workflow with `reviewPhaseEnabled = true` driven through the loop terminates —
  it never enters `review`, so the uncapped loop is unreachable.
