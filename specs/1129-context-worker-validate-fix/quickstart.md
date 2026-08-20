# Quickstart: Route validate failures into the remediate loop

## What changes

A failing `validate` phase no longer takes a one-shot side path. With `review`
enabled, it routes into the engine-native **remediate → review → validate** loop:
the failure synthesizes a `changes-required` review artifact, the shared
`maxRemediations`-bounded seam drives a fix, then review and validate re-run.

## Enable

The feature is only live when the review phase is in the effective sequence:

```bash
export WORKER_REVIEW_PHASE_ENABLED=true   # reviewPhaseEnabled = true
```

With `reviewPhaseEnabled=false` (default), validate keeps its current handling and
this feature is inert (byte-identical — SC-005).

## Observed happy path (SC-001)

```
… implement → review(clean) → validate(RED)
      └─ synthesize changes-required artifact (round++), backtrack to review
         review(skipped, artifact intact) → remediate(thin adapter fixes)
         → review(real, delta-scoped, clean) → validate(GREEN) → ready
```

## Terminal paths

- **Budget exhausted** (`artifact.round >= maxRemediations`): pauses with
  `waiting-for:remediation-limit` + `agent:paused` (resumable — SC/FR-009). No
  `failed:validate`.
- **Identical failure reproduces** (`REPEAT_FAILURE_THRESHOLD = 2` occurrences of
  the same evidence fingerprint): escalates with `failed:validate-repeated` — the
  sole terminal failure label (FR-006).

## Run the tests

```bash
pnpm --filter @generacy-ai/orchestrator test \
  phase-loop.validate-remediate.integration \
  phase-loop.validate-fingerprint \
  validate-fix-handler.adapter
```

Coverage:
- `phase-loop.validate-remediate.integration` — SC-001 (path order + terminal
  green), SC-004 (≤1 base-merge/cycle), SC-005 (flag-off byte-identical).
- `phase-loop.validate-fingerprint` — SC-002 (`failed:validate-repeated` at
  threshold).
- `validate-fix-handler.adapter` — FR-005/FR-010 (sibling-overlap guard preserved,
  evidence-hash cap removed) and SC-003 (handler invoked only at the remediate
  seam).

## Key files

| File | Role |
|------|------|
| `worker/phase-loop.ts` | routing, review-skip on synthesis, remediate-seam dispatch |
| `worker/validate-fix-handler.ts` | thin adapter (interim remediate behavior) |
| `worker/review-artifact.ts` | `writeReviewArtifact` / `computeVerdict` (reused) |
| `worker/failure-fingerprint.ts` | fingerprint backstop (reused, unchanged) |

## Changeset

```bash
# .changeset/1129-validate-remediate-routing.md
# @generacy-ai/orchestrator: patch  (workflow:speckit-bugfix, no new exports/labels)
```
