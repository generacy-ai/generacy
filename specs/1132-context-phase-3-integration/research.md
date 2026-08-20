# Research: Full review⇄remediate loop end-to-end (Phase-3 integration)

Issue: generacy-ai/generacy#1132 · Part of epic generacy-ai/generacy#1120

## Decision 1 — Rebase-on-develop; consume the real P3 executors, no doubles (D-1)

**Decision**: #1128/#1129/#1130/#1131 merge to `develop` first; this branch rebases on them and ships only the three integration scenarios + the loop-contract artifact. The implement phase dependency-blocks (skip→requeue-after-deps) until all four merge.

**Rationale**: Mirrors #1123 Q1=B / #1127 Q1=A. This is the **key departure from P2**: in P2 the `remediate` phase was still a test-only stub, so P2 could co-exist with an unmerged remediate executor. P3 exists precisely to prove the **real** remediate executor, validate→remediate routing, and monitor exclusion converge together — so nothing may be doubled (Assumption §89). Only genuinely external seams (CLI/agent invocation, GitHub calls, the human answer at the cap gate) are mocked/injected through the established `PhaseLoopDeps` / `GitHubClient` / `cliSpawner` seams.

**Consequence**: The exact production API each scenario binds to (remediate executor entrypoint, counter-reset trigger shape, monitor routing entrypoint) is **not knowable pre-rebase**. This plan pins the *behavior* to assert and the *seams* to bind through; signatures are resolved at implement time against the merged dependency code.

**Alternatives considered**: co-land unmerged executor work — rejected (splits ownership, re-implements, merge-order hazard). Test-only doubles standing in for any P3 executor — rejected by Assumption §89.

## Decision 2 — Per-round verdict steering seeds the findings-artifact sidecar (Q2=A / D-2)

**Decision**: Drive each round's clean-vs-blocking review outcome by **seeding the findings-artifact sidecar** the review executor reads — the mocked launcher/`reviewExecutor` input pre-writes that round's candidate findings, exactly as the real agent does. The real executor still recomputes the verdict via `computeVerdict`.

**Rationale**: The shipped #1124 executor **never parses agent stdout into findings** — it reads the candidate sidecar the agent wrote and recomputes the verdict. So CLI-output steering (Q2 option B) contradicts the actual seam. Seeding the sidecar keeps the *real* executor and its verdict recomputation in the loop while making each round deterministic: round 1 two blocking findings; round 2 one resolved / one open; round 3 clean; then a seeded validate failure; then clean.

**Grounding**: `computeVerdict(findings, blockingSeverity)` and the sidecar read path are the #1124 surface; `phase-loop.ts:535-537` already calls the real review executor. #1132 adds no new production steering seam — it writes the same sidecar the agent writes.

## Decision 3 — Cap-reset trigger binds at implement time (Q4=C / D-3)

**Decision**: US2 asserts only the **observable** counter-reset + convergence, binding the concrete reset/resume trigger to whatever #1128 ships. Today's `on-remediation-limit` gate (`phase-loop.ts:1122-1147`) pauses on `artifact.round >= maxRemediations && verdict === 'changes-required'` but has **no reset** — the reset mechanism is #1128's to author.

**Rationale**: #1128 owns both the remediation counter and its reset. `waiting-for:remediation-limit` is a **label-driven phase gate**, not a clarification-answer comment — so the human answer is exercised through the phase-loop gate/resume seam (a gate-resume label event), **not** a comment payload. Prescribing a concrete trigger now would bind to unmerged internals. The harness asserts: pause raised, open findings surfaced, counter returns to zero on the answer, loop converges.

**Alternatives considered**: Q4 option A (prescribe a gate-resume label event) / option B (prescribe a clarification-style answer comment) — both rejected as premature binding to #1128 internals; the comment shape is additionally wrong for a label-driven gate.

## Decision 4 — US3 drives the real `PrFeedbackMonitorService` (Q3=A / D-4)

**Decision**: FR-003 / SC-004 assert the **real** `PrFeedbackMonitorService` routing end-to-end — genuine external feedback re-enters `remediate`; engine-authored threads (carrying the P2 marker) are excluded. No standalone marker-match helper, no test-only monitor double.

