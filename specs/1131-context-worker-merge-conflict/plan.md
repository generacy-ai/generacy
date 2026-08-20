# Implementation Plan: Merge-conflict re-arm targets a resolution-scoped review

**Feature**: After a successful merge-conflict resolution, re-arm into a `review` phase scoped to the resolution diff (merge commit vs. pre-merge branch tip) instead of the interrupted phase.
**Branch**: `1131-context-worker-merge-conflict`
**Status**: Complete

## Summary

`MergeConflictHandler.finishSuccess` re-arms the **interrupted phase** today
(`{ outcome: 're-armed', startPhase: metadata.phase }` at
`merge-conflict-handler.ts:659`). This closes the semantic-conflict safety gap
by re-arming into a **`review` phase scoped to the resolution diff** when
`reviewPhaseEnabled` is on: the review executor inspects only
`baseSha..headSha` (pre-merge branch tip → merge commit), a clean review flows
forward to `validate`, and a review with findings enters the `remediate` loop.
The failure disposition (`blocked:stuck-merge-conflicts`) is untouched.

The change threads a new `reviewScope: { baseSha, headSha }` alongside
`startPhase` from the re-armed outcome → rearm-item metadata → `WorkerContext` →
the review executor's charter, extending the executor/charter with an explicit
`base..head` diff-window parameter (they review the whole PR diff today).

### The load-bearing design decision (see research.md Decision 1)

The merge-conflict re-arm's `startPhase` is **not** what actually selects the
resume phase today. `claude-cli-worker.ts:439` resolves the start phase from
**labels** (`PhaseResolver.resolveStartPhase(labels, 'continue', …)`); the
`metadata.startPhase` written into the rearm item at `claude-cli-worker.ts:391`
is consumed only by the `assertHandlerOutcomeMatchesWorld` consistency check
(`handler-outcome-assertion.ts:47`), never by phase resolution. Re-arming to
`validate` "works" today only because the paused issue's labels already resolve
to the interrupted phase.

Labels will **not** reliably resolve to `review` after a merge resolution (a
conflict during `validate`, after `review` already ran, carries
`completed:review` and would resolve straight back to `validate`). So this
feature adds an **explicit `startPhase` override** honored only on the
merge-conflict resume path (`resumeReason === 'merge-conflict-resolved'` and the
override equals `'review'`). Flag-OFF continues to re-arm `startPhase:
metadata.phase` and resolve via labels exactly as today — byte-identical.

## Technical Context

- **Language / runtime**: TypeScript, Node ≥ 22, ESM. Monorepo (pnpm workspaces).
- **Packages touched**:
  - `@generacy-ai/orchestrator` — handler, worker wiring, phase-loop, types.
  - `@generacy-ai/generacy-plugin-claude-code` / launcher — no change (the
    `review` launch intent already exists from #1124).
- **Dependencies (all merged to `develop`)**: #1121 (phase machinery +
  `reviewPhaseEnabled` flag), #1124 (review executor + findings artifact +
  charter), #1125 (PR posting + draft/ready), #1126 (re-review convergence),
  #1127 (integration). This issue only re-arms into that machinery and adds the
  diff-window parameter.
- **Feature flag**: `reviewPhaseEnabled` (`WorkerConfigSchema`, default `false`,
  env `WORKER_REVIEW_PHASE_ENABLED`). Gates FR-001 per Q3→B.
- **No build/test during resolution** (FR-007): the handler's git-state-only
  success predicate is unchanged; the review executor's charter forbids running
  tests/builds (`review-charter.ts:43-49`).

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo — constitution check
skipped.

## Project Structure

Files modified (all under `packages/orchestrator/src/` unless noted):

