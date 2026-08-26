# Quickstart: Wire the PR review-posting + draft/ready lifecycle (#1156)

Orchestrator-internal defect fix. No new public exports, no cross-package surface, no cluster migration.

## What changes

| File | Change |
|------|--------|
| `review-findings-bridge.ts` (NEW) | Pure `bridgeReviewArtifact()` + `synthesizeMarker()`. |
| `review-artifact.ts` | `+ markedReadyByEngine: z.boolean().default(false)`; `+ setMarkedReadyByEngine()` helper. |
| `review-executor.ts` | Carry `markedReadyByEngine` forward in the round-rewrite write. |
| `review-poster.ts` | `prNumber: number` → `getPrNumber: () => number \| undefined`; resolve-or-skip per method. |
| `pr-manager.ts` | Optional `workflowId?` ctor arg; persist flag on markReady; reconstruct + persist-false on convert. |
| `phase-loop.ts` | Review side-effect block reads `{ artifact, round }`; passes sidecar round. |
| `claude-cli-worker.ts` | Construct `ReviewPoster` with the getter; wire `readFindingsArtifact`; pass `workflowId` to `PrManager`. |

## Build & test

```bash
pnpm --filter @generacy-ai/orchestrator build
pnpm --filter @generacy-ai/orchestrator test
```

New / updated tests:

```bash
# NEW
review-findings-bridge.test.ts            # SC-002 no finding dropped + severity matrix + marker stability
review-poster.get-pr-number.test.ts       # SC-003 live number, skip-when-undefined, never PR #0
review-artifact.marked-ready.test.ts      # persist/read/back-compat default; carry-forward across rounds
pr-manager.cross-run-draft.test.ts        # SC-005 reconstruct-from-sidecar convert + SC-006 human-ready no-op
# MOD (surface change: getter + { artifact, round })
phase-loop.review-side-effects.test.ts    # SC-001 one COMMENT review; SC-004 re-entry round>=2
```

Existing tests that inject the old surfaces and must be updated in lockstep:
`phase-loop.review-clean.integration.test.ts`, `phase-loop.merge-conflict-scoped-review.*`,
`phase-loop.review-remediate.*`, `phase-loop.review-remediate-convergence.*`,
`phase-loop.remediation-cap.*`, and `__tests__/helpers/bugfix-harness.ts` (`makeFindingsReader`).

## Enabling the path

The whole block stays inert unless the review phase runs:

- `reviewPhaseEnabled=false` (default) → `review` is absent from the effective sequence → block never matches.
- Set `WORKER_REVIEW_PHASE_ENABLED=true` and complete a `review` phase that produces a sidecar to exercise posting.

## Verify end-to-end

1. Run a `speckit-feature` loop with `WORKER_REVIEW_PHASE_ENABLED=true`.
2. `review` completes → exactly one COMMENT-event review posted per round with the engine markers.
3. Clean verdict → PR marked ready-for-review ahead of validate.
4. Pause + re-enter at sidecar `round >= 2` → fresh post (no dedupe-skip) + prior resolved-finding threads resolved.
5. `address-pr-feedback` re-entry in a new run → engine-marked-ready PR converts back to draft; human-marked-ready PR untouched.

## Changeset

`.changeset/1156-wire-review-posting-lifecycle.md` — `@generacy-ai/orchestrator` **patch** (defect fix, no new public exports).
