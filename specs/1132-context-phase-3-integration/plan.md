# Implementation Plan: Full review⇄remediate loop end-to-end (Phase-3 integration)

**Feature**: Phase-3 integration checkpoint proving the four P3 executors — #1128 (remediate executor + counter + cap gate), #1129 (validate→remediate routing), #1130 (PR-feedback monitor engine-thread exclusion + external-feedback→remediate routing), #1131 (merge-conflict re-arm → resolution-scoped review) — are wired together end-to-end, via an integration scenario suite plus a durable loop-contract artifact.
**Branch**: `1132-context-phase-3-integration`
**Status**: Complete

## Summary

This issue ships **no product behavior of its own** (FR-008). It ships:

1. A **full-convergence integration scenario** (FR-001 / US1) driving a real worker phase loop through `implement → review (2 blocking) → remediate → re-review (1 resolved / 1 open) → remediate → re-review clean → ready → validate fail → remediate → re-review → validate green`, for both `speckit-feature` and `speckit-bugfix`. Exercises **both** the review-blocking and validate-failure remediate entry points across multiple rounds.
2. A **remediation-cap integration scenario** (FR-002 / US2) driving the remediation counter to `maxRemediations`, asserting `waiting-for:remediation-limit` is raised (never a terminal `blocked:*`), the remaining open findings are surfaced, and — on a human answer — the counter resets and the loop converges.
3. An **external-feedback integration scenario** (FR-003 / US3) driving the **real** `PrFeedbackMonitorService` end-to-end: genuine external human feedback on a ready PR routes back into `remediate` and converges; engine-authored threads (carrying the P2 marker) are **excluded** from that routing (#1130 boundary).
4. A **loop-contract artifact** (FR-007) documenting the phase-sequencing (incl. off-sequence backtrack), the three remediate entry points, the counter/cap semantics, the draft/ready invariant, and the engine-thread exclusion boundary — cross-referencing #1128–#1131 as the authorship home (and pinning #1131's deferred merge-conflict entry).

Everything the scenarios exercise — the real `remediate` executor, the remediation counter, the `waiting-for:remediation-limit` cap gate, validate→remediate routing, external-feedback→remediate routing, and the monitor's engine-thread exclusion — is **consumed, not re-implemented** (Assumption §89). No test-only double stands in for any P3 executor (this is the key departure from P2, where `remediate` was still a stub).

## Dependencies & landing order (rebase-on-develop — mirrors #1123 Q1=B / #1127 Q1=A)

- **#1128** (remediate executor + counter + cap gate) merges to `develop` first. Authorship home for the **real `remediate` executor** replacing `runStubPhase('remediate')` (`phase-loop.ts:1277`), the **remediation counter**, and the **counter-reset mechanism** on a `waiting-for:remediation-limit` human answer (today's gate at `phase-loop.ts:1122-1147` is a #1124 scaffold with **no reset**).
- **#1129** (validate→remediate routing) merges first. Authorship home for routing a `validate` **failure** into the off-sequence `remediate` backtrack (retiring the standalone validate-fix handler) — the second remediate entry point US1 drives.
- **#1130** (monitor exclusion + external-feedback→remediate routing) merges first. Authorship home for wiring `matchEngineAuthoredReviewMarker` (already present at `review-poster.ts:64`) into `PrFeedbackMonitorService` routing to **exclude** engine-authored threads, and for routing genuine external feedback into `remediate` — the third remediate entry point US3 drives.
- **#1131** (merge-conflict re-arm → resolution-scoped review) merges first. **Cross-referenced/pinned only** in the loop-contract artifact; **no dedicated scenario** ships (Q1=B defer+pin, mirroring #1127).
- This branch is **rebased** on all four and ships **only** the four items above. **The implement phase dependency-blocks (skip→requeue-after-deps) until #1128/#1129/#1130/#1131 land on `develop`.**

## Technical Context

- **Language / runtime**: TypeScript, ESM, Node >= 22.
- **Test framework**: Vitest.
- **Primary package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **Consumed packages**: `@generacy-ai/config` (`OrchestratorSettings`, per-workflow `maxRemediations` + review profile via `resolveWorkflowOverrides`), `@generacy-ai/workflow-engine` (`GitHubClient`, `isTrustedCommentAuthor`).
- **No new runtime dependencies.** No product `src/` changes expected — see [Changeset](#changeset).

### Grounding — current code (post-P1/P2, pre-P3-rebase, verified on this branch)

| Concern | Location | Current shape |
|---|---|---|
| Phase loop entry | `phase-loop.ts` `executeLoop` | index-based `for (i = startIndex; i < sequence.length; i++)`; retries + off-sequence backtrack via `i--; continue;` |
| Effective sequence | `phase-loop.ts:266-269`, `types.ts:84-89` | `getPhaseSequence(workflow, reviewPhaseEnabled)` filters `review` out when the flag is false |
| Real review executor branch | `phase-loop.ts:535-537` | `deps.reviewExecutor ? await deps.reviewExecutor.execute(context) : this.runStubPhase(phase)` — **real (#1124)** |
| `remediate` execution | `phase-loop.ts:538-541` **and** `:1277` | **still `runStubPhase('remediate')`** — #1128 replaces both with the real executor |
| Off-sequence remediate seam | `phase-loop.ts:1270-1284` | `if (phase === 'review' && result.success && deps.remediateTrigger?.(context)) { convertToDraftIfEngineMarkedReady; onPhaseStart('remediate'); runStubPhase('remediate'); onPhaseComplete('remediate'); reviewRound++; i--; continue; }` |
| Loop-control seam | `phase-loop.ts:124` | `remediateTrigger?: (context: WorkerContext) => boolean` on `PhaseLoopDeps` |
| Worker's `remediateTrigger` binding | `claude-cli-worker.ts:688-709` | bound to the review artifact's verdict (`=== 'changes-required'`) via `readReviewArtifactSync` |
| Cap gate (scaffold) | `phase-loop.ts:1122-1147` | `on-remediation-limit`: `gateActive = artifact.round >= maxRemediations && artifact.verdict === 'changes-required'` — **pauses but does NOT reset the counter (#1128 owns reset)** |
| Cap gate config | `config.ts:172,179` | default `{ phase: 'review', gateLabel: 'waiting-for:remediation-limit', condition: 'on-remediation-limit' }` for feature + bugfix |
| `maxRemediations` | `config.ts:32,66`, `resolveWorkflowOverrides` | feature **3** / bugfix **2** via `defaultMaxRemediations` |
| Draft/ready lifecycle | `pr-manager.ts` (`markReadyForReview`, `convertToDraftIfEngineMarkedReady`) | clean verdict → ready (`phase-loop.ts:1261-1263`); remediate entry → draft (`:1275`) — **from #1125** |
| Engine-authored marker + matcher | `review-poster.ts:23,64,75` | `REVIEW_BODY_MARKER_PREFIX='generacy-engine-review'`, `matchEngineAuthoredReviewMarker(body)`, `findingMarker` — **from #1125** |
| Feedback monitor | `pr-feedback-monitor-service.ts:267-286` | `isTrustedCommentAuthor` trust filter only — **no engine-thread exclusion predicate yet (#1130 owns it)**; no external-feedback→remediate routing yet |
| Resume targets | `phase-resolver.ts:17` | `'remediation-limit': { phase: 'review', resumeFrom: 'review' }` |
| P1/P2 harness (template) | `__tests__/phase-loop.review-remediate.integration.test.ts`, `phase-loop.review-clean.integration.test.ts` | `createMockDeps()` / `createMockContext()` / `createConfig({ reviewPhaseEnabled: true })` / `getPhaseSequence(workflow, true)` / `phaseStartOrder()` / `fireOnceTrigger()` |

### ABSENT on this branch (delivered by the dependencies, consumed after rebase)

- Real `remediate` executor replacing both `runStubPhase('remediate')` sites (#1128).
- Remediation counter + **counter-reset** on the cap gate's human answer (#1128) — today's gate pauses but never resets.
- `validate`-failure → off-sequence `remediate` routing (#1129).
- `PrFeedbackMonitorService` engine-thread exclusion (wiring `matchEngineAuthoredReviewMarker` into routing) + external-feedback→`remediate` routing (#1130).
- Merge-conflict re-arm → resolution-scoped review (#1131) — pinned, not scenario-tested.

Because these are absent pre-rebase, the exact production API each scenario binds to (remediate executor entrypoint, reset trigger shape, monitor routing entrypoint) is **resolved at implement time against the merged dependency code**. This plan pins the *behavior* to assert and the *seams* to bind through; it does not guess unmerged signatures (Q4=C for the reset trigger).

## Project Structure

```
specs/1132-context-phase-3-integration/
  spec.md                        (read-only)
  clarifications.md              (read-only)
  plan.md                        (this file)
  research.md
  data-model.md
  quickstart.md
  contracts/
    loop-convergence-contract.md   (loop invariants pin note — FR-007)

packages/orchestrator/src/worker/__tests__/
  phase-loop.review-remediate-convergence.integration.test.ts  (FR-001 — US1; both workflows)
  phase-loop.remediation-cap.integration.test.ts               (FR-002 — US2)

packages/orchestrator/src/__tests__/
  pr-feedback-external-remediate.integration.test.ts           (FR-003 — US3; real PrFeedbackMonitorService)
```

## Test design (behavior pinned; API bound at implement time)

### US1 — full multi-round convergence (`phase-loop.review-remediate-convergence.integration.test.ts`)

Drive `PhaseLoop.executeLoop(context, config, deps, getPhaseSequence(workflow, true))` for both workflows with a **mocked `GitHubClient`** (capturing spy), the **real** review + remediate executors, and per-round verdict steering by **seeding the findings-artifact sidecar** (Q2=A — the mocked launcher pre-writes each round's candidate findings; the real executor recomputes the verdict via `computeVerdict`). Assert:

- Round 1 review returns two at/above-`blockingSeverity` findings → routes off-sequence into `remediate` → converts ready PR back to draft → backtracks (`i--; continue;`) to a delta-scoped re-`review` (AC1).
- Round 2 re-review resolves one finding / leaves one open → re-enters `remediate` (counter increments) → re-reviews (AC2).
- A clean re-review calls `markReadyForReview` and advances into `validate` (AC3).
- A `validate` **failure** routes back into `remediate` (#1129) → converts ready→draft → re-reviews → re-validates (AC4 — the **second** entry point).
- A green `validate` terminates the loop **forward** — no further backtrack (AC5).
- The findings artifact, remediation counter, and phase/gate labels are consistent at every transition (AC6 / FR-006).
- **At most one full validate/suite execution per clean-review cycle** (FR-005 / SC-005) — asserted on the validate-spawn / suite-invocation count.

### US2 — remediation cap + reset + converge (`phase-loop.remediation-cap.integration.test.ts`)

Seed each round's sidecar to keep the verdict `changes-required` until the counter reaches `maxRemediations`. Assert:

- The loop pauses and raises `waiting-for:remediation-limit`; **zero** terminal `blocked:*` labels (SC-003).
- The remaining open findings are surfaced at the pause point (FR-002).
- A simulated **human answer** — injected through **whatever reset/resume seam #1128 ships** (Q4=C; bound at implement time, likely a gate-resume label event via the phase-loop gate seam) — **resets the counter** and resumes the loop.
- After reset, a clean re-review converges and the loop proceeds forward (SC-003).

The harness asserts only the **observable** counter-reset + convergence, not the concrete trigger shape (Q4=C).

### US3 — external feedback re-entry + engine-thread exclusion (`pr-feedback-external-remediate.integration.test.ts`)

Drive the **real** `PrFeedbackMonitorService` (Q3=A — no standalone marker-match helper, no test-only monitor double). With a mocked `GitHubClient` returning PR threads, assert:

- A genuinely **external** human review thread on a ready PR routes the loop back into `remediate` (#1130) and converts the PR back to draft (AC1).
- An engine-authored thread carrying the P2 marker (`matchEngineAuthoredReviewMarker(body) !== undefined`) is **excluded** — does **not** trigger re-entry (AC2 / SC-004).
- After remediating the external feedback, a clean re-review re-marks the PR ready and the loop converges (AC3).

## Plan decisions

- **D-1 — Rebase-on-develop; consume the real P3 executors, no doubles.** Unlike P2 (where `remediate` was a test-only stub), P3 runs the **real** remediate executor, validate→remediate routing, and monitor exclusion. Only genuinely external seams (CLI/agent invocation, GitHub calls, human answers) are mocked/injected through the established `PhaseLoopDeps`/`GitHubClient`/`cliSpawner` seams (Assumption §89). The implement phase dependency-blocks until #1128–#1131 land.
- **D-2 — Per-round verdict steering seeds the findings-artifact sidecar (Q2=A).** The shipped #1124 executor never parses agent stdout into findings — it reads the candidate sidecar the agent wrote and recomputes the verdict via `computeVerdict`. So the harness steers each round by having the mocked launcher/`reviewExecutor` input pre-write that round's candidate findings, exactly as the real agent does. No CLI-output steering seam is used.
- **D-3 — Cap-reset trigger binds at implement time (Q4=C).** #1128 owns both the counter and its reset; today's `on-remediation-limit` gate (`phase-loop.ts:1122-1147`) pauses but has **no reset**. `waiting-for:remediation-limit` is a **label-driven phase gate**, not a clarification-answer comment — so the reset is exercised through the phase-loop gate/resume seam (not a comment payload). The harness asserts the observable counter-reset + convergence, binding the exact trigger to whatever #1128 ships.
- **D-4 — US3 drives the real monitor (Q3=A).** #1130 lands first under rebase-on-develop, so FR-003/SC-004 assert the real `PrFeedbackMonitorService` routing end-to-end, not a standalone marker-match helper (the #1127 stopgap). The marker matcher already exists (`review-poster.ts:64`); #1130 wires it into routing and this scenario exercises that boundary.
- **D-5 — #1131 merge-conflict entry point deferred + pinned (Q1=B).** No fourth scenario. The loop-contract artifact cross-references #1131's merge-conflict re-arm → resolution-scoped review as a documented entry point, matching the #1127 defer+pin precedent. This suite ships exactly the three remediate-entry scenarios.
- **D-6 — Loop-contract artifact is a pin note, not a new authored contract.** `contracts/loop-convergence-contract.md` cross-references #1128–#1131 as the authorship home and the #1123 seam + #1127 marker/findings pins, recording the phase-sequencing, three-entry-point, counter/cap, draft/ready, and exclusion invariants so P4 builds against a documented boundary (FR-007). It authors no new wire contract for the marker/findings shapes (owned by #1124/#1125).

## Constitution Check

No `.specify/memory/constitution.md` exists in the repo → constitution check skipped.

## Changeset

Per CLAUDE.md's changeset gate: this diff is **test-only** under `packages/orchestrator/src/**` plus a spec `contracts/` doc, so the gate is satisfied by **exemption** and **no `.changeset/*.md` is added** (mirrors #1123/#1127). If — at implement time — driving the real `PrFeedbackMonitorService` or the cap-reset seam requires a **minimal non-test seam** under `packages/*/src/` (e.g. a test-only injection point that lands in product code), that triggers the gate and requires `.changeset/1132-loop-convergence-integration.md` — `@generacy-ai/orchestrator` **patch** (internal, no new public exports). Decide at implement time; the contract note + spec artifacts alone never trigger the gate.

## Next step

`/speckit:tasks` to generate the dependency-ordered task list.
