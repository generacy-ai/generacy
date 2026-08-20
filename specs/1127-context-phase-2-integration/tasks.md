# Tasks: implement→review→ready flow end-to-end (Phase-2 integration)

**Input**: Design documents from `/specs/1127-context-phase-2-integration/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/engine-review-integration.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Notes on this issue

- Ships **no product behavior** (Q1=A). Deliverables: three integration/unit test suites + a contract pin note (already drafted at `contracts/engine-review-integration.md`).
- **The implement phase dependency-blocks until #1124, #1125, and #1126 merge to `develop`** and this branch is rebased on them. Do not write test bodies against guessed signatures — bind to the merged production API at implement time (research.md Decision 1).
- The only test-only double is the `remediate` stub, injected through the existing `PhaseLoopDeps.remediateTrigger` seam (Q3=A). No shipped placeholder executor.
- `PrFeedbackMonitorService` is **not** imported or modified (Q4=B / SC-005).

## Phase 1: Setup & dependency rebase (BLOCKING gate)

- [X] T001 Confirm #1124, #1125, #1126 are merged to `develop`; rebase `1127-context-phase-2-integration` onto `develop`. If any dependency is still open, dependency-block (skip→requeue-after-deps) per plan.md "Dependencies & landing order". Do not proceed to Phase 2 until all three are landed.
- [X] T002 [P] Bind the consumed production API surface against the merged dependency code (record exact names in a scratch note; do NOT guess pre-rebase). Identify: (a) the real `review` executor entrypoint and how `phase-loop.ts:473-477` invokes it (#1124), (b) the findings-artifact / verdict type and its verdict-steering lever — seedable sidecar vs. `cliSpawner` CLI output (#1124, research.md Decision 2), (c) the `COMMENT`-event posting method + ready→draft-conversion method on `PrManager` (#1125), (d) whether #1125 ships a co-located `match…Marker` helper or only the marker constant (decides D-3 preferred vs. fallback).
- [X] T003 [P] Confirm `pnpm install` and that the orchestrator test harness builders (`createMockDeps()`, `createMockContext()`, `createConfig()`, `fireOnceTrigger()`, `phaseStartOrder()`) are available to lift from `packages/orchestrator/src/worker/__tests__/phase-loop.review-remediate.integration.test.ts` (P1 template).

## Phase 2: US1 — clean-review happy path (FR-001 / FR-002 / FR-003)

- [X] T010 [US1] Create `packages/orchestrator/src/worker/__tests__/phase-loop.review-clean.integration.test.ts`. Set up the harness lifted from the #1123 P1 integration test: mocked `GitHubClient` capturing spy, `createConfig({ reviewPhaseEnabled: true })`, drive `PhaseLoop.executeLoop(context, config, deps, getPhaseSequence(workflow, true))`.
- [X] T011 [US1] Add the verdict-steering shim that drives the review executor to a **clean** verdict (empty/at-or-below-`blockingSeverity` finding set) via the lever identified in T002 (findings sidecar seed or `cliSpawner` output). Do not re-implement verdict logic (FR-008 / D-1).
- [X] T012 [US1] Assert phase order includes `implement → review → validate` with `review` immediately after `implement`, parameterized for **both** `speckit-feature` and `speckit-bugfix` (SC-002). Use `phaseStartOrder()`.
- [X] T013 [US1] Assert exactly one PR review is posted with `event: 'COMMENT'` and **zero** `REQUEST_CHANGES` on the own PR (FR-002 / SC-003), reading the posting spy's `.mock.calls`.
- [X] T014 [US1] Assert the posted review body carries the engine-authored marker via the FR-005 marker-match helper (not a raw string literal, so the suites cannot drift). Depends on the helper source resolved in Phase 4 / T031.
- [X] T015 [US1] Assert `prManager.markReadyForReview` is called on the clean verdict and the loop advances into `validate` (FR-003).

## Phase 3: US2 — changes-required branch up to the remediate seam (FR-004)

- [X] T020 [US2] Create (or extend the #1123 sibling) `packages/orchestrator/src/worker/__tests__/phase-loop.review-remediate.integration.test.ts`. Reuse the same harness; inject the test-only `remediate` stub through `PhaseLoopDeps.remediateTrigger` (Q3=A / D-2). No new loop-control mechanism.
- [X] T021 [US2] Steer the first `review` pass to an at/above-`blockingSeverity` **blocking** verdict (same input-steering lever as T011). Bind `remediateTrigger` to that verdict where #1126 exposes it, or use a fire-once shim standing in for #1126's trigger (research.md Decision 3).
- [X] T022 [US2] Assert the blocking verdict routes the loop **off-sequence** toward `remediate` (FR-004), not to the next linear phase.
- [X] T023 [US2] Assert that if the PR was already marked ready, entering `remediate` calls the ready→draft-conversion (`prManager` draft call from #1125) — asserted as the ready→draft transition (SC-004).
- [X] T024 [US2] Assert that after the stub `remediate`, control backtracks to a `review` pass (delta-scoped) via the `i--; continue;` invariant from the #1123 seam contract — never to the next linear phase.
- [X] T025 [US2] Steer the re-review to a **clean** verdict; assert `markReadyForReview` is re-called and the loop resumes forward (SC-004 — one round-trip).

## Phase 4: US3 — standalone marker-match helper (FR-005 / D-3)

- [X] T030 [US3] Decide the D-3 path from T002(d): **preferred** — assert #1125's shipped co-located `match…Marker` helper; **fallback** — if #1125 ships only the marker constant, add a minimal deterministic `matchEngineAuthoredReviewMarker(body: string): boolean` co-located in the marker module (NOT in `PrFeedbackMonitorService`), exported for #1130. If fallback fires, this is a non-test product change under `packages/orchestrator/src/worker/` → triggers the changeset gate (see T041).
- [X] T031 [US3] Create `packages/orchestrator/src/worker/__tests__/engine-authored-marker.test.ts`. Assert the marker-match helper returns "exclude"/match for an engine-authored review body, and **non-match** for (a) a plain external-reviewer comment and (b) a `> `-quoted marker (marker-family precedent: line-anchored at column 0, case-sensitive ASCII).
- [X] T032 [US3] Add an import-absence assertion in `engine-authored-marker.test.ts` proving `PrFeedbackMonitorService` is not imported or modified (Q4=B / SC-005).

## Phase 5: Contracts & changeset

- [X] T040 [P] Finalize the contract pin note `contracts/engine-review-integration.md` (FR-006 / FR-007 / SC-006): confirm the marker match rule (§1), findings-artifact fields (§2), and posting/lifecycle rules (§3) match the **merged** #1124/#1125 shapes; correct any cross-reference that drifted from the actual merged types. Author no new contract — #1124/#1125 remain the authorship home (Q2=B).
- [X] T041 Changeset decision (per plan.md → Changeset): if D-3's **preferred** path held (test-only diff, no product `src/` change) → changeset-exempt, add none. If D-3's **fallback** fired (marker-match helper landed under `packages/orchestrator/src/worker/`) → add `.changeset/1127-engine-review-integration.md` for `@generacy-ai/orchestrator` **patch** (internal helper, not re-exported).

## Phase 6: Verification

- [X] T050 Run the Phase-2 suite green in CI (SC-001): `pnpm --filter @generacy-ai/orchestrator test -- phase-loop.review` plus `engine-authored-marker`. Confirm SC-002 (2/2 workflows traverse `implement → review → ready → validate`), SC-003 (1 COMMENT / 0 REQUEST_CHANGES), SC-004 (one ready↔draft round-trip), SC-005 (marker-match excludes; monitor untouched), SC-006 (both contracts pinned/cross-referenced in the diff).
- [X] T051 [P] Confirm FR-008 negative invariants: no real `remediate` executor, remediation counter, `waiting-for:remediation-limit` gate, validate-failure routing, external-feedback routing, or merge-conflict re-arm introduced; `git diff` shows only test files (+ the D-3 fallback helper/changeset, if T041 fired).

## Dependencies & Execution Order

**Blocking gate**: Phase 1 (T001) must complete — #1124/#1125/#1126 merged and rebased — before any test body is written. Signatures are bound at implement time (T002), not guessed.

**Sequential phase boundaries**:
- Phase 1 → Phase 2/3/4 (all test suites depend on the rebased API surface).
- Phase 4 T030/T031 must resolve the marker-match helper before Phase 2 T014 can assert it (T014 depends on the helper source). Practically, do T030/T031 early or land T014 after Phase 4.

**Parallel opportunities**:
- T002 and T003 [P] after T001.
- Phase 2 (US1), Phase 3 (US2), and Phase 4 (US3) target **different files** and can be developed in parallel once Phase 1 is done — except the T014→T031 helper dependency noted above.
- T040 [P] (contract note) and T051 [P] (invariant audit) are independent of the test-writing tasks.

**Suggested next step**: `/speckit:implement` to begin execution (blocked until the Phase 1 gate clears).
