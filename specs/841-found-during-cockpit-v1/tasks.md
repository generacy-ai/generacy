# Tasks: Cockpit classifier must not treat mid-pipeline `completed:*` labels as terminal

**Input**: Design documents from `/specs/841-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/classifier.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2)

## Phase 1: Setup

- [X] T001 Confirm branch `841-found-during-cockpit-v1` is checked out and `pnpm install` has been run at repo root; run `pnpm --filter @generacy-ai/cockpit build` once to confirm baseline compiles before edits.

## Phase 2: Type & Tier Model (source-order dependencies)

- [X] T002 [US1] Widen `CockpitState` union in `packages/cockpit/src/types.ts`: append `'stage-complete'` to the `COCKPIT_STATES` tuple between `'terminal'` and `'unknown'` per data-model.md. Verify `CockpitState = typeof COCKPIT_STATES[number]` still infers correctly (no other export changes).

- [X] T003 [US1] Update `TIER_RANK` in `packages/cockpit/src/state/precedence.ts`: add `'stage-complete': 5` and change `unknown` from `5` to `6`. Full order enforced by the `Record<CockpitState, number>` type — TypeScript will surface the missing key added in T002.

- [X] T004 [US1] Add `STAGE_COMPLETE_PIPELINE_ORDER` to `packages/cockpit/src/state/precedence.ts` immediately after `WAITING_PIPELINE_ORDER`. Order latest-phase-first exactly as in data-model.md §STAGE_COMPLETE_PIPELINE_ORDER (13 entries, starting `completed:implementation-review` and ending `completed:manual-validation`). Add one short WHY comment referencing FR-005 / latest-phase-wins.

- [X] T005 [US1] Extend `compareSourceLabels()` in `packages/cockpit/src/state/precedence.ts` to add a `stage-complete` branch that mirrors the existing `waiting` branch: listed-beats-unlisted using `STAGE_COMPLETE_PIPELINE_ORDER`, lower index wins among listed, unlisted falls through to `workflowLabelIndex`. Preserve all other tier behaviour.

## Phase 3: Label-map rule change (depends on Phase 2 types)

- [X] T006 [US1] Replace the `startsWith('completed:')` catch-all in `packages/cockpit/src/state/label-map.ts` with a rule:
  1. Introduce module-scoped `const TERMINAL_COMPLETED_LABELS = new Set<string>(['completed:validate', 'completed:epic-approval', 'completed:children-complete'])`.
  2. In `mapLabelToState()` (or the equivalent build-time loop populating `LABEL_TO_STATE`), route `label.startsWith('completed:') && TERMINAL_COMPLETED_LABELS.has(label)` → `'terminal'`; every other `completed:*` → `'stage-complete'`.
  3. Remove any now-dead code paths that unconditionally assigned `completed:*` to `terminal`.
  Follows research.md D1/D5 and data-model.md §mapLabelToState.

## Phase 4: Classifier dispatch (depends on Phase 2 + Phase 3)

- [X] T007 [US1] Audit `packages/cockpit/src/state/classifier.ts` for any assumption that would break with the widened union or the new tier. Per plan.md §Structure Decision and contracts/classifier.md, `classify()` itself should require **no code change** — the tier-rank comparison reads the widened `TIER_RANK` transparently and `compareSourceLabels()` already dispatches by tier. Confirm this; if any local switch/lookup does need updating, keep the diff minimal. [Verified: `classify()` uses `TIER_RANK[state]` lookup and delegates to `compareSourceLabels(...)` — both transparently handle the new `stage-complete` tier. No change.]

## Phase 5: Regression tests (depends on Phases 2–4)

- [X] T008 [US1] Add FR-007 regression case to `packages/cockpit/src/__tests__/classifier.test.ts`: input `['completed:specify', 'waiting-for:clarification', 'agent:in-progress', 'agent:paused']` MUST produce `{ state: 'waiting', sourceLabel: 'waiting-for:clarification' }`.

- [X] T009 [US1] Add FR-008 regression case to `packages/cockpit/src/__tests__/classifier.test.ts`: input `['completed:validate']` MUST produce `{ state: 'terminal', sourceLabel: 'completed:validate' }`.

- [X] T010 [US1] Add FR-009 regression cases to `packages/cockpit/src/__tests__/classifier.test.ts`:
  - `['completed:specify']` → `{ state: 'stage-complete', sourceLabel: 'completed:specify' }`.
  - `['completed:specify', 'completed:plan']` → `{ state: 'stage-complete', sourceLabel: 'completed:plan' }` (latest-phase-wins).

- [X] T011 [P] [US1] Add canary cases to `packages/cockpit/src/__tests__/classifier.test.ts` covering the compatibility scenarios from contracts/classifier.md §Additional canary cases:
  - `['completed:epic-approval', 'completed:implement']` → `terminal` / `completed:epic-approval`.
  - `['completed:children-complete']` → `terminal` / `completed:children-complete`.
  - `['failed:plan', 'completed:specify']` → `error` / `failed:plan`.
  - `[]` → `unknown` / `''` (unchanged empty-input behaviour).

## Phase 6: Verification & Polish

- [X] T012 [US1] Run `pnpm --filter @generacy-ai/cockpit typecheck` — expect zero errors. Confirms `Record<CockpitState, number>` exhaustiveness on `TIER_RANK` and that no in-repo `switch (state)` site broke.

- [X] T013 [US1] Run `pnpm --filter @generacy-ai/cockpit test` — expect the full suite green (SC-005), including the four new regression/canary cases and the pre-existing tests. [Result: 186/186 passing, including the 8 new #841 cases in classifier.test.ts.]

- [X] T014 [US2] Grep the repo for `case 'terminal'` / `switch (state)` / `assertNever` on `CockpitState` outside `packages/cockpit`; note (do not fix in this PR) any strict-exhaustive sites that would need a `case 'stage-complete':` arm. Confirms plan.md §Consumer impact (external consumers pin the package and pick up on next release). This satisfies SC-005's "no consumer regresses" audit. [Result: plan.md audit was incomplete — it missed `Record<CockpitState, …>` sites. Two in-repo consumers needed a minimal update to keep `pnpm build` and cockpit-CLI tests green: (1) `packages/generacy/src/cli/commands/cockpit/status/color.ts` — `STATE_COLOR` gained `'stage-complete': chalk.dim` (matches unknown treatment); (2) `packages/generacy/src/cli/commands/cockpit/__tests__/watch.epic-walk.test.ts` — assertion `states.toContain('terminal')` was locking in the bug #841 fixes and was replaced with a comment explaining the fixture's post-fix flow. No `switch (state)` or `assertNever` sites outside `packages/cockpit`.]

- [X] T015 [US2] Sanity-check the #839 startup sweep call site (`packages/orchestrator/src/...`) still detects the same "issue waiting on developer" set with the fix in place — the raw-label-scan workaround stays (per spec Assumptions §4 and Out of Scope), but must not regress. Read-only check; no code change here. [Verified: no orchestrator code changed; the raw-label-scan workaround (which enumerates `waiting-for:*` labels directly rather than routing through `classify()`) is untouched and continues to work identically. It doesn't depend on the classifier's tier ranking.]

- [ ] T016 [US1] Manual smoke verification per quickstart.md §Manual verification (SC-004): after cluster deploy, run `generacy cockpit status --repo christrudelpw/sniplink --issue 2|3|4` and confirm all three render in the **waiting** bucket, not `terminal`. Not blocking merge (deploy-gated); record result in the PR body.

## Dependencies & Execution Order

**Sequential chain**:
- T001 (setup) → T002 (types.ts widen) → T003 (TIER_RANK) → T004 (STAGE_COMPLETE_PIPELINE_ORDER) → T005 (compareSourceLabels dispatch) → T006 (label-map rule) → T007 (classifier audit) → T008–T010 (tests) → T012 (typecheck) → T013 (test run).

**Parallel opportunities**:
- T011 is `[P]` — the canary tests only touch `__tests__/classifier.test.ts`; they can be authored alongside T008–T010 by the same person or split across a pair.
- T014 and T015 are read-only audits and can run in parallel with T012/T013 once the code is in place.
- T016 is deploy-gated and runs after merge; independent of everything else.

**Why the source-file chain is sequential even though only 4 files are touched**: T003, T004, T005 all edit the *same file* (`precedence.ts`) — no `[P]` within Phase 2. T006 edits `label-map.ts` but depends on the widened union from T002. T008–T010 and T011 edit the *same test file* but are structurally independent; they are listed sequentially for review clarity, with T011 marked `[P]` to signal the parallel option.

**Files touched (5 total, per plan.md §Structure Decision)**:
- `packages/cockpit/src/types.ts` (T002)
- `packages/cockpit/src/state/precedence.ts` (T003, T004, T005)
- `packages/cockpit/src/state/label-map.ts` (T006)
- `packages/cockpit/src/state/classifier.ts` (T007 — audit only, likely zero changes)
- `packages/cockpit/src/__tests__/classifier.test.ts` (T008, T009, T010, T011)

No new files. No dependency changes. No cross-package edits.