| File | Change |
|------|--------|
| `worker/handler-outcome.ts` | `ReArmedOutcome` gains optional `reviewScope?: { baseSha: string; headSha: string }`. |
| `worker/merge-conflict-handler.ts` | `finishSuccess` / `pushAndSucceed` / no-op path: compute the resolution scope and choose the re-arm target (review vs. `metadata.phase`) gated by `config.reviewPhaseEnabled`. New `getResolutionScope(checkoutPath)` helper. |
| `worker/claude-cli-worker.ts` | Rearm item carries `startPhase` + `reviewScope` + `resumeReason: 'merge-conflict-resolved'`; context build honors the explicit `startPhase` override and threads `reviewScope` into `WorkerContext`. |
| `worker/types.ts` | `WorkerContext.resumeReason` union gains `'merge-conflict-resolved'`; new `reviewScope?: { baseSha; headSha }`. |
| `worker/review-executor.ts` | `execute` reads `context.reviewScope`; empty-window short-circuit (skip spawn → success → validate); passes the window to the charter. |
| `worker/review-charter.ts` | `buildReviewCharter` input gains optional `diffWindow?: { baseSha; headSha }`; when present, names the exact `base..head` range instead of "the whole PR diff". |
| `types/monitor.ts` (`ResolveMergeConflictsMetadata`) | Documentation-only note that base/head SHAs travel via the re-armed outcome, **not** the sidecar (sidecar is cleared immediately after re-arm). No new sidecar field required for the transport (Q2→B). |

New artifacts (this planning phase):
- `specs/1131-context-worker-merge-conflict/research.md`
- `specs/1131-context-worker-merge-conflict/data-model.md`
- `specs/1131-context-worker-merge-conflict/contracts/review-scope.md`
- `specs/1131-context-worker-merge-conflict/quickstart.md`

## Approach (phased)

1. **Type surface** — add `reviewScope` to `ReArmedOutcome` and `WorkerContext`;
   broaden the `resumeReason` union. (data-model.md)
2. **Handler** — `getResolutionScope` (`{ baseSha: HEAD^1, headSha: HEAD }` from
   the `--no-ff` merge commit; `{ HEAD, HEAD }` for the no-op path → empty
   window; `undefined` when SHAs can't be determined → whole-branch fallback).
   `finishSuccess` chooses target: `reviewPhaseEnabled` → `startPhase: 'review'`
   + `reviewScope`; else `startPhase: metadata.phase` (unchanged). `metadata.phase`
   stays required for the fail-loud guard and the flag-off fallback (FR-010).
3. **Worker wiring** — carry `startPhase`/`reviewScope` into rearm metadata;
   honor the explicit override + set `context.reviewScope` on the
   `merge-conflict-resolved` resume path.
4. **Review executor + charter** — thread `context.reviewScope` → charter
   `diffWindow`; empty-window short-circuit to `validate` (FR-011).
5. **Tests** — see spec Success Criteria (SC-001..005): full traversal
   integration test, diff-window exclusion assertion, no-spawn-during-resolution
   assertion, no-bypass-of-validate phase-sequence assertion, byte-identical
   blocked-path regression.

## Risks / Open Items

- **Assertion helper**: `assertHandlerOutcomeMatchesWorld` already matches on
  `metadata.startPhase === outcome.startPhase`; since we carry the outcome's
  `startPhase` into rearm metadata, a `review` re-arm stays consistent. No change
  needed, but the rearm test fixtures (`merge-conflict-handler.rearm.test.ts`)
  must be updated to expect `startPhase: 'review'` + `reviewScope` when the flag
  is on, and the unchanged `metadata.phase` re-arm when off.
- **Empty-window detection** lives in the executor (git diff of
  `baseSha..headSha`), so both the no-op merge (`{HEAD,HEAD}`) and a net-zero
  ours/theirs pick short-circuit through one code path (FR-011).

## Changeset

`.changeset/1131-merge-conflict-review-rearm.md` — `@generacy-ai/orchestrator`
**patch** (internal handler/worker/phase-loop behavior; the `review` diff-window
parameter is internal surface, not re-exported). `workflow:speckit-bugfix`-class
change → `patch`. Verify no new public export at implement time; the
`buildReviewCharter` `diffWindow` field and `WorkerContext.reviewScope` are
internal to the orchestrator package.

---

*Generated by /plan*
