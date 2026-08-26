# Contract: `phase-vocabulary-audit.test.ts`

**Issue**: generacy-ai/generacy#1121 | **Delivers**: FR-011 / SC-003 (Q5=A)

A committed automated test that enumerates the phase-literal duplication sites and fails when one drifts. Follows the established `label-protocol-audit.test.ts` / `phase-tracker-audit.test.ts` pattern.

**Location**: `packages/orchestrator/src/__tests__/phase-vocabulary-audit.test.ts`

## Required assertions

### A1 — Canonical union contains both phases
`WorkflowPhase` includes `'review'` and `'remediate'`. (Practically asserted via a value list derived from `PHASE_TO_STAGE` keys, which is compiler-exhaustive.)

### A2 — Sequence placement
- `PHASE_SEQUENCE` contains `'review'` at exactly `indexOf('implement') + 1` and `indexOf('validate') - 1` (i.e. directly between them).
- `PHASE_SEQUENCE` does **not** contain `'remediate'`.

### A3 — Per-workflow sequences
- `getPhaseSequence('speckit-feature')` and `getPhaseSequence('speckit-bugfix')` contain `'review'` immediately after `'implement'`.
- `getPhaseSequence('speckit-epic')` deep-equals `['specify','clarify','plan','tasks']`.
- No sequence contains `'remediate'`.

### A4 — Exhaustive stage map
`PHASE_TO_STAGE['review'] === 'implementation'` and `PHASE_TO_STAGE['remediate'] === 'implementation'`. (Exhaustiveness itself is compiler-guaranteed; this pins the stage value.)

### A5 — Full-vocabulary sites include both phases
For each full-vocabulary site (#1–#9 in `phase-vocabulary.md`) that is reachable at runtime, assert the parsed/exported vocabulary includes `'review'` and `'remediate'`. Where a site is a Zod schema, probe by `.parse()` of a value using the new key (accept) and/or introspect `.options` / `.keyof().options`.

### A6 — Label families registered
Via the LabelManager runtime probe (mirroring `label-protocol-audit`): iterating `PHASE_SEQUENCE` registers `phase:review` and `completed:review`. Additionally assert the four families exist in `WORKFLOW_LABELS` for both `review` and `remediate`: `phase:`, `completed:`, `failed:`, `failed:*-repeated`. Assert **no** `waiting-for:review` / `waiting-for:remediate` label exists.

### A7 — Intentional subsets documented
Assert the two launcher `PhaseIntent['phase']` unions do **not** include `review`/`remediate`, and carry a documented exclusion in the test's exclusion set (so the audit is a deliberate contract, not a silent gap). If a future edit adds them, the test's exclusion list forces a conscious update.

## Drift behavior

- Missing a full-vocabulary site → A5/A6 fails, naming the site.
- `remediate` leaking into a sequence → A2/A3 fails.
- `speckit-epic` sequence change → A3 fails.
- Removing a label family → A6 fails.

## Non-goals

- Does not exercise the real (out-of-scope) executors.
- Does not assert the feature-flag runtime skip (covered by the phase-loop unit test, US1 AC4) or the remediate seam (covered by the phase-loop unit test, US2 AC1/AC2).
