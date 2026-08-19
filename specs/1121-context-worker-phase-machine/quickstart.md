# Quickstart: `review` and `remediate` phase machinery

**Issue**: generacy-ai/generacy#1121 | **Epic**: generacy-ai/generacy#1120

This feature adds the `review` (linear, after `implement`) and `remediate` (off-sequence) phases to the worker phase machine — **type/config/label plumbing plus stub execution wiring only**. Both phases are inert: `review` is feature-flagged OFF by default and skipped; `remediate` has no production trigger.

## Verify the build and tests

```bash
pnpm -r build
pnpm -r test
```

All of orchestrator, config, cockpit, launcher, and workflow-engine suites must be green (SC-001).

## Inspect the new vocabulary

`review` is now a linear phase for feature/bugfix; `remediate` is in no sequence:

```ts
import { getPhaseSequence } from '@generacy-ai/orchestrator/worker/types';

getPhaseSequence('speckit-feature');
// ['specify','clarify','plan','tasks','implement','review','validate']

getPhaseSequence('speckit-bugfix');
// ['specify','clarify','plan','tasks','implement','review','validate']

getPhaseSequence('speckit-epic');
// ['specify','clarify','plan','tasks']   ← unchanged
```

`remediate` appears in none of them (FR-004).

## The `review` feature flag (default OFF)

`review` is present in the type/sequence but skipped at execution unless enabled. Two ways to flip it on (for later epic work — leave OFF for this issue):

- Config: `WorkerConfig.reviewPhaseEnabled: true`
- Env: `WORKER_REVIEW_PHASE_ENABLED=true`

With the flag OFF (the default), a live feature/bugfix run emits **no** `phase:review` / `completed:review` label, **no** stage comment, and **no** journal entry — byte-identical to before (SC-004).

## Per-phase config (accepted, optional)

Both new phases accept timeout and agent overrides on the same footing as existing phases (FR-005). Absence falls back to the flat defaults — no migration needed for existing clusters:

```yaml
# .generacy/config.yaml (illustrative)
phaseTimeoutOverrides:
  review: 900000       # optional; falls back to phaseTimeoutMs if omitted
  remediate: 900000
agents:
  phases:
    review:    { model: ..., effort: ... }   # optional
    remediate: { model: ..., effort: ... }
```

## Labels

Full phase-progress families exist for both phases (parity with existing phases, Q3=A):

- `phase:review`, `completed:review`, `failed:review`, `failed:review-repeated`
- `phase:remediate`, `completed:remediate`, `failed:remediate`, `failed:remediate-repeated`

No new `waiting-for:` gate labels are added. The existing `waiting-for:implementation-review` gate stays on `implement` (FR-010).

## The off-sequence `remediate` seam (test-only)

`remediate` is reachable only via the phase-loop unit test, which injects a fire-once-then-false `remediateTrigger` predicate. In production the predicate is undefined, so the seam is dead (FR-007, Q4=A). The test proves: off-sequence entry, return-to-`review`, and termination.

## Run the audit test

The committed exhaustiveness audit fails if any duplication site drifts:

```bash
pnpm --filter @generacy-ai/orchestrator test phase-vocabulary-audit
```

## Troubleshooting

- **A `Record<WorkflowPhase, …>` compile error after editing the union** → you added a phase to `WorkflowPhase` but missed a map (e.g. `PHASE_TO_STAGE`). Add the missing key; the compiler names the site.
- **`phase-vocabulary-audit` fails naming a site** → that duplication site is missing `review`/`remediate`. Add the two members there (see `contracts/phase-vocabulary.md`).
- **Audit fails on a sequence assertion** → `remediate` leaked into a sequence, or `speckit-epic` changed. Revert that edit.
- **An existing feature/bugfix run now shows `phase:review`** → the feature flag is ON. Ensure `reviewPhaseEnabled` is false / `WORKER_REVIEW_PHASE_ENABLED` unset for this issue.
- **A `/speckit:review` or `/speckit:remediate` command is being spawned** → a launcher `PhaseIntent['phase']` union was widened (D-3 violation). Revert; those unions are intentional subsets.

## Next step

`/speckit:tasks` to generate the dependency-ordered task list.
