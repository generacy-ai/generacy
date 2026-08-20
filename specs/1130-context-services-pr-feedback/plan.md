# Implementation Plan: PR-feedback monitor — exclude engine threads, route external feedback into remediate

**Feature**: Rewire `PrFeedbackMonitorService` to (a) exclude engine-authored review threads from the trigger and (b) route genuine external trusted feedback into the engine's shared `review`/`remediate` loop instead of the legacy `pr-feedback-handler` fixer; retire the `blocked:stuck-feedback-loop` dead-end in favor of the `waiting-for:remediation-limit` gate.
**Branch**: `1130-context-services-pr-feedback`
**Status**: Complete

## Summary

Today `PrFeedbackMonitorService` triggers on any unresolved *trusted* review thread and
enqueues `command: 'address-pr-feedback'` into the legacy fixer (`worker/pr-feedback-handler.ts`),
which applies a divergent `blocked:stuck-feedback-loop` dead-end on stuck cycles. With the
engine-native review & remediate phases (epic #1120), the engine posts its **own** review
threads carrying engine-authored markers (#1125/#1127). This feature makes two behavior changes
and one retirement:

1. **Exclude engine-authored threads from the trigger** (FR-001/FR-010). The monitor's trust
   loop drops a thread from the unresolved-trusted count when — and only when — *every* comment
   in that thread is engine-authored (marker-matched). A mixed thread with any external trusted
   comment stays live. Human trust stays authorship-based (`isTrustedCommentAuthor`), never
   content-based (FR-002).

2. **Route external trusted feedback into the shared remediate loop** (FR-003/FR-004). Instead of
   the divergent fixer, the worker's `address-pr-feedback` job becomes a **thin adapter** that
   reuses the legacy dual-source parser (inline threads AND review bodies), writes the extracted
   findings as a checkout-local **external-feedback seed**, then runs the normal phase loop
   entering at `review`. A **seed-aware review wrapper** (injected as `deps.reviewExecutor`)
   consumes the seed on the first round — synthesizing the findings artifact with
   `verdict = changes-required` so the existing `remediateTrigger` seam fires — and delegates to
   the real `ReviewExecutor` on subsequent (convergence) rounds. One loop, one round counter,
   one code path.

3. **Retire the legacy dead-end** (FR-005/FR-007/FR-008). External-feedback remediations count
   toward the remediation cap and land on `waiting-for:remediation-limit` on exhaustion; the
   `blocked:stuck-feedback-loop` label and its apply-site are deleted. New external feedback
   submitted after the cap resets the counter (FR-006, authorship-based) by clearing the review
   artifact so the next round re-derives `round = 1`.

The review phase is feature-flagged (`reviewPhaseEnabled`, default OFF); when the flag is off
the adapter path is unreachable and the monitor's engine-exclusion is a no-op on repos with no
engine-authored threads, so existing clusters behave identically until the epic is enabled.

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node >=22, pnpm monorepo.
- **Packages touched**:
  - `@generacy-ai/orchestrator` — the monitor service, the worker dispatch branch, the legacy
    fixer (reduced to adapter), a new seed-aware review wrapper, a new external-feedback seed
    module. Internal surface only; no new public exports → **patch**.
  - `@generacy-ai/workflow-engine` — removal of the `blocked:stuck-feedback-loop` label from
    `label-definitions.ts`. Label-vocabulary change → **minor** (per CLAUDE.md changeset rule).
- **Key dependencies (compose with, do not re-implement)**:
  - Engine-authored marker helpers `commentCarriesEngineAuthoredReviewMarker`,
    `matchEngineAuthoredReviewMarker`, `ENGINE_AUTHORED_REVIEW_MARKERS`
    (`worker/review-poster.ts`, #1127).
  - `review`/`remediate` phases, `ReviewExecutor`, findings artifact (`review-artifact.ts`),
    `computeVerdict`, `remediateTrigger` seam, `on-remediation-limit` gate,
    `waiting-for:remediation-limit` label (#1121/#1124/#1125/#1126).
  - Legacy dual-source parser in `pr-feedback-handler.ts` (retained, reused).
- **Feature flag**: `reviewPhaseEnabled` (env `WORKER_REVIEW_PHASE_ENABLED`, default `false`)
  gates `review` into the effective phase sequence via `getPhaseSequence`.
- **No `.specify/memory/constitution.md`** in the repo → constitution check skipped.

## Architectural decisions

### D-1 — Seed-aware review wrapper (recommended)

`ReviewExecutor.execute()` **overwrites** the findings artifact with a fresh CLI diff-review
every round (`review-executor.ts` steps 5–10). Seeding external feedback *directly* into the
artifact would be clobbered by that fresh review — the exact "fresh diff review silently
dropping body-only asks" failure that clarification Q1's rationale warns against.

**Decision**: wrap the review phase. Inject a thin `SeedAwareReviewExecutor` as
`deps.reviewExecutor` (same slot `claude-cli-worker.ts:691` already uses). On `execute(context)`:

- If a checkout-local external-feedback seed exists (`.generacy/external-feedback-<sanitizedId>.json`),
  **skip the CLI**: write the findings artifact from the seed (findings = seed items,
  `verdict = computeVerdict(...) = changes-required`, `round` derived as today), delete the seed,
  return a synthetic success `PhaseResult`. `remediateTrigger` then reads
  `verdict === 'changes-required'` and fires the remediate seam — no monitor/engine divergence.
- Else, delegate to the real `ReviewExecutor.execute(context)` unchanged.

This keeps `review-executor.ts` and `phase-loop.ts` **untouched** (both are Out of Scope for this
feature), respects the one-loop/one-counter constraint, and lets the *next* round (post-remediate,
seed already deleted) run the real executor to verify convergence and flip the PR back to
ready-for-review.

### D-2 — Remediation counter reset via artifact clear (FR-006)

The remediation "counter" is the artifact's `round` field (the `on-remediation-limit` gate fires
when `round >= maxRemediations`). New trusted-external feedback = fresh budget. **Decision**: when
the adapter seeds from newly observed trusted-external feedback, it also **clears the prior review
artifact** (`clearReviewArtifact`) so the seed-aware wrapper derives `round = 1`. Reset is driven
by the adapter running (which only runs on a trusted-external trigger — authorship-based), never by
thread resolution or gate-label removal. This is distinct from #1070's `fixerTimeoutRetryCount`.

### D-3 — Adapter seeds and consumes in the same job

Worker checkouts are ephemeral per job. The seed file and its consumption must live in the same
`handle()` invocation. **Decision**: the `address-pr-feedback` branch in `claude-cli-worker.ts:299`
no longer returns early into the legacy fixer. It (1) checks out, (2) parses dual-source feedback
via the retained parser, (3) writes the seed + clears the artifact (D-2), (4) falls through to the
normal `phaseLoop.executeLoop(...)` with `phaseSequence` starting at `review`. The legacy
`PrFeedbackHandler` is reduced to exposing the parser + seed-writer (thin adapter, Q5=B).

### D-4 — Mixed-thread exclusion predicate (FR-010)

Exclude a thread from the trusted-unresolved count only when
`thread.comments.every(c => commentCarriesEngineAuthoredReviewMarker(c.body))`. Any single
external trusted comment keeps the thread live. Implemented in the trust loop at
`pr-feedback-monitor-service.ts:264-286` as an additional per-thread guard, orthogonal to the
authorship trust filter.

## Project structure

```
packages/orchestrator/src/
  services/
    pr-feedback-monitor-service.ts     MODIFY  engine-authored exclusion (FR-001/FR-010),
                                               keep trust filter (FR-002), keep blocked:* skip
                                               (FR-009); still enqueues address-pr-feedback
  worker/
    pr-feedback-handler.ts             MODIFY  reduce to thin adapter: retain dual-source parser
                                               (~218-402), export seed writer, delete
                                               blocked:stuck-feedback-loop apply-site (~611)
    external-feedback-seed.ts          NEW     seed schema (Zod) + path helper + write/read/clear
    seed-aware-review-executor.ts      NEW     D-1 wrapper: seed → artifact(changes-required) OR
                                               delegate to real ReviewExecutor
    claude-cli-worker.ts               MODIFY  address-pr-feedback branch (299): parse → seed →
                                               clear artifact → run phase loop at review; inject
                                               SeedAwareReviewExecutor as deps.reviewExecutor
  review-artifact.ts (existing)        REUSE   computeVerdict, write/read/clearReviewArtifact

packages/workflow-engine/src/actions/github/
  label-definitions.ts                 MODIFY  remove blocked:stuck-feedback-loop entry (FR-008)

.changeset/
  1130-pr-feedback-remediate-routing.md NEW    orchestrator patch + workflow-engine minor
```

## Constitution check

No `.specify/memory/constitution.md` present in the repository → constitution gate skipped.

## Risks & mitigations

- **Artifact clobber (D-1)**: mitigated by the wrapper short-circuiting the CLI when a seed is
  present; the real executor never runs on the seeding round.
- **Rolling-deploy skew**: the monitor still enqueues `address-pr-feedback`; the *worker* decides
  routing. If a new monitor talks to an old worker (or vice-versa) during deploy, the flag-off
  default keeps both on legacy behavior. Verify the flag default at implement time.
- **Label removal ordering (FR-008)**: removing `blocked:stuck-feedback-loop` from
  `label-definitions.ts` is a workflow-engine minor bump; confirm no other consumer references the
  constant before deletion (grep the monorepo at implement time).

## Next step

`/speckit:tasks` to generate the task breakdown from this plan.
