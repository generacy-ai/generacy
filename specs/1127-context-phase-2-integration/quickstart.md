# Quickstart: Phase-2 integration (implement→review→ready flow)

Issue: generacy-ai/generacy#1127 · Branch: `1127-context-phase-2-integration`

## What this ships

Integration tests + a contract pin note. **No product behavior** (Q1=A). The `remediate` used is a test-only stub (Q3=A). `PrFeedbackMonitorService` is not modified (Q4=B).

## Prerequisites

- #1124, #1125, #1126 merged to `develop`; this branch **rebased** on them. Until then the implement phase dependency-blocks (skip→requeue-after-deps).
- Node >= 22, `pnpm install`.

## Run the suite

```bash
# All Phase-2 integration tests
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.review

# Individual suites
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.review-clean.integration
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.review-remediate.integration
pnpm --filter @generacy-ai/orchestrator test -- engine-authored-marker
```

## What each suite proves

| Suite | Proves | FR / SC |
|---|---|---|
| `phase-loop.review-clean.integration.test.ts` | `implement → review → clean verdict → COMMENT review (marker) → markReadyForReview → validate`, both workflows | FR-001/002/003, SC-002/003 |
| `phase-loop.review-remediate.integration.test.ts` | blocking verdict → off-sequence stub `remediate` → ready→draft → delta-scoped re-`review` → clean → re-ready | FR-004, SC-004 |
| `engine-authored-marker.test.ts` | standalone marker-match helper excludes engine-authored review threads; monitor untouched | FR-005, SC-005 |

## Contract artifacts

- `contracts/engine-review-integration.md` — pins the engine-authored marker + findings-artifact shapes, cross-referencing #1124/#1125 as authorship home (FR-006/FR-007, SC-006).
- Cross-references `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md` for the loop-control backtrack.

## Troubleshooting

- **`review` skipped / order is `implement → validate`**: `reviewPhaseEnabled` not true — pass `getPhaseSequence(workflow, true)` and `createConfig({ reviewPhaseEnabled: true })`.
- **`remediate` never entered**: `deps.remediateTrigger` is `undefined` (production default) — inject a fire-once (or verdict-bound) trigger.
- **Marker assertion fails on a quoted body**: expected — `> `-quoted markers do not match (line-anchored, case-sensitive precedent).
- **Verdict won't go clean/blocking**: the verdict is steered through the review executor's input (findings sidecar / CLI output), bound to #1124's actual lever at implement time — see `research.md` Decision 2.

## Changeset

Test-only diff (D-3 preferred path) ⇒ changeset-exempt, add none. If the D-3 fallback ships a marker-match helper under `packages/orchestrator/src/worker/`, add `.changeset/1127-engine-review-integration.md` (`@generacy-ai/orchestrator` patch). See `plan.md` → Changeset.
