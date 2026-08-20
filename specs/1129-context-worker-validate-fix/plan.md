# Implementation Plan: Route validate failures into the remediate loop

**Feature**: Route a failing `validate` phase into the engine-native remediate → review → validate loop instead of the one-shot `validate-fix-handler` side path.
**Branch**: `1129-context-worker-validate-fix`
**Status**: Complete

## Summary

Today a `validate` failure only auto-fixes on the resume-driven re-run
(`phase-loop.ts` #892 block, gated on `resumeReason === 'base-advance'`), via a
bespoke one-attempt-per-evidence-hash handler (`worker/validate-fix-handler.ts`).
First-time reds skip auto-fix and escalate through `onError('validate')` →
`failed:validate`.

This feature reroutes a validate failure into the same **remediate → review →
validate** loop the review/remediate epic (#1121–#1127) already ships. On a
validate red the phase loop:

1. Checks the failure-fingerprint backstop first (FR-006). If this exact evidence
   has already reproduced `REPEAT_FAILURE_THRESHOLD` times, it escalates via
   `failed:validate-repeated` and stops — the sole terminal failure label (FR-009).
2. Otherwise it **synthesizes a `changes-required` review-findings artifact** from
   the validate evidence (bumping the artifact `round`), then backtracks `i` to
   `review`. The existing synchronous `remediateTrigger` reads that verdict and
   drives the off-sequence `remediate` seam; the `on-remediation-limit` gate
   (#1128) bounds it against the shared `maxRemediations` counter (FR-001/FR-002).
3. `remediate` is still `runStubPhase`, so the reduced-to-thin-adapter
   `validate-fix-handler` supplies the interim *real* fix at the remediate seam
   (FR-005), carrying the sibling-owned-file overlap guard for free (FR-010).
4. After the fix, `review` re-runs delta-scoped (the real executor) and finally
   `validate` re-runs (FR-003), honoring one base-merge per cycle (FR-007).

The `resumeReason === 'base-advance'` precondition is removed (FR-004). The legacy
handler is invoked at exactly one site — the remediate seam — so the old path and
the new loop can never both fire for one failure (FR-008/SC-003).

With `reviewPhaseEnabled = false`, `review` is absent from the effective sequence
and validate keeps its current handling; the feature is inert and byte-identical
(SC-005).

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node ≥ 22, pnpm monorepo.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator`). Worker-side
  phase machine under `src/worker/`.
- **Dependencies (all already on-branch, #1121–#1127 merged into develop)**:
  - Effective phase sequence with `review` before `validate`
    (`worker/types.ts`, `getPhaseSequence`).
  - `PhaseLoopDeps.remediateTrigger` synchronous seam
    (`phase-loop.ts:709` wiring; `:1270` invocation).
  - `on-remediation-limit` gate (`phase-loop.ts:1122-1148`, config gate at
    `worker/config.ts:172`).
  - Filesystem review artifact (`worker/review-artifact.ts`:
    `writeReviewArtifact` / `readReviewArtifact` / `readReviewArtifactSync` /
    `computeVerdict`).
  - `ReviewExecutor` (`worker/review-executor.ts`) — runs on `review` re-entry
    and **overwrites** the filesystem artifact.
  - Failure-fingerprint backstop (`worker/failure-fingerprint.ts`
    `computeFailureFingerprint` + `REPEAT_FAILURE_THRESHOLD = 2`;
    `services/failure-fingerprint-tracker.ts` comment-scan counter).
  - `ValidateFixHandler` (`worker/validate-fix-handler.ts`) with sibling-overlap
    guard.
- **No new runtime dependencies.**

### Central design decision (resolves the executor-overwrite tension)

`ReviewExecutor.execute()` unconditionally rewrites the filesystem review artifact
with a freshly recomputed verdict. If the validate branch synthesizes a
`changes-required` artifact and simply backtracks to `review`, the executor's next
run clobbers that verdict (a review agent that finds no code-quality issues yields
`computeVerdict([]) === 'clean'`), so `remediateTrigger` never fires and the thin
adapter never runs — validate would loop forever until the fingerprint backstop.

**Resolution**: a one-shot **in-loop** control `pendingValidateRemediation`
(a block-local variable in `executeLoop`, NOT a persisted `WorkerContext` flag).
On the synthesis iteration the `review` phase **skips** `runReviewConvergence` +
`reviewExecutor.execute()` and treats the phase as a synthetic success, leaving the
synthesized artifact intact for the gate check and `remediateTrigger`. It is
consumed at the remediate seam (where it also selects the thin adapter over the
stub) and is cleared before the *second* `review` re-entry, which then runs the
real delta-scoped executor (FR-003).

This does not conflict with clarification Q1's rejection of a `WorkerContext`
flag: that rejection was about using a flag **as the remediation counter** (it
cannot survive the gate pause/resume). Here the counter remains the **persisted
artifact round**; `pendingValidateRemediation` is purely in-memory loop control on
a single uninterrupted iteration and is irrelevant across pause/resume (the
persisted artifact already carries `verdict: 'changes-required'` + advanced
`round`).

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository — constitution
gate skipped.

## Project Structure

```
packages/orchestrator/src/worker/
  phase-loop.ts                 # MODIFY — validate-failure routing, review-skip
                                #          on synthesis, remediate-seam adapter
                                #          dispatch; remove base-advance gate
  validate-fix-handler.ts       # MODIFY — reduce to thin adapter (interim
                                #          remediate behavior); drop the
                                #          one-attempt-per-evidence-hash live gate
  review-artifact.ts            # (reuse) writeReviewArtifact / readReviewArtifact
                                #          / computeVerdict — no change
  failure-fingerprint.ts        # (reuse, unchanged — Out of Scope)
  __tests__/
    phase-loop.validate-remediate.integration.test.ts   # NEW (SC-001/004/005)
    phase-loop.validate-fingerprint.test.ts             # NEW (SC-002)
    validate-fix-handler.adapter.test.ts                # NEW (FR-005/FR-010)

packages/orchestrator/src/services/
  failure-fingerprint-tracker.ts # (reuse, unchanged)

specs/1129-context-worker-validate-fix/
  plan.md                       # this file
  research.md
  data-model.md
  quickstart.md
  contracts/
    validate-remediation-routing.md
    thin-adapter-contract.md
```

### Changeset

`packages/orchestrator/src/` non-test files change → a **new** `.changeset/*.md`
is required by CI.

- `.changeset/1129-validate-remediate-routing.md`
- `@generacy-ai/orchestrator` **patch** — internal phase-loop/handler behavior
  change, `workflow:speckit-bugfix`, no new public exports, no new label
  vocabulary (all labels — `waiting-for:remediation-limit`,
  `failed:validate-repeated` — already exist).

## Phased Work

1. **Extract validate-failure routing** in `phase-loop.ts` (replace the #892
   block): fingerprint-first escalation vs. synthesize-and-backtrack. Remove the
   `resumeReason === 'base-advance'` precondition (FR-004).
2. **Synthesis helper**: read → advance filesystem artifact (`round++`,
   `verdict: 'changes-required'`, one synthesized finding from evidence, HEAD SHA).
3. **Review-skip on synthesis**: gate `runReviewConvergence` +
   `reviewExecutor.execute()` behind `!pendingValidateRemediation`.
4. **Remediate-seam adapter dispatch**: run the thin adapter for a validate-origin
   remediation, else `runStubPhase('remediate')`.
5. **Thin adapter reduction** in `validate-fix-handler.ts`: keep the fix +
   sibling-overlap guard; drop the evidence-hash one-attempt cap and the
   `cluster.validate-fix` escalation ownership (the loop owns escalation now).
6. **Tests** for SC-001…SC-005.
7. **Changeset**.

## Suggested Next Step

`/speckit:tasks` to generate the task list from this plan.
