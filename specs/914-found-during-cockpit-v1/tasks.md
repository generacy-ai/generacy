# Tasks: Hoist the pre-phase base-merge to run once per cycle (#914)

**Input**: Design documents from `/specs/914-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/phase-loop-merge-invariant.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to. This bugfix has a single implicit user story (US1: "as a worker running a validate cycle on a behind-base branch, I want install artifacts to survive to validate so that the phase does not fail with a phantom `exit 127`").

## Phase 1: Regression tests (flip + add — must fail against current code)

Rationale (TDD-lite for a structural bugfix): each new/updated assertion below fails against `main`'s double-merge shape and passes after Phase 2's hoist. Landing them first proves the fixtures actually exercise the bug's mechanism (per plan §Test discharge and contracts/phase-loop-merge-invariant.md §Test discharge).

- [X] T001 [US1] Flip the existing buggy-behavior test in `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` (~line 342) — rename `"runs a second base-merge before the validate command itself"` → `"runs a single base-merge before the pre-validate install"`, and change the assertion from `baseMergeCount === 2` to `baseMergeCount === 1` with the recorded event order `[base-merge, install, validate]` (contract §Test discharge, quickstart §Verifying the fix locally).
- [X] T002 [US1] Add fixture `"validate — install artifacts survive to validate"` in `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` — the install `cliSpawner` fake writes a marker (e.g., `node_modules/.stamp`) under the checkout path; the validate fake reads it and fails the test if absent; assert `baseMergeCount === 1`. Discharges SC-001 and reproduces the snappoll#4 sequence at unit scope (research Decision 4).
- [X] T003 [US1] Add fixture `"validate — up-to-date branch — single merge, unchanged behavior"` in `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` — `BaseMergeRunner` fake returns `{ ok: true }` immediately; assert install and validate each run exactly once and `baseMergeCount === 1`. Discharges FR-003 (unchanged path).
- [X] T004 [US1] Add fixture `"validate — retry re-runs install AND merge"` in `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` — drive the loop so the first validate attempt fails and triggers `i--; continue;`, second attempt passes; assert `baseMergeCount === 2` (one per attempt) and install ran twice. Discharges clarification Q3-A and contract §Retry semantics.
- [X] T005 [US1] Add fixture `"implement — single merge (symmetry case per Q5-B)"` in `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` — implement phase with `BaseMergeRunner` fake; assert `baseMergeCount === 1` and event order `[base-merge, implement-spawn]`. Guards against a future edit that mirrors a "pre-install-for-implement" hook (clarification Q5-B, research Decision 5).
- [X] T006 [US1] Run `pnpm --filter '@generacy-ai/orchestrator' test -- phase-loop.merge` and confirm T001–T005 all **fail** against the unmodified `phase-loop.ts` (T001 fails because count is 2 not 1; T002 fails because the marker is destroyed by the second merge's `git clean -fd`; T004 fails on the retry-attempt count; T003 and T005 may already pass). This proves each new assertion actually catches the double-merge shape.

## Phase 2: Implementation — hoist the merge behind a per-iteration guard
<!-- Phase boundary: All Phase 1 tests must be authored before starting Phase 2 -->

- [X] T010 [US1] In `packages/orchestrator/src/worker/phase-loop.ts` inside `executeLoopInner`, at the top of the `for (let i = startIndex; i < sequence.length; i++)` body (immediately after `const phase = sequence[i]!;`), declare `let hasBaseMergedThisCycle = false;`. Block-scope is load-bearing — it re-initializes on every iteration including retry re-entries via `i--; continue;` (data-model.md §hasBaseMergedThisCycle, research Decision 2).
- [X] T011 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, wrap the existing `runPreImplementBaseMerge` call site in the guard: `if (!hasBaseMergedThisCycle) { const outcome = await this.runPreImplementBaseMerge(...); if (outcome !== undefined) return outcome; hasBaseMergedThisCycle = true; }`. Zero behavior change on the implement branch today; this is the symmetry immunization per Q5-B (contract §Enforcement mechanism).
- [X] T012 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, wrap the **first** `runPreValidateBaseMerge` call site (~line 264, before the pre-validate install command) in the same guard shape as T011, setting `hasBaseMergedThisCycle = true;` after a successful (undefined return) merge outcome (plan §Project Structure).
- [X] T013 [US1] In `packages/orchestrator/src/worker/phase-loop.ts`, **delete** the second `runPreValidateBaseMerge` call at lines ~311–325 (the between-install-and-validate invocation). This is the one-mechanism fix — the guard from T010 + T012 makes the deletion redundant *and* self-documenting; leaving the call site as a guarded no-op would be a maintenance hazard (research Decision 1, alternative B).

## Phase 3: Verification
<!-- Phase boundary: Phase 2 code changes must be in place before starting Phase 3 -->

- [X] T020 [US1] Re-run `pnpm --filter '@generacy-ai/orchestrator' test -- phase-loop.merge` and confirm T001–T005 all now pass. Any regression here indicates the guard's initial-value or set-point is off — inspect the iteration boundary (`let` inside the `for` body, not outside).
- [X] T021 [US1] Run the full orchestrator test suite `pnpm --filter '@generacy-ai/orchestrator' test` to confirm no collateral breakage — in particular the merge-conflict-pause tests (`waiting-for:merge-conflicts` / `completed:merge-conflicts` path), which route through the same `runPrePhaseBaseMerge` layer but are unchanged by this fix (data-model §No changes to persisted schemas, quickstart §Behavioral surface for operators).
- [X] T022 [US1] Run `pnpm typecheck` (or the repo's equivalent) to catch any type drift from the guard-bool introduction — none expected because the change is a local `let` and existing return types are unchanged, but this is the standard structural sanity check for this repo.
- [X] T023 [US1] Grep `packages/orchestrator/src/worker/phase-loop.ts` for `runPreValidateBaseMerge` and `runPreImplementBaseMerge`: each should appear exactly **once** as a call site inside `executeLoopInner`, each wrapped in the `if (!hasBaseMergedThisCycle)` guard. Any remaining unguarded call site would silently defeat the invariant.

## Dependencies & Execution Order

**Phase boundaries** (sequential): Phase 1 → Phase 2 → Phase 3.

**Within Phase 1**:
- T001–T005 all edit the same test file (`phase-loop.merge.test.ts`) — no `[P]`; do them sequentially to avoid merge conflicts in a single file. Ordering within the file is cosmetic.
- T006 gates Phase 2: run tests, confirm failure shape matches expectation, then advance.

**Within Phase 2**:
- T010 must precede T011 and T012 (they reference the guard bool).
- T011 and T012 both edit `phase-loop.ts` but at distinct call sites — could be done in either order; do them in one editing pass to keep the diff coherent.
- T013 is the smallest edit (a deletion) and depends on nothing except the file being open; do it last so the reviewer sees "hoisted-and-guarded" in the diff before "deleted-the-second-call."

**Within Phase 3**:
- T020, T021 depend on the Phase 2 code being present. T022 and T023 can run in parallel with them but are quick enough to just run serially.

## Success criteria mapping (spec + plan)

| Marker | Discharged by |
|--------|---------------|
| SC-001 (install artifacts survive to validate) | T002, verified in T020 |
| SC-002 (up-to-date branch unchanged) | T003, verified in T020 |
| SC-005 (equivalent scripted repro passes) | T002 (unit-level per clarification Q4-A) + smoke-test epic generacy-ai/tetrad-development#92 (out-of-band) |
| SC-006 (one merge per attempt) | T004, verified in T020 |
| FR-003 (unchanged path for up-to-date branches) | T003 |
| FR-006 (single atomic PR modifying phase-loop.ts) | Scope of T010–T013 + T001–T005 (one code file, one test file) |
| Q5-B (general at-most-once guard, not narrow branch removal) | T011 (implement wrap) + T005 (symmetry test) |
| Q3-A (retry is a new cycle) | T010 (block-scoped `let`) + T004 (retry test) |
| Contract invariant `M(i) ∈ {0, 1}` per iteration | T010–T013 (structure) + T001–T005 (assertions) |

---

*Generated by speckit — tasks phase for #914*
