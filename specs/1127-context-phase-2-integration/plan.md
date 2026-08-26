# Implementation Plan: implement→review→ready flow end-to-end (Phase-2 integration)

**Feature**: Phase-2 integration checkpoint proving #1124 (review executor + findings artifact), #1125 (PR review posting + draft/ready lifecycle), and #1126 (re-review convergence) are wired together end-to-end, via integration tests plus a contract cross-reference/pin note.
**Branch**: `1127-context-phase-2-integration`
**Status**: Complete

## Summary

This issue ships **no product behavior of its own**. It ships:

1. A **clean-review happy-path integration test** (FR-001/FR-002/FR-003) driving `PhaseLoop.executeLoop` through `implement → review → clean verdict → COMMENT-event PR review posted (with engine-authored marker) → markReadyForReview → validate`, for both `speckit-feature` and `speckit-bugfix`.
2. A **changes-required integration test** (FR-004) driving a blocking verdict off-sequence toward a **test-only stub `remediate`** (injected through the existing `PhaseLoopDeps.remediateTrigger` seam — Q3=A), asserting the ready→draft conversion and the delta-scoped backtrack to a re-`review`, then a clean re-review that re-marks the PR ready.
3. A **marker-match assertion test** (FR-005) proving a **standalone deterministic marker-match helper** returns "exclude" for a comment/thread carrying the engine-authored review marker — WITHOUT modifying `PrFeedbackMonitorService` routing (Q4=B; #1130 owns wiring the predicate into routing).
4. A **contract cross-reference/pin note** (FR-006/FR-007) pinning the engine-authored review marker contract and the findings-artifact sidecar shape, cross-referencing #1124/#1125 as the authorship home (Q2=B).

Everything real that the tests exercise — the review executor, the findings artifact, the COMMENT-event posting, and the ready/draft lifecycle — is **consumed, not re-implemented** (Q1=A). The only test-only double is the `remediate` stub (Q3=A).

## Dependencies & landing order (Q1=A — rebase-on-develop)

- **#1124** (review executor + findings artifact) merges to `develop` first. Authorship home for the **findings-artifact** sidecar shape (severity enum `critical|major|minor`, file/line, round number, overall verdict) and the engine-internal verdict.
- **#1125** (PR review posting + draft/ready lifecycle) merges to `develop` first. Authorship home for the **engine-authored review marker** and the `COMMENT`-event posting + `markReadyForReview` / ready→draft-conversion calls.
- **#1126** (re-review convergence) merges to `develop` first. Wires the blocking-verdict → off-sequence → delta-scoped re-`review` convergence that #1127's changes-required test drives end-to-end.
- This branch is **rebased** on all three and ships **only** the four items above. It does **not** re-implement the executors and uses no test-only doubles for them (Q1=A) — except the P3 `remediate` stub (Q3=A). **The implement phase dependency-blocks (skip→requeue-after-deps) until #1124/#1125/#1126 land on `develop`.** Mirrors #1123 Q1=B.

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node >= 22.
- **Test framework**: Vitest (`packages/orchestrator/src/worker/__tests__/*.integration.test.ts`).
- **Primary package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Consumed packages**: `@generacy-ai/config` (`OrchestratorSettings`, per-workflow review profile), `@generacy-ai/workflow-engine` (`GitHubClient`, marker family / `isTrustedCommentAuthor`).
- **No new runtime dependencies.** No new product files under `packages/*/src/` except (conditionally) a minimal marker-match helper — see [Plan decision D-3](#plan-decisions).

### Grounding — current code (pre-rebase, verified on this branch)

| Concern | Location | Current shape |
|---|---|---|
| Phase loop entry | `packages/orchestrator/src/worker/phase-loop.ts` `executeLoop` | index-based `for (i = startIndex; i < sequence.length; i++)`; retries + off-sequence backtrack via `i--; continue;` |
| Stub review/remediate execution | `phase-loop.ts:473-477` | `if (phase === 'review' \|\| phase === 'remediate') result = this.runStubPhase(phase)` — **stubs only; #1124 replaces the `review` branch with the real executor** |
| Off-sequence remediate seam | `phase-loop.ts:1154-1166` | `if (phase === 'review' && result.success && deps.remediateTrigger?.(context)) { onPhaseStart('remediate'); runStubPhase('remediate'); onPhaseComplete('remediate'); i--; continue; }` |
| Loop-control injection seam | `phase-loop.ts:107` | `remediateTrigger?: (context: WorkerContext) => boolean` on `PhaseLoopDeps` |
| Phase sequence | `types.ts:58-60` | `PHASE_SEQUENCE = [specify,clarify,plan,tasks,implement,review,validate]`; `remediate` in **no** linear sequence |
| Effective sequence gate | `types.ts:84-90` | `getPhaseSequence(workflow, reviewPhaseEnabled)` filters out `review` when flag false |
| Per-workflow config resolver | `config.ts` `resolveWorkflowOverrides` | reads `review.profile` / `review.blockingSeverity` / `maxRemediations` from `OrchestratorSettings` (NOT a `WorkerConfig` field) |
| `blockingSeverity` enum | `config.ts:13,33-37` | `'critical' \| 'major' \| 'minor'` — already present |
| PR ready lifecycle | `pr-manager.ts:424` | `markReadyForReview(linkedPRs?)` — idempotent; **ready→draft-conversion + COMMENT-event posting are ABSENT (shipped by #1125)** |
| Marker family precedent | `clarification-markers.ts:12-44` | `<!-- generacy-<dialect>:<suffix> -->` line-anchored, case-sensitive; `match…Marker(body): string \| undefined` helper shape |
| Feedback monitor filter | `pr-feedback-monitor-service.ts:267-286` | trust filter via `isTrustedCommentAuthor` only — **no engine-authored exclusion predicate today** (Q4=B / #1130 owns it) |
| P1 integration test (template) | `__tests__/phase-loop.review-remediate.integration.test.ts` | `createMockDeps()` / `createMockContext()` / `createConfig()` + `fireOnceTrigger()` + `phaseStartOrder()` harness |

### ABSENT on this branch (delivered by the dependencies, consumed after rebase)

- Review executor implementation and the real `review` branch in `phase-loop.ts` (#1124).
- Findings-artifact type / sidecar and engine-internal verdict (#1124).
- Engine-authored review marker constant + its co-located match helper (#1125).
- `COMMENT`-event review posting method and ready→draft-conversion method on `PrManager` (#1125).
- Blocking-verdict → off-sequence → delta-scoped re-`review` convergence wiring (#1126).

Because these are absent pre-rebase, the exact production API each test binds to is **resolved at implement time against the merged dependency code**. This plan pins the *behavior* to assert and the *seams* to bind through; it does not guess unmerged signatures.

## Project Structure

```
specs/1127-context-phase-2-integration/
  spec.md                       (read-only)
  clarifications.md             (read-only)
  plan.md                       (this file)
  research.md
  data-model.md
  quickstart.md
  contracts/
    engine-review-integration.md   (marker + findings-artifact pin note — FR-006/FR-007)

packages/orchestrator/src/worker/__tests__/
  phase-loop.review-clean.integration.test.ts     (FR-001/FR-002/FR-003 — US1)
  phase-loop.review-remediate.integration.test.ts (FR-004 — US2; extends the #1123 file OR a sibling)
  engine-authored-marker.test.ts                  (FR-005 — US3, standalone marker-match)

packages/orchestrator/src/worker/    (only if D-3 fallback fires)
  engine-review-marker.ts           (minimal deterministic match helper, marker-family precedent)
```

## Test design (behavior pinned; API bound at implement time)

### US1 — clean-review happy path (`phase-loop.review-clean.integration.test.ts`)

Drive `PhaseLoop.executeLoop(context, config, deps, getPhaseSequence(workflow, true))` for `speckit-feature` and `speckit-bugfix` with a **mocked `GitHubClient`** (capturing spy) and a review executor steered to a **clean verdict** (empty/at-or-below-`blockingSeverity` finding set). Assert:

- Phase order includes `... implement → review → validate` and `review` sits immediately after `implement`.
- Exactly one PR review is posted with `event: 'COMMENT'`; **zero** `REQUEST_CHANGES` on the own PR (FR-002 / SC-003).
- The posted review body carries the engine-authored marker (asserted via the marker-match helper from FR-005, not a raw string literal, so the two tests can't drift).
- `prManager.markReadyForReview` is called on the clean verdict and the loop advances into `validate` (FR-003).

Verdict steering seam (resolved at implement time against #1124): control the clean/blocking outcome by controlling what the review executor consumes — the intended lever is the findings-artifact sidecar the executor reads/writes (pause-context precedent) or the executor's CLI output via `cliSpawner`. The harness mirrors #1123's `createMockDeps()`; only the verdict-steering shim is new.

### US2 — changes-required branch (`phase-loop.review-remediate.integration.test.ts`)

First `review` pass returns an at/above-`blockingSeverity` verdict → convergence (#1126) routes off-sequence via `remediateTrigger` (bound to the blocking verdict, or a fire-once shim standing in for #1126's real trigger). The `remediate` executor is a **test-only stub** (Q3=A) injected through the seam. Assert:

- Blocking verdict routes off-sequence toward `remediate` (FR-004).
- If the PR was already marked ready, entering `remediate` calls the ready→draft-conversion (`prManager` draft call from #1125) — asserted as the ready→draft transition (SC-004).
- After the stub `remediate`, control backtracks to a `review` pass (delta-scoped), never to the next linear phase (`i--; continue;` invariant from the #1123 seam contract).
- A clean re-review re-calls `markReadyForReview` and resumes forward (SC-004 — one round-trip).

### US3 — standalone marker-match (`engine-authored-marker.test.ts`)

Assert a **standalone deterministic marker-match helper** returns "exclude"/match for a comment/thread body carrying the engine-authored review marker, and does NOT match a plain external-reviewer comment or a `> `-quoted marker (marker-family precedent: line-anchored, case-sensitive). **`PrFeedbackMonitorService` is not imported or modified** (Q4=B / SC-005) — enforce with an import-absence assertion in the test.

## Plan decisions

- **D-1 — Verdict steering is a shim, not a fork of the executor.** The clean-vs-blocking outcome is driven by controlling the review executor's *input* (findings sidecar / CLI output), never by re-implementing verdict logic (FR-008). Exact lever resolved against #1124 at implement time; documented in `research.md` Decision 2.
- **D-2 — `remediate` stays a test-only stub via `remediateTrigger`.** No shipped placeholder executor (Q3=A / FR-008). Reuses the #1123 `PhaseLoopDeps.remediateTrigger` + `i--; continue;` seam verbatim; this issue adds no new loop-control mechanism.
- **D-3 — Marker-match helper: assert #1125's shipped helper first; ship a minimal one only as fallback.** Preferred: #1125 ships the engine-authored marker *with* a co-located `match…Marker` helper (marker-family precedent — `clarification-markers.ts` exports both constant and matcher). FR-005 asserts that helper; zero new product code. Fallback: if #1125 ships only the marker constant, #1127 adds a minimal deterministic `matchEngineAuthoredReviewMarker(body): boolean` co-located in the marker module (NOT in `PrFeedbackMonitorService`), exported for #1130 to later consume — preserving Q4=B. Which path fires is decided at implement time against the merged #1125.
- **D-4 — Contract artifact is a pin note, not a new authored contract.** `contracts/engine-review-integration.md` cross-references #1124/#1125 as the authorship home and records the stable prefix / match rule / authorship rule and the findings-artifact fields, so P3 (#1128/#1130) builds against a documented boundary (Q2=B / FR-006/FR-007).

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Changeset

Per CLAUDE.md's changeset gate: this diff is **test-only** under `packages/orchestrator/src/**` **if** D-3's preferred path holds (no product `src/` change) — in which case the gate is satisfied by exemption and **no `.changeset/*.md` is added**. If D-3's fallback fires (a minimal marker-match helper lands under `packages/orchestrator/src/worker/`), that is a non-test product change and **requires** `.changeset/1127-engine-review-integration.md` — `@generacy-ai/orchestrator` **patch** (internal helper, not re-exported at the public boundary). Decide at implement time based on which D-3 path fires; the contract note + spec artifacts alone never trigger the gate.

## Next step

`/speckit:tasks` to generate the dependency-ordered task list.
