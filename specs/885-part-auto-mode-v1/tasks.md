# Tasks: Auto mode phase-complete / epic-complete synthetic events

**Input**: Design documents from `/specs/885-part-auto-mode-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/aggregate-events.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: This feature has one user story — the auto-mode consumer — so all tasks share the implicit `[US1]` scope. Story tag omitted for brevity.

## Phase 1: Types & Schema

- [ ] T001 [P] Create `packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts` with `PhaseCompleteEvent` / `EpicCompleteEvent` interfaces and `AggregateEvent` union, exactly as specified in `data-model.md` §Payload types.
- [ ] T002 [P] In the same `aggregate-emit.ts`, add `PhaseCompleteEventSchema`, `EpicCompleteEventSchema`, and the `AggregateEventSchema` discriminated union (per `data-model.md` §Zod schemas). Include `AggregateEventValidated` type alias. Use the existing `RepoRegex` pattern `^[^/]+\/[^/]+$`.
- [ ] T003 In `aggregate-emit.ts`, implement `emitAggregate(event: AggregateEvent, opts?: { skipValidate?: boolean }): void` that (a) dev-time validates with `AggregateEventSchema.parse` unless `skipValidate` is set, (b) writes a single `JSON.stringify(event) + '\n'` line to `process.stdout`. Mirror the shape of `emit()` in `emit.ts` — do **not** widen `CockpitEventSchema`.
- [ ] T004 Create `packages/generacy/src/cli/commands/cockpit/watch/aggregate.ts` with `AggregateState` interface + `initialAggregateState()` factory (per `data-model.md` §Aggregate state).

## Phase 2: Pure Aggregate Computation

- [ ] T005 In `aggregate.ts`, define the `AggregateComputeInput` / `AggregateComputeResult` types from `data-model.md` §Pure aggregate computation.
- [ ] T006 In `aggregate.ts`, implement the completeness predicates `isPhaseComplete(phase, curr)` and `isEpicComplete(parsed, curr)` from `data-model.md` §Completeness predicates. `isPhaseComplete` returns **false** for `refs.length === 0` (emission gate); `isEpicComplete` returns false when `allRefs.length === 0`. Use `snapshotKey(repo, kind, number)` lookups that check both `'issue'` and `'pr'` kinds. `state === 'CLOSED'` regardless of `stateReason` (D8, #873).
- [ ] T007 In `aggregate.ts`, implement `computeAggregateEvents(input): AggregateComputeResult`. Iteration rules:
  1. For each `phase` in `input.parsed.phases` **in body order**: compute `nowComplete = isPhaseComplete(phase, curr)`.
     - `nowComplete && !prev.seenCompletePhases.has(phase.token)` → emit `phase-complete` with `phase: phase.heading` (not token) and `initial: true` iff `input.initial === true`; add `phase.token` to `nextState.seenCompletePhases`.
     - `!nowComplete && prev.seenCompletePhases.has(phase.token)` → regression: remove `phase.token` from `nextState.seenCompletePhases`, emit nothing.
     - Otherwise: no event, state unchanged for that phase.
  2. After the phase loop, compute `epicNow = isEpicComplete(parsed, curr)`.
     - `epicNow && !prev.epicComplete` → append `epic-complete` (`initial: true` iff `input.initial === true`), set `nextState.epicComplete = true`.
     - `!epicNow && prev.epicComplete` → regression: set `nextState.epicComplete = false`, emit nothing.
  3. Return `{ events, nextState }`. Events are already sorted (phase-complete in body order, then epic-complete last).
- [ ] T008 Verify `computeAggregateEvents` is pure: no `process.stdout` / `process.stderr` writes, no `new Date()` calls (timestamps come from `input.now()`), no mutation of `input.prevState` (build `nextState` as a fresh `{ seenCompletePhases: new Set(prev.seenCompletePhases), epicComplete: prev.epicComplete }` and mutate that).

## Phase 3: Wire into `watch.ts`

- [ ] T009 In `packages/generacy/src/cli/commands/cockpit/watch.ts`, add the `--exit-on-epic-complete` boolean CLI flag to the commander subcommand definition. Default false. Thread it into the poll shell context.
- [ ] T010 In `watch.ts`, allocate aggregate state at the top of the poll loop: `let aggState = initialAggregateState()`. Track `let firstPoll = true` alongside the existing `prev: SnapshotMap` variable.
- [ ] T011 In `watch.ts`, at watch startup (before entering the poll loop), iterate `parsed.phases` and for each phase with `refs.length === 0` write one stderr line: `cockpit watch: phase "<heading>" has no issue refs; treated as complete\n`. Use `process.stderr.write`.
- [ ] T012 In `watch.ts`, inside the poll body, after `runOnePoll` returns and per-issue events have been emitted via `emit()`, call `computeAggregateEvents({ curr, parsed, epicRepo, epicNumber, prevState: aggState, initial: firstPoll, now: () => new Date().toISOString() })`. Emit each returned event with `emitAggregate(evt)`. Then `aggState = result.nextState`. Set `firstPoll = false` after the first poll's aggregate emission completes.
- [ ] T013 In `watch.ts`, after `emitAggregate` for `epic-complete`: if `--exit-on-epic-complete` was passed AND the just-emitted result contained an `epic-complete` event, await stdout drain (`await new Promise<void>(resolve => { process.stdout.write('', () => resolve()); })`) then `process.exit(0)`. Do **not** exit if the event was `phase-complete` only. Ensure exit is the last statement — no further per-issue events from a later poll may interleave.
- [ ] T014 Confirm end-to-end emit ordering in `watch.ts` matches the contract: (1) all per-issue events in existing order, (2) all `phase-complete` in `parsed.phases` body order, (3) `epic-complete` last if firing. Ordering is enforced by the sequence of `emit()` then `emitAggregate()` calls — no code path may reorder them.

## Phase 4: Tests

- [ ] T015 [P] Create `packages/generacy/src/cli/commands/cockpit/__tests__/watch.aggregate-emit.test.ts`. Test cases (all against `AggregateEventSchema`):
  - Valid `phase-complete` with all required fields → parses.
  - Valid `phase-complete` with `initial: true` → parses.
  - `phase-complete` with `phase: ""` → rejects.
  - `phase-complete` missing `phase` → rejects (schema requires it).
  - `epic-complete` with a `phase` field → rejects (union discriminator).
  - `epicRepo: "not-a-repo"` → rejects (regex).
  - `epicNumber: 0` / `-1` → rejects (positive int).
  - `ts: "2026-07-09"` (date only) → rejects (`z.datetime()` requires time).
  - `initial: false` → rejects (must be literal `true` or absent).
- [ ] T016 [P] Create `packages/generacy/src/cli/commands/cockpit/__tests__/watch.aggregate.test.ts`. Unit-test `computeAggregateEvents` against fixture `SnapshotMap` + `ParsedEpicBody` values. Cover **each** spec test case:
  - **Last-merge-in-phase fires `phase-complete` exactly once**: two-phase epic, close last open ref of P1 in a poll → single `phase-complete{ phase: "P1 — …" }`; running compute again with unchanged `curr` and updated `prevState` returns `events: []`.
  - **Mid-phase merge fires nothing**: close one of several refs in P1 → `events: []`.
  - **Reopen → regress → re-complete fires twice**: after completing P1 (first emit), transition one ref back to OPEN (`nextState.seenCompletePhases` no longer contains the token, no event emitted), then close it again → `phase-complete` fires again with a *different* `ts`.
  - **No-phase issues excluded from `phase-complete`, included in `epic-complete`**: epic with P1 refs + `(no phase)` refs. Closing all P1 refs → `phase-complete` for P1. Closing the remaining `(no phase)` refs → `epic-complete` fires; no `phase-complete` for the `(no phase)` bucket.
  - **Startup sweep marks `initial: true`**: `input.initial = true`, `prevState = initialAggregateState()`, `curr` already fully closed for P1 → `phase-complete` with `initial: true`; entire epic complete → `epic-complete` with `initial: true`.
  - **Empty phase (heading with no refs) never emits `phase-complete`, still allows `epic-complete`**: two-phase epic where P2 has `refs.length === 0`. Close all P1 refs → only P1's `phase-complete` fires and `epic-complete` fires (P2 doesn't block); P2 never appears in any event.
  - **Phase-less epic** (`parsed.phases.length === 0`): closing all `allRefs` → single `epic-complete`; zero `phase-complete` events.
  - **Multiple simultaneous transitions ordered correctly**: `curr` closes the last refs of P1, P2, and the last `(no phase)` ref in one poll → returned `events` array is `[P1 phase-complete, P2 phase-complete, epic-complete]` in that exact index order.
  - **Payload field discipline**: assert emitted events contain `epicRepo` and `epicNumber` and do **not** contain `closedRefs`, `totalCount`, `suggestion`, `repo`, `kind`, `number`, `url`, `labels`, `sourceLabel`, `from`, `to`, `event` keys.
- [ ] T017 Extend `packages/generacy/src/cli/commands/cockpit/__tests__/watch-subprocess.integration.test.ts` with two new cases:
  - **`--exit-on-epic-complete` exits 0 after final flush**: spawn watch as a subprocess against a fixture epic already fully closed; assert (a) exit code 0, (b) last non-empty line of stdout is `epic-complete`, (c) no output arrives after `epic-complete` (test by buffering all stdout until child exits).
  - **Without `--exit-on-epic-complete`, watch keeps polling after `epic-complete`**: same fixture, no flag; assert the process is still running after ~2 poll cycles (kill it manually at end of test).
- [ ] T018 Verify all new / extended tests pass: `pnpm --filter @generacy-ai/generacy test -- watch.aggregate watch.aggregate-emit watch-subprocess.integration`.

## Phase 5: Docs

- [ ] T019 Extend `packages/generacy/README.md` with a `cockpit watch — aggregate events` section documenting: the two event shapes, the `--exit-on-epic-complete` flag, the ordering guarantee, the empty-phase / phase-less-epic edge cases, and the `initial: true` startup-sweep flag. Reuse phrasing from `contracts/aggregate-events.md` — the README is the wire contract per the plan's self-contained-commands principle. Do **not** reference `specs/885-part-auto-mode-v1/` from the README (specs are ephemeral).

## Dependencies & Execution Order

**Sequential chains**:

- T001 → T002 → T003 (all in `aggregate-emit.ts`; write, then schema, then helper — same file, must land in this order).
- T004 → T005 → T006 → T007 → T008 (all in `aggregate.ts`; types before compute before purity check).
- Phase 3 (T009–T014) must wait on **both** T003 (needs `emitAggregate`) and T007 (needs `computeAggregateEvents`).
- T017 depends on T009–T013 (subprocess wiring must exist).
- T018 runs after T015, T016, T017.
- T019 can start any time after T014 (contract is stable once wired).

**Parallel opportunities** (different files, no data dependencies):

- T001 and T004 can be started in parallel — different files (`aggregate-emit.ts` vs `aggregate.ts`).
- T015 and T016 can be authored in parallel — different test files, and T015 only needs `AggregateEventSchema` (T002) while T016 needs `computeAggregateEvents` (T007). Once both dependencies land they may proceed concurrently.
- T019 (README) is fully parallel with Phase 4 tests.

**Recommended sequence for a single implementer**:

1. T001 → T002 → T003 (schema + emitter).
2. T004 → T005 → T006 → T007 → T008 (pure compute).
3. T015 in parallel with T016 (unit tests) — landing tests before wiring gives an executable spec of the pure function.
4. T009 → T010 → T011 → T012 → T013 → T014 (wire into watch.ts).
5. T017 → T018 (integration + full test sweep).
6. T019 (README).

---

*Generated by speckit /tasks — standard mode (fine-grained tasks). 19 tasks across 5 phases. Suggested next step: `/speckit:implement` to begin execution.*
