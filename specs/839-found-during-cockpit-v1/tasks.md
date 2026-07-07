# Tasks: Cockpit watch — startup sweep for actionable states

**Input**: Design documents from `/specs/839-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cockpit-event.schema.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = queue→watch shows pending, US2 = restart re-surfaces, US3 = non-actionable stays silent)

All user stories are satisfied by the same code change (a first-poll sweep in `computeTransitions`), so tasks are grouped by implementation phase rather than by story.

## Phase 1: Schema + Actionable Predicate (Foundation)

- [ ] T001 [P] [US1, US3] Extend `CockpitEventSchema` in `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`: add `initial: z.literal(true).optional()` per contracts/cockpit-event.schema.md. No other field changes. Also extend the `CockpitEvent` TypeScript interface (currently exported from `diff.ts` per data-model.md §Extended Type) with `initial?: true`.

- [ ] T002 [P] [US1, US3] Create new file `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` per plan.md §Design Detail: exports `ACTIONABLE_EXACT_LABELS` (`Set<string>` = `{'completed:validate','needs:intervention','agent:error'}`), private `ACTIONABLE_PREFIXES` (`['waiting-for:','failed:']`), `isActionableLabel(label)`, and `isActionableSnapshot(snap)` (labels-first + `snap.kind === 'pr' && snap.checksRollup === 'failure'`). Include the WHY comment on `isActionableSnapshot` explaining raw-labels vs classified-state (FR-011 / Q2).

- [ ] T003 [P] [US1, US3] Create new test file `packages/generacy/src/cli/commands/cockpit/__tests__/watch.actionable.test.ts` covering: (a) every FR-002 label pattern positive — `waiting-for:clarification`, `waiting-for:review`, `completed:validate`, `failed:test`, `failed:build`, `needs:intervention`, `agent:error`; (b) negatives — `completed:specify`, `completed:plan`, `phase:plan`, `agent:in-progress`, `type:bug`, empty string; (c) `isActionableSnapshot` — PR with `checksRollup:'failure'` and no `failed:*` label returns true; issue with `checksRollup:'failure'` (impossible in prod, but guard the branch) returns false; snapshot with an actionable label and non-failing rollup returns true.

- [ ] T004 [P] [US1, US3] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/watch.emit.test.ts`: assert `CockpitEventSchema.parse({...base, initial: true})` succeeds; assert `parse({...base, initial: false})` throws; assert `parse({...base, initial: 'yes'})` and `initial: 1` throw; add one explicit test that `parse(base)` (with `initial` absent) succeeds. Regression guard for contract §Test Contracts / SC-005.

## Phase 2: First-Poll Sweep Wired Into `computeTransitions`

<!-- Phase 2 depends on Phase 1: needs actionable.ts + CockpitEvent.initial field to exist. -->

- [ ] T005 [US1, US2, US3] Amend `packages/generacy/src/cli/commands/cockpit/__tests__/watch.diff.test.ts` per plan.md §Files Touched. Rename `emits nothing on first poll (prev empty)` → `emits nothing on first poll when no snapshot is actionable` and switch inputs to non-actionable labels (guards SC-002 / US3). Add the following new tests:
  - Actionable label at first poll → 1 event with `initial: true`, `event: 'label-change'`, `from: null`, `to === classified.state`, `sourceLabel === classified.sourceLabel` (SC-001 / US1).
  - Mixed actionable + non-actionable at first poll → only actionable emitted.
  - Issue carrying `completed:specify` AND `waiting-for:clarification` → emits one initial line (SC-007 / Q2 regression).
  - PR with `checksRollup: 'failure'` and no `failed:*` label → emits one initial line (SC-009 / Q5 regression).
  - Deterministic sort by `(repo, kind, number)` across mixed input — assert byte-stable ordering (SC-008).
  - Polls 2..N — `initial` field is ABSENT (not `false`) on every returned event (SC-005 / FR-004). Use `expect(event).not.toHaveProperty('initial')`.

- [ ] T006 [US1, US2, US3] Implement the sweep in `packages/generacy/src/cli/commands/cockpit/watch/diff.ts`:
  - Replace `if (prev.size === 0) return [];` at line ~134 with `if (prev.size === 0) return computeInitialSweep(curr, ts);`.
  - Add `computeInitialSweep(curr, ts)` per plan.md §Design Detail: sort `[...curr.keys()].sort()`, filter via `isActionableSnapshot`, emit one `makeEvent` per hit with `event: 'label-change'`, `from: null`, `to: snap.classified.state`, `sourceLabel: snap.classified.sourceLabel`, and `{ initial: true }`.
  - Extend `makeEvent` (or its options bag) with an optional `initial?: true` param. When present-and-true, set on returned event; when absent, do not add the field (never emit `initial: false`).
  - Import `isActionableSnapshot` from `./actionable.js`.
  - Verify polls 2..N callsites are unchanged — no test regression on transition semantics (SC-004).

## Phase 3: Verification

<!-- Phase 3 depends on Phase 2 landing. -->

- [ ] T007 [P] [US1, US2, US3] Run the full watcher test suite from quickstart.md: `pnpm --filter @generacy-ai/generacy test -- watch`. All existing tests pass unmodified (except the renamed baseline test in T005), and the new tests from T003–T005 pass. Confirms SC-004 (no regressions in existing transition semantics).

- [ ] T008 [P] [US1, US3] Grep-based SC-006 guard per quickstart.md §Grep-based SC-006 check: `grep -rn "'completed:validate'" packages/generacy/src` returns only `actionable.ts` and its test file; `grep -rn "'waiting-for:'" packages/generacy/src/cli/commands/cockpit/watch/` returns only `actionable.ts`. If any other file mentions these strings, delete the duplication.

- [ ] T009 [US1] Type-check + build: `pnpm --filter @generacy-ai/generacy build`. Confirms `CockpitEvent.initial?: true` propagates through all callers with no type errors, and that no downstream consumer branches on `initial === false` (which would now be a compile error against the literal type).

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 (schema + predicate) → Phase 2 (sweep wiring) → Phase 3 (verification).

**Within Phase 1** — fully parallel:
- T001 (emit.ts schema + CockpitEvent field) ‖ T002 (actionable.ts module) ‖ T003 (watch.actionable.test.ts) ‖ T004 (watch.emit.test.ts).
- No file conflicts; T003 tests T002, T004 tests T001, but neither test file exists yet so no test-suite race.

**Within Phase 2** — sequential:
- T005 (write regression tests for `diff.ts`) → T006 (implement sweep in `diff.ts`). Same file surface (`watch.diff.test.ts` + `diff.ts`); the test file lands first (red), then T006 turns it green.
- T005 imports must reference the `initial` field on `CockpitEvent` and `isActionableSnapshot`, so Phase 1 must be complete before starting T005.

**Within Phase 3** — parallel:
- T007 (test suite), T008 (grep guards), T009 (build) all operate on the final state and can run concurrently.

**Parallel opportunities**:
- All four Phase 1 tasks (T001–T004) can run in one batch.
- All three Phase 3 tasks (T007–T009) can run in one batch.

**Total**: 9 tasks. Phases: 4 in Phase 1, 2 in Phase 2, 3 in Phase 3.
