# Tasks: Full review⇄remediate loop end-to-end (Phase-3 integration)

**Input**: Design documents from `/specs/1132-context-phase-3-integration/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/loop-convergence-contract.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Scope note

This issue ships **no product behavior** (FR-008): three integration scenario suites that drive a **real** worker phase loop through the P3 executors (#1128–#1131), plus a durable loop-contract pin note. Nothing is doubled — the real `remediate` executor, validate→remediate routing, and the real `PrFeedbackMonitorService` exclusion all run (Assumption §89). The exact production APIs each scenario binds to are resolved **at implement time against the merged dependency code** (D-1; signatures are not knowable pre-rebase).

## Phase 1: Dependency Gate & Setup

<!-- The implement phase dependency-blocks (skip→requeue-after-deps) until all four P3 executors land on develop. -->

- [X] T001 [Setup] Confirm dependencies #1128 (remediate executor + counter + cap gate), #1129 (validate→remediate routing), #1130 (monitor exclusion + external-feedback routing), #1131 (merge-conflict re-arm) are merged to `develop`. If any is unmerged, **stop and requeue-after-deps** (do not implement against stubs) — Assumption §88, D-1.
- [X] T002 [Setup] Rebase `1132-context-phase-3-integration` on the updated `develop`; resolve conflicts favoring the merged dependency code. Verify `pnpm install` and a baseline `pnpm --filter @generacy-ai/orchestrator build` are green post-rebase.
- [X] T003 [Setup] Ground the merged P3 seams against `plan.md` → "Grounding" and "ABSENT on this branch" tables: locate the real `remediate` executor entrypoint (replacing `runStubPhase('remediate')` at `phase-loop.ts:538-541` and `:1277`), the counter-reset trigger on the `on-remediation-limit` gate (`phase-loop.ts:1122-1147`), and the `PrFeedbackMonitorService` engine-thread exclusion + external-feedback→remediate routing (`pr-feedback-monitor-service.ts`). Record the concrete bound signatures for use by T010/T020/T030.
- [X] T004 [P] [Setup] Confirm the P1/P2 harness builders are reusable: `createMockDeps()`, `createMockContext()`, `createConfig({ reviewPhaseEnabled: true })`, `getPhaseSequence(workflow, true)`, `phaseStartOrder()`, `fireOnceTrigger()` in `packages/orchestrator/src/worker/__tests__/phase-loop.review-remediate.integration.test.ts` and `phase-loop.review-clean.integration.test.ts`. Note the `GitHubClient` capturing-spy pattern (`vi.fn()` per method, `as unknown as GitHubClient`) and the sidecar-seeding helper used for per-round verdict steering (Q2=A / research.md Decision 2).

## Phase 2: US1 — Full multi-round convergence (FR-001, SC-002/005/006)

**File**: `packages/orchestrator/src/worker/__tests__/phase-loop.review-remediate-convergence.integration.test.ts`

- [X] T010 [US1] Scaffold the convergence suite: parameterize over both workflows (`speckit-feature`, `speckit-bugfix`). Set up the mocked `GitHubClient` capturing spy, real review + remediate executors, `createConfig({ reviewPhaseEnabled: true })`, and drive via `PhaseLoop.executeLoop(context, config, deps, getPhaseSequence(workflow, true))`. Wire the per-round sidecar-seeding steering helper (pre-write each round's candidate `FindingsArtifact`; the real executor recomputes via `computeVerdict` — Q2=A, no CLI-output shim).
- [X] T011 [US1] Seed the round sequence and assert the review-blocking entry point (AC1): round-1 review returns two at/above-`blockingSeverity` findings → routes off-sequence into `remediate` → `convertToDraftIfEngineMarkedReady` converts the ready PR back to draft → backtracks (`i--; continue;`) to a delta-scoped re-`review`.
- [X] T012 [US1] Assert the multi-round re-review (AC2): round-2 re-review resolves one finding / leaves one open → re-enters `remediate` (remediation counter increments) → re-reviews again.
- [X] T013 [US1] Assert clean → ready → validate (AC3): a clean re-review calls `markReadyForReview` and the loop advances into `validate`.
- [X] T014 [US1] Assert the **validate-failure** entry point (AC4 — the second remediate entry point, #1129): a seeded `validate` failure routes back into `remediate`, converts ready→draft, re-reviews, and re-validates.
- [X] T015 [US1] Assert forward termination (AC5): a green `validate` after the final remediation round terminates the loop forward — no further backtrack.
- [X] T016 [US1] Assert cross-cutting consistency (AC6 / FR-006): findings artifact, remediation counter, and phase/gate labels are consistent at every transition (counter increments per remediation round; labels track the active phase/gate).
- [X] T017 [US1] Assert the efficiency guarantee (FR-005 / SC-005): **at most one** full validate/suite execution per clean-review cycle — assert on the validate-spawn / suite-invocation count; the loop does not re-run the suite while findings remain open.
- [X] T018 [US1] Assert the draft/ready invariant (FR-004 / SC-006): every clean review → ready; every `remediate` entry (from both entry points exercised here) → back to draft; every re-clean → ready.

## Phase 3: US2 — Remediation cap + reset + converge (FR-002, SC-003)

**File**: `packages/orchestrator/src/worker/__tests__/phase-loop.remediation-cap.integration.test.ts`

- [X] T020 [US2] Scaffold the cap suite from the T010 harness. Seed each round's sidecar to keep the verdict `changes-required` until the counter reaches the configured `maxRemediations` (feature 3 / bugfix 2 — drive to the configured limit, do not hardcode the numeric default per Assumption §93).
- [X] T021 [US2] Assert the cap pause (SC-003): when the remediation counter reaches `maxRemediations`, the loop pauses and raises `waiting-for:remediation-limit`, with **zero** terminal `blocked:*` labels.
- [X] T022 [US2] Assert findings surfacing (FR-002): the remaining `open` findings are surfaced to the human at the pause point.
- [X] T023 [US2] Assert counter-reset + resume: inject a simulated human answer through **whatever reset/resume seam #1128 ships** (bound at implement time per T003 / Q4=C — a label-driven gate/resume event, not a comment payload) and assert the counter resets to zero and the loop resumes.
- [X] T024 [US2] Assert convergence after reset (SC-003): after reset, a clean re-review converges and the loop proceeds forward. Assert only the **observable** reset + convergence, not the concrete trigger shape (Q4=C).

## Phase 4: US3 — External feedback re-entry + engine-thread exclusion (FR-003, SC-004)

**File**: `packages/orchestrator/src/__tests__/pr-feedback-external-remediate.integration.test.ts`

- [X] T030 [US3] Scaffold the external-feedback suite driving the **real** `PrFeedbackMonitorService` end-to-end (Q3=A — no standalone marker-match helper, no monitor double). Mock `GitHubClient` to return PR threads: (a) a genuinely external human review thread and (b) an engine-authored thread carrying the P2 marker (`matchEngineAuthoredReviewMarker(body) !== undefined`, `generacy-engine-review` prefix, `review-poster.ts:23,64`).
- [X] T031 [US3] Assert external re-entry (AC1): the external human review thread on a ready PR routes the loop back into `remediate` (#1130) and converts the PR back to draft.
- [X] T032 [US3] Assert engine-thread exclusion (AC2 / SC-004): the engine-authored marker-carrying thread is **not** treated as external feedback and does **not** trigger re-entry — the engine never races its own review loop.
- [X] T033 [US3] Assert convergence (AC3): after remediating the external feedback, a clean re-review re-marks the PR ready and the loop converges.

## Phase 5: Loop-Contract Artifact & Verification

- [X] T040 [Polish] Finalize and verify `specs/1132-context-phase-3-integration/contracts/loop-convergence-contract.md` (FR-007 / SC-007): confirm it pins the phase-sequencing (incl. off-sequence backtrack), the three remediate entry points (+ #1131 deferred/pinned per Q1=B), the counter/cap/reset semantics, the draft/ready invariant, and the engine-thread-exclusion boundary — cross-referencing #1128–#1131 as authorship home and the #1123 seam + #1127 marker/findings pins. It must author **no** new wire contract (D-6). Confirm the doc is present in the PR diff.
- [X] T041 [Polish] Changeset decision (plan.md → Changeset): if the diff is test-only under `packages/orchestrator/src/**` plus the spec `contracts/` doc, the gate is satisfied by **exemption** — add **no** `.changeset/*.md`. Only if driving the real monitor or the cap-reset seam required a **minimal non-test seam** under `packages/*/src/` did the gate trigger → add `.changeset/1132-loop-convergence-integration.md` (`@generacy-ai/orchestrator` **patch**, no new public exports). Verify with `pnpm changeset status`.
- [X] T042 [Polish] Run the full Phase-3 suite green (SC-001): `pnpm --filter @generacy-ai/orchestrator test -- review-remediate-convergence remediation-cap pr-feedback-external-remediate`. Confirm all three scenarios pass and the scope guard holds (FR-008): no changes to the remediate executor, counter, cap gate, or routing/exclusion logic beyond what #1128–#1131 shipped.

## Dependencies & Execution Order

**Hard dependency gate (Phase 1 first, blocking)**:
- T001 → T002 → T003 gate everything. The implement phase **dependency-blocks** (skip→requeue-after-deps) until #1128/#1129/#1130/#1131 land on `develop`. T004 [P] can proceed alongside T003 once rebased.

**Phase ordering**:
- Phase 1 (setup/rebase) → Phases 2, 3, 4 (the three scenario suites) → Phase 5 (contract + verification).
- Phases 2, 3, 4 each edit a **different** test file and can be developed **in parallel** once Phase 1 completes:
  - Phase 2 → `phase-loop.review-remediate-convergence.integration.test.ts`
  - Phase 3 → `phase-loop.remediation-cap.integration.test.ts` (reuses the T010 harness setup — start after T010 lands, or copy the builder wiring)
  - Phase 4 → `pr-feedback-external-remediate.integration.test.ts` (independent — real monitor, own directory)

**Within-phase ordering**:
- Phase 2: T010 (scaffold) → T011…T018 build on the seeded round sequence and are largely sequential within the single file.
- Phase 3: T020 (scaffold) → T021 → T022 → T023 → T024 sequential (each depends on the prior round state).
- Phase 4: T030 (scaffold) → T031, T032, T033 (assertions on the mocked-thread fixtures; can be co-authored).

**Parallel opportunities**:
- T004 [P] alongside T003.
- The three scenario suites (Phases 2/3/4) are file-disjoint and parallelizable across agents after Phase 1, though Phase 3 reuses Phase 2's harness wiring.

## Suggested next step

`/speckit:implement` to begin execution — starting with the T001–T003 dependency gate (do not proceed to the scenario suites until #1128–#1131 are confirmed merged and the branch is rebased).
