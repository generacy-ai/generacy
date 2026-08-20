# Feature Specification: Route validate failures into the remediate loop

**Branch**: `1129-context-worker-validate-fix` | **Date**: 2026-08-20 | **Status**: Draft

## Summary

Validate failures currently take a separate, one-shot recovery path
(`worker/validate-fix-handler.ts`): exactly one autonomous fix attempt per
distinct evidence hash, and only when `resumeReason === 'base-advance'`
(`phase-loop.ts:843-887`). First-time reds never auto-fix — they escalate
straight through `LabelManager.onError('validate')` → `failed:validate`.

This feature routes validate failures into the same engine-native
**remediate → review → validate** loop introduced by the review/remediate epic
(#1120, #1124). A failing validate captures its failure evidence, enters
`remediate` (counting against `maxRemediations`), then re-runs `review`
(delta-scoped) and finally re-runs `validate`. The bespoke evidence-hash cap is
superseded by `maxRemediations`; the `worker/failure-fingerprint.ts` backstop
(`failed:validate-repeated`, `REPEAT_FAILURE_THRESHOLD = 2`) remains the terminal
escalation for a genuinely stuck failure. `validate-fix-handler` is retired (or
reduced to a thin adapter) so the old handler and the new loop can never both
fire for the same failure.

## Context

`worker/validate-fix-handler.ts` today allows exactly one autonomous attempt per
distinct evidence hash and only when `resumeReason === 'base-advance'`
(`phase-loop.ts:843-887`). Validate failures should instead enter the standard
remediate loop.

The phase sequence with `review` enabled is
`['specify','clarify','plan','tasks','implement','review','validate']`
(`worker/types.ts`, #1121). `review` already drives an off-sequence `remediate`
via `PhaseLoopDeps.remediateTrigger` (blocking verdict) and backtracks to
`review` (`phase-loop.ts:1270-1281`), bounded by the `on-remediation-limit` gate
against `maxRemediations` (`phase-loop.ts:1122-1145`). Validate sits *after*
review in the sequence, so a validate failure must backtrack through
`remediate → review` before re-running `validate`.

## User Stories

### US1: Validate failures self-heal through the remediate loop

**As a** cluster operator relying on autonomous speckit workflows,
**I want** a failing `validate` phase to enter the remediate → review → validate
loop instead of a one-shot side handler,
**So that** transient and fixable validate failures are corrected automatically
with the same bounded, delta-scoped machinery as review findings — without a
human intervening on the first red.

**Acceptance Criteria**:
- [ ] A `validate` failure captures failure evidence via the existing evidence
      mechanics and enters `remediate`.
- [ ] The remediate attempt counts against the per-workflow `maxRemediations`
      counter (same counter as review-driven remediations).
- [ ] After remediate, `review` re-runs delta-scoped, then `validate` re-runs.
- [ ] A `validate` failure no longer requires `resumeReason === 'base-advance'`
      to trigger autonomous recovery.

### US2: Repeated identical validate failures still escalate

**As a** cluster operator,
**I want** a validate failure that reproduces identically after remediation to
stop looping and escalate,
**So that** a genuinely stuck defect surfaces to a human instead of consuming the
full remediation budget silently or spinning forever.

**Acceptance Criteria**:
- [ ] A repeated identical validate failure escalates via the failure-fingerprint
      backstop (`failed:validate-repeated`) after `REPEAT_FAILURE_THRESHOLD`
      occurrences.
- [ ] When the remediation budget (`maxRemediations`) is exhausted, the loop
      pauses via the `on-remediation-limit` gate rather than continuing.

### US3: Exactly one recovery path fires per validate failure

**As a** maintainer,
**I want** the old `validate-fix-handler` and the new remediate loop to be
mutually exclusive,
**So that** a single validate failure can never be handled twice (double spawn,
double label mutation, or conflicting escalation).

**Acceptance Criteria**:
- [ ] `validate-fix-handler` is retired or reduced to a thin adapter; the
      one-attempt evidence-hash cap is removed as a live gate.
- [ ] No code path invokes both the legacy handler and the remediate loop for the
      same validate failure.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On `validate` failure, capture failure evidence using the existing evidence mechanics (`result.capturedStdout` / `capturedStderr` / `exitCode`) and **synthesize a `changes-required` review findings artifact** from that evidence, then backtrack `i` to `review` so the existing `remediateTrigger`/seam picks it up naturally (Q1→B, Q3→A). | P1 | No new remediate driver; entry is via the same artifact the review seam reads. |
| FR-002 | The validate-triggered remediation counts against the per-workflow `maxRemediations` counter — the same counter used by review-driven remediations. Achieved by advancing the same review findings artifact (bump `round`, set `verdict: 'changes-required'`) so the `on-remediation-limit` gate works unchanged (Q3→A). | P1 | No separate budget for validate; gate #1128 owns is unchanged. |
| FR-003 | After the validate-triggered remediation, re-run `review` (delta-scoped), then re-run `validate`. | P1 | Backtracks through the existing `remediate → review` seam (`phase-loop.ts:1270-1281`) before validate re-runs. |
| FR-004 | Remove the `resumeReason === 'base-advance'` precondition as the gate for autonomous validate recovery; first-time validate reds enter the remediate loop. | P1 | Supersedes `phase-loop.ts:843-887` gating. |
| FR-005 | Reduce `worker/validate-fix-handler.ts` to a **thin adapter** that serves as the interim remediate behavior for validate evidence while `remediate` is still `runStubPhase` (Q2→B). Do **not** fully retire it now, or every validate red would strand at the `on-remediation-limit` pause with no real fix. The one-attempt-per-evidence-hash cap is superseded by `maxRemediations`. | P1 | The adapter keeps a single code path and carries the sibling-overlap guard (FR-010) for free until the real executor lands. |
| FR-006 | Preserve the failure-fingerprint escalation backstop: a repeated identical validate failure escalates via `failed:validate-repeated` (`worker/failure-fingerprint.ts`, `REPEAT_FAILURE_THRESHOLD = 2`). | P1 | Terminal safety net independent of `maxRemediations`. |
| FR-007 | Preserve the base-merge-before-validate cycle semantics: at most one pre-phase base merge per cycle (`phase-loop.ts` #914 per-iteration guard, `runPreValidateBaseMerge`). | P1 | The validate re-run after remediate must still honor one-merge-per-cycle. |
| FR-008 | Guarantee mutual exclusion: the legacy handler and the new remediate loop can never both fire for the same validate failure. | P1 | Structural, not timing-based. |
| FR-009 | When the remediation budget is exhausted for a validate-driven loop, pause via the `on-remediation-limit` gate (`waiting-for:remediation-limit`), consistent with review-driven exhaustion. `failed:validate` is **no longer applied** for a routed validate red; `failed:validate-repeated` (fingerprint) is the sole terminal failure label (Q4→A). | P1 | First-red escalation removed; exhaustion is a resumable gate, not a failure label. |
| FR-010 | Preserve the sibling-owned-file overlap protection when validate failures route through remediate: the remediation prompt/commit must retain sibling-owned-file avoidance and the revert-on-overlap guard (Q5→A). | P1 | Parallel epic siblings (#1128/#1130/#1131/#1132) share one base branch and can recreate each other's files; the thin adapter (FR-005) carries this guard for free. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Harness: a failing `validate` drives `remediate → review → validate-green`. | Path observed end-to-end | Integration test in `packages/orchestrator/src/worker/__tests__/` asserting the phase order and terminal green validate. |
| SC-002 | A repeated identical validate failure escalates via fingerprint. | `failed:validate-repeated` applied at threshold | Test that reproduces the same evidence across remediations and asserts fingerprint escalation. |
| SC-003 | No dual path: legacy handler and remediate loop never both fire for one failure. | 0 concurrent invocations | Static/behavioral test asserting the legacy handler is not invoked once the remediate route is active. |
| SC-004 | Base-merge-before-validate remains at most one merge per cycle across the remediate-driven re-run. | ≤ 1 merge/cycle | Test asserting the #914 per-iteration guard still holds through the new backtrack. |
| SC-005 | `reviewPhaseEnabled = false` behavior is byte-identical to pre-change for feature/bugfix runs. | No regression | Existing phase-loop suites pass unchanged with the flag off. |

## Assumptions

- The review/remediate machinery from #1121/#1124 (phase sequence with `review`
  before `validate`, `remediateTrigger` seam, `on-remediation-limit` gate,
  `maxRemediations` resolution) is present on the branch this work builds on.
- Validate is reached only when `review` is enabled in the effective sequence;
  with `reviewPhaseEnabled = false`, validate keeps its current handling and this
  feature is inert (SC-005).
- The delta-scoping used by review convergence (`runReviewConvergence`,
  phase-start-ref window) is the correct scoping mechanism for the post-validate
  re-review; no new scoping primitive is introduced.
- Failure evidence for a validate failure is fully available in the validate
  `catch` block at the point remediation is triggered.

## Out of Scope

- Changes to `worker/failure-fingerprint.ts` semantics or the repeat threshold.
- Changes to the base-merge implementation (`worker/base-merge.ts`) beyond
  preserving one-merge-per-cycle.
- The concrete `remediate` executor logic (deferred to later epic issues); this
  feature only routes validate failures into the existing seam.
- Cloud-side relay/UX for the retired `cluster.validate-fix` channel.
- Migration/cleanup of already-applied `blocked:stuck-validate-fix` labels on
  in-flight issues.

---
Part of epic generacy-ai/generacy#1120 (engine-native review & remediate phases).
Full design: `docs/engine-review-remediate-plan.md` in generacy-ai/tetrad-development;
a condensed design summary lives in the epic body.

---

*Generated by speckit*