**Rationale**: The #1127 standalone marker-match helper was an explicit stopgap **because #1130 had not merged**. Under rebase-on-develop, #1130 lands first and wires `matchEngineAuthoredReviewMarker` (already present at `review-poster.ts:64`) into the monitor's routing. Assumption §89 forbids doubles for the P3 executors, so #1132 must exercise the real monitor. Today the monitor has only the `isTrustedCommentAuthor` trust filter (`pr-feedback-monitor-service.ts:267-286`); #1130 adds the engine-thread exclusion + external-feedback→remediate routing, and this scenario exercises that boundary.

**Alternatives considered**: Q3 option B (keep a standalone marker-match helper assertion, rely on #1130's own tests) — rejected; that reproduces the P2 stopgap after the reason for it (unmerged #1130) is gone.

## Decision 5 — #1131 merge-conflict entry point deferred + pinned (Q1=B / D-5)

**Decision**: No fourth scenario. The loop-contract artifact cross-references #1131's merge-conflict re-arm → resolution-scoped review as a documented entry point; this suite ships exactly the three remediate-entry scenarios (review-blocking, validate-failure, external-feedback).

**Rationale**: The issue body enumerates exactly three scenarios and FR-001–003 / US1–3 exercise only the three remediate entry points. Merge-conflict is separate git-surgery machinery whose re-arm target is a scoped review, owned and proven by #1131. A cross-reference/pin matches the #1127 defer+pin precedent.

**Alternatives considered**: Q1 option A (add a fourth merge-conflict scenario) — rejected; drives #1131's git-surgery machinery which is out of scope for the remediate-entry acceptance gate.

## Decision 6 — Loop-contract artifact is a pin note, not a new authored contract (D-6)

**Decision**: `contracts/loop-convergence-contract.md` cross-references #1128–#1131 as the authorship home and the #1123 seam + #1127 marker/findings pins, recording the phase-sequencing (incl. off-sequence backtrack), the three remediate entry points, the counter/cap semantics, the draft/ready invariant, and the engine-thread exclusion boundary (FR-007). It authors no new wire contract.

**Rationale**: The marker/findings shapes are owned by #1124/#1125; the executors/routing by #1128–#1131. #1132's durable acceptance artifact is the pin note + the tests, not a competing contract doc — mirrors #1127's `engine-review-integration.md`.

## Test-convention notes (grounding)

- Integration tests use the `*.integration.test.ts` suffix. US1/US2 phase-loop suites live in `packages/orchestrator/src/worker/__tests__/` (precedent: `phase-loop.review-remediate.integration.test.ts`); US3 monitor-routing suite lives in `packages/orchestrator/src/__tests__/` (precedent: `pr-feedback-integration.test.ts`).
- Harness builders `createMockDeps()` / `createMockContext()` / `createConfig({ reviewPhaseEnabled: true })` / `getPhaseSequence(workflow, true)` / `phaseStartOrder()` / `fireOnceTrigger()` are lifted from the P1/P2 integration tests.
- `GitHubClient` is mocked as a capturing spy (`vi.fn()` per method, cast `as unknown as GitHubClient`); assertions read `.mock.calls`.
- Per-round verdict steering writes the candidate findings sidecar before each review pass (Decision 2), never a CLI-output shim.
- Marker matching follows `review-poster.ts` / `clarification-markers.ts`: line-anchored at column 0, case-sensitive ASCII, `> `-quoted markers do not match.

## Sources

- `docs/engine-review-remediate-plan.md` (generacy-ai/tetrad-development) — full epic design.
- Epic body: generacy-ai/generacy#1120.
- P1 seam contract: `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`.
- P2 pin note: `specs/1127-context-phase-2-integration/contracts/engine-review-integration.md`.
- Dependencies: #1128 (remediate executor + counter + cap gate), #1129 (validate→remediate routing), #1130 (monitor exclusion + external-feedback routing), #1131 (merge-conflict re-arm → resolution-scoped review).
