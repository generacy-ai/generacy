# Tasks: Bugfix profile end-to-end with targeted validate (Phase-4 integration)

**Input**: Design documents from `/specs/1135-context-phase-4-integration/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Overview

This is a **tests-and-docs-only** integration checkpoint (FR-010). It ships: a synthetic
monorepo fixture, four phase-loop integration scenario suites, a schema-validated docs
config example, and a finalized loop-contract pin note. No product behavior of its own.

**Landing order (D-1 / Assumptions §99)**: the implement phase **dependency-blocks** until
**#1134** (verification charter + targeted validate + diff-classification guards + `failThenPass`)
and **#1133** (merge-readiness `skipped`/`neutral`≠passed + validate/CI parallelism + post-validate
`implementation-review` final gate) land on `develop`. Then this branch **rebases** on both and
binds the harness to the real merged seams. Do NOT re-implement any profile behavior.

---

## Phase 1: Dependency gate & rebase (blocking prerequisite)
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [X] T001 Verify **#1134** is merged to `develop` (`gh pr list --search "1134 in:title" --state merged` / `git log origin/develop --grep 1134`). If not merged, **skip → requeue-after-deps** per D-1; do not proceed.
- [X] T002 Verify **#1133** is merged to `develop` (same check for 1133). If not merged, skip → requeue-after-deps.
- [X] T003 Rebase `1135-context-phase-4-integration` on the merged `develop` (P1–P3 + #1133 + #1134). Resolve conflicts by taking the merged profile behavior; keep this branch's spec artifacts.
- [X] T004 Bind-point survey: locate the real merged seams the harness will consume and record their signatures in a scratch note — (a) the per-suite runner / suite-spawn seam in `cli-spawner.ts` / `runValidatePhase` (Decision 1), (b) the targeted-command derivation entrypoint + how the diff shape is supplied (Decision 2/US2), (c) the CI-status injection seam via #1133 merge-readiness (Decision 4), (d) the post-validate `implementation-review` final-gate raise site (#1133). This resolves the "API bound at implement time" open bindings (research §64-69).

## Phase 2: Synthetic monorepo fixture
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [X] T005 [P] [US1] Author the workspace root of the synthetic fixture at `packages/orchestrator/src/worker/__tests__/fixtures/bugfix-monorepo/`: `pnpm-workspace.yaml` (`packages: ["packages/*"]`) + root `package.json`. (data-model §1)
- [X] T006 [P] [US1] Author the five fixture packages with the hand-authored dependency graph (data-model §1): `packages/core/package.json` (leaf, NO dependents), `packages/a/package.json` (deps: core), `packages/b/package.json` (deps: a), `packages/util/package.json` (independent), `packages/docs/package.json` (docs-only). Guarantee `changed=core → affected={core,a,b}` is a **strict subset** of the 5-package workspace (D-3 / SC-003).
- [X] T007 [US1] Add a self-check assertion (in the shared harness helper or a tiny fixture test) that the fixture's affected-set count for a `core` change is **strictly fewer** than the full-workspace count — fails loudly if a future edit widens the closure (troubleshooting: quickstart §62).

## Phase 3: Shared harness scaffolding & runner instrumentation
<!-- Phase boundary: Complete Phase 3 before starting Phase 4 -->

- [X] T008 [US1] Create shared harness helpers for the bugfix scenarios (extend/reuse the P1/P2/P3 template: `createMockDeps()`, `createMockContext()`, `createConfig({ reviewPhaseEnabled: true })`, `getPhaseSequence('speckit-bugfix', true)`, `phaseStartOrder()`, `fireOnceTrigger()`). Add a bugfix-profile config builder (`profile: verification`, `blockingSeverity: critical`, `maxRemediations: 2`, targeted `validateCommand`, cheaper review agent). Place in a new `__tests__/helpers/bugfix-harness.ts` (or inline shared module).
- [X] T009 [US1] Implement the **instrumented stub runner** at the per-suite spawn seam (Decision 1 / Q1=C): records each suite spawn as `{ suite, kind: 'test'|'build', ref }` (data-model §2). Bind to #1134's per-suite seam if it exposes one; otherwise add the **minimal** injectable per-suite runner hook. Expose a counter API: total count, `test`-kind count, and per-`ref` breakdown. **Changeset caveat (D-2)**: if this requires a non-test seam under `packages/*/src/`, add `.changeset/1135-bugfix-profile-integration.md` (`@generacy-ai/orchestrator` **patch**).
- [X] T010 [US3] Implement the **(command, ref)-keyed validate seam stub** (Decision 3 / Q3=A / data-model §3): map `(command, ref) → 'pass'|'fail'`, injected per invocation. Shared across scenarios; used to seed `failThenPass` base/branch outcomes.
- [X] T011 [US1] Implement the **CI-status injection helper** through the #1133 merge-readiness seam (Decision 4 / data-model §4): inject `success`/`skipped`/`neutral` and expose whether the `implementation-review` final gate was raised. Shared by happy-path and ci-negative scenarios.
- [X] T012 [US1] Implement the **findings-artifact seeding helper** (data-model §6, pinned by #1127): the mocked launcher pre-writes each round's candidate findings; the real executor recomputes the verdict via `computeVerdict`. Seed the round-1 "missing regression test" blocking finding used by US1.

## Phase 4: Integration scenarios
<!-- Phase boundary: Complete Phase 4 before starting Phase 5 -->

- [X] T013 [US1] Author `packages/orchestrator/src/worker/__tests__/phase-loop.bugfix-happy-path.integration.test.ts` (FR-001/FR-002/FR-007): drive `PhaseLoop.executeLoop(context, config, deps, getPhaseSequence('speckit-bugfix', true))` through `implement → verification review (blocking: missing regression test) → remediate (adds test) → clean re-review → markReadyForReview → targeted validate ∥ injected green CI → post-validate implementation-review final gate`. Assert: (AC1) **verification** charter selected, not feature; (AC2) blocking finding routes into `remediate`, remediation adds test, clean re-review; (AC3/AC4) targeted validate suite-execution count **equals affected-set** and is **strictly fewer** than full-workspace (SC-003); (AC5) final gate raised **only when both** validate and green CI (FR-007); (AC6) counter caps at **2** and converges **before** the cap.
- [X] T014 [P] [US2] Author `packages/orchestrator/src/worker/__tests__/phase-loop.bugfix-diff-guards.integration.test.ts` (FR-003/FR-004): two variants on the fixture. **Root-config variant** — diff touches root-level config (lockfile / base tsconfig / workspace file / CI workflow) → resolved validate **falls back to full command**, runner count **= full-workspace count** (SC-004). **Docs-only variant** — docs-only diff → **skips tests**, **test** suite-execution count **= 0** (SC-004). Each variant asserts its count explicitly (FR-006).
- [X] T015 [P] [US3] Author `packages/orchestrator/src/worker/__tests__/phase-loop.bugfix-fail-then-pass.integration.test.ts` (FR-005): **`failThenPass` on** — seed `(newTestFile, base)→fail`, `(newTestFile, branch)→pass`; assert new/changed test **executed against base ref**, required **fail-on-base / pass-on-branch**, and a negative variant seeded **pass-on-base fails the gate**; count **includes** the extra base-ref run. **`failThenPass` off (default)** — assert **no base-ref execution**, count omits it. Both assert counts (FR-006 / SC-005).
- [X] T016 [P] [US1] Author `packages/orchestrator/src/worker/__tests__/phase-loop.bugfix-ci-negative.integration.test.ts` (FR-007 / Q4=A): with validate green, inject **`skipped`** CI → final gate **NOT** raised; inject **`neutral`** CI → final gate **NOT** raised (SC-004). (Green-both-pass positive lives in T013.)
- [X] T017 [US1][US2][US3] Cross-cutting audit: confirm **every** scenario/variant across T013–T016 asserts an **explicit suite-execution count** (FR-006 / SC-006) — a variant with the wrong count must fail even when otherwise green. Fix any variant missing a count assertion.

## Phase 5: Docs config example (US4)
<!-- Phase boundary: Complete Phase 5 before starting Phase 6 -->

- [X] T018 [P] [US4] Author the copy-pasteable per-repo bugfix-profile `.generacy/config.yaml` example at `docs/docs/reference/bugfix-profile-config.md` (Q5=A / FR-008). Cover targeted `validateCommand`, `profile: verification`, `blockingSeverity: critical`, `maxRemediations: 2`, opt-in `failThenPass` toggle, and a cheaper review model/effort (per-workflow agents).
- [X] T019 [US4] Author `packages/orchestrator/src/**/__tests__/bugfix-profile-config-example.test.ts` (FR-008 / SC-007 / Q5=A): read the shipped docs YAML, parse it against the **shipped P4 config schema** (`resolveWorkflowOverrides` / review-profile schema in `config.ts`), assert it validates and carries `verification` / `critical` / `maxRemediations: 2` / a targeted `validateCommand` / the `failThenPass` toggle — so the example cannot silently drift.

## Phase 6: Loop-contract artifact
<!-- Phase boundary: Complete Phase 6 before starting Phase 7 -->

- [X] T020 [US1] Finalize `specs/1135-context-phase-4-integration/contracts/bugfix-profile-loop-contract.md` (FR-009 / SC-008 / D-8): verify it records the verification-charter shape, the diff-classification guard matrix (**including the pinned single-package guard**, D-7), the suite-count invariant, and the validate/CI final-gate sequencing — cross-referencing **#1133/#1134** as authorship home and the #1123 seam + #1127 marker/findings pins. It authors no new wire contract; update only to match the real merged seams from T004.

## Phase 7: Verification
<!-- Phase boundary: Complete all prior phases before Phase 7 -->

- [X] T021 Run the full P4 suite locally: `pnpm --filter @generacy-ai/orchestrator test:integration phase-loop.bugfix` (10 green) and `pnpm --filter @generacy-ai/orchestrator test bugfix-profile-config-example` (3 green). The `.integration.test.ts` scenarios run under `test:integration`; the config-example unit test runs under plain `test`. All green (SC-001/SC-002).
- [X] T022 Changeset gate check (CLAUDE.md): confirmed the diff is **test-only** under `packages/orchestrator/src/**` (all files under `__tests__/` incl. fixtures + helpers) + spec `contracts/` + `docs/` markdown ⇒ **no `.changeset/*.md`** required (exemption). T009 landed **no** non-test seam under `packages/*/src/`, so the exception does not apply.
- [X] T023 Final consistency pass: confirmed no product behavior was changed (FR-010) — no edits to the verification charter, targeted-validate command, diff-classification guards, `failThenPass`, merge-readiness evaluation, validate/CI orchestration, or the final gate beyond the minimal T009 instrumentation seam (if any).

## Dependencies & Execution Order

**Phase boundaries (sequential)**:
- Phase 1 (dependency gate + rebase) → Phase 2 (fixture) → Phase 3 (harness) → Phase 4 (scenarios) → Phase 5 (docs) → Phase 6 (contract) → Phase 7 (verification).
- **Phase 1 is a hard gate**: if #1133/#1134 are unmerged, stop and requeue-after-deps (D-1). Everything downstream binds to their merged seams (T004).

**Critical path**: T001/T002 → T003 → T004 → T008–T012 (harness) → T013 (US1 happy path) → T017 → T021.

**Parallel opportunities**:
- Phase 2: T005 and T006 are `[P]` (distinct fixture files); T007 depends on both.
- Phase 3: harness helpers (T008–T012) are mostly sequential-ish (shared module) but T009/T010/T011 target distinct seams and may be split if placed in separate files.
- Phase 4: T014, T015, T016 are `[P]` with each other (distinct test files); all depend on the Phase 3 harness. T013 should land first (validates the shared harness end-to-end); T017 depends on T013–T016.
- Phase 5: T018 (`[P]`, docs markdown) can be authored anytime after T004; T019 depends on T018.

**Notes**:
- Playbook coupling: spec.md names no `packages/claude-plugin-cockpit/commands/*.md` file → no playbook re-pin task required.
- No `.specify/memory/constitution.md` in the repo → constitution check skipped.
