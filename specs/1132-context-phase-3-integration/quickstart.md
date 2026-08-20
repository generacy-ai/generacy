# Quickstart: Phase-3 integration (full review⇄remediate loop end-to-end)

Issue: generacy-ai/generacy#1132 · Branch: `1132-context-phase-3-integration`

## What this ships

Three integration scenarios + a loop-contract pin note. **No product behavior** (FR-008). Unlike P2, **nothing is doubled**: the real `remediate` executor (#1128), validate→remediate routing (#1129), and the real `PrFeedbackMonitorService` exclusion + external-feedback routing (#1130) all run (Assumption §89).

## Prerequisites

- #1128, #1129, #1130, #1131 merged to `develop`; this branch **rebased** on them. Until then the implement phase dependency-blocks (skip→requeue-after-deps).
- Node >= 22, `pnpm install`.

## Run the suite

```bash
# All Phase-3 integration scenarios
pnpm --filter @generacy-ai/orchestrator test -- review-remediate-convergence remediation-cap pr-feedback-external-remediate

# Individual suites
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.review-remediate-convergence.integration
pnpm --filter @generacy-ai/orchestrator test -- phase-loop.remediation-cap.integration
pnpm --filter @generacy-ai/orchestrator test -- pr-feedback-external-remediate.integration
```

## What each suite proves

| Suite | Proves | FR / SC |
|---|---|---|
| `phase-loop.review-remediate-convergence.integration.test.ts` | `implement → review (2 blocking) → remediate → re-review (1 resolved/1 open) → remediate → re-review clean → ready → validate fail → remediate → re-review → validate green`, both workflows; exercises the review-blocking **and** validate-failure entry points | FR-001, SC-001/005/006 |
| `phase-loop.remediation-cap.integration.test.ts` | counter → `maxRemediations` raises `waiting-for:remediation-limit` (zero terminal `blocked:*`), surfaces open findings, human answer resets counter, loop converges | FR-002, SC-003 |
| `pr-feedback-external-remediate.integration.test.ts` | **real** `PrFeedbackMonitorService`: external feedback re-enters `remediate` + PR→draft; engine-authored (marker) threads excluded; clean re-review re-marks ready | FR-003, SC-004 |

## Contract artifacts

- `contracts/loop-convergence-contract.md` — pins the phase-sequencing, three-entry-point, counter/cap/reset, draft/ready, and engine-thread-exclusion invariants, cross-referencing #1128–#1131 as authorship home (FR-007) and pinning #1131's deferred merge-conflict entry (Q1=B).
- Cross-references `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md` (loop-control backtrack) and `specs/1127-context-phase-2-integration/contracts/engine-review-integration.md` (marker + findings artifact).

## Troubleshooting

- **`review` skipped / order is `implement → validate`**: `reviewPhaseEnabled` not true — pass `getPhaseSequence(workflow, true)` and `createConfig({ reviewPhaseEnabled: true })`.
- **Verdict won't go clean/blocking per round**: verdict is steered by **seeding the findings sidecar** the review executor reads (Q2=A) — the executor recomputes via `computeVerdict`; do not steer through CLI output. See `research.md` Decision 2.
- **Cap gate never resets / loop hangs at `waiting-for:remediation-limit`**: the reset trigger is #1128's; inject it through the gate/resume seam #1128 ships (Q4=C) — the harness asserts observable reset + convergence, not the trigger shape.
- **External feedback doesn't re-enter `remediate`** / **engine thread wrongly re-enters**: US3 drives the **real** monitor (Q3=A) — confirm #1130's `matchEngineAuthoredReviewMarker` wiring is present post-rebase; the marker is `generacy-engine-review` (`review-poster.ts:23,64`).
- **Merge-conflict entry expected**: out of scope — #1131 is pinned in the contract, not scenario-tested (Q1=B).

## Changeset

Test-only diff under `packages/orchestrator/src/**` plus a spec `contracts/` doc ⇒ changeset-exempt, add **none** (mirrors #1123/#1127). Only if driving the real monitor or the cap-reset seam requires a **minimal non-test seam** under `packages/*/src/` does the gate trigger → add `.changeset/1132-loop-convergence-integration.md` (`@generacy-ai/orchestrator` **patch**, no new public exports). Decide at implement time. See `plan.md` → Changeset.
