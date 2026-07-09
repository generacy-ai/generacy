# Tasks: Uniform `type` discriminator on `cockpit watch` NDJSON stream

**Input**: Design documents from `/specs/887-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Interface (foundational)

- [X] T001 [US1] Extend `CockpitEventSchema` with `type: z.literal('issue-transition')` in `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` (per data-model.md §IssueTransitionEvent — add the literal as the first schema field, no other changes to the object).
- [X] T002 [P] [US1] Add required `type: 'issue-transition'` field to `CockpitEvent` interface and set it in `makeEvent()` in `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` (closes the TypeScript-side hole; forces internal construction sites to populate `type`).

## Phase 2: Emit-Boundary Stamping (single choke point)

- [X] T003 [US1] Stamp `type: 'issue-transition'` inside `emit()` in `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` **before** the `skipValidate` branch. Unconditionally overwrite any pre-existing `type` on the payload (FR-004 defense-in-depth). Depends on T001.
- [X] T004 [P] [US1] Stamp `type` inside `emitAggregate()` in `packages/generacy/src/cli/commands/cockpit/watch/aggregate-emit.ts` **before** the `skipValidate` branch — preserve the payload's declared `type`, else stamp `'phase-complete'` if `phase` is present, else `'epic-complete'` (symmetric defense-in-depth per plan.md §Implementation Sequence step 3).

## Phase 3: Discriminated Union & Public API

- [X] T005 [US1] Create new file `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts` exporting `CockpitStreamEventSchema = z.discriminatedUnion('type', [CockpitEventSchema, PhaseCompleteEventSchema, EpicCompleteEventSchema])` and `type CockpitStreamEvent = z.infer<...>` (imports per data-model.md §CockpitStreamEvent). Depends on T001.
- [X] T006 [US1] Re-export `CockpitStreamEventSchema` (value) and `CockpitStreamEvent` (type) from `packages/generacy/src/index.ts` so external consumers import from `@generacy-ai/generacy` (FR-003 package-root surface). Depends on T005.

## Phase 4: Documentation

- [X] T007 [P] [US3] Replace `packages/generacy/README.md` lines 205–259 with the canonical stream-grammar table + per-`type` behavioral subsections (`issue-transition`, `phase-complete`, `epic-complete`) + shared "Startup sweep" subsection per `contracts/readme-grammar-table.md`. Table MUST list `initial: true` on all three `type` values (Q4-A). Retain existing "Ordering within a poll cycle" and "Payload discipline" prose.

## Phase 5: Regression Tests

- [X] T008 [US1/US2] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/watch.emit.test.ts` with three new assertions: (a) `emit()` stamps `type: 'issue-transition'` on a payload constructed without `type`; (b) `emit()` overwrites a bogus `type` value; (c) `skipValidate: true` still yields a `type`-stamped stdout line. Depends on T003.
- [X] T009 [US1/US2/US3] Create `packages/generacy/src/cli/commands/cockpit/__tests__/watch.stream-event.test.ts` with four `describe` blocks: (1) **Fixture set** — parametrized fixtures covering every `event` enum value (`label-change`, `issue-closed`, `pr-merged`, `pr-closed`, `pr-checks`), both aggregate `type` values, and `initial: true` variants for all three; each asserted to parse against `CockpitStreamEventSchema` (FR-009 path-exhaustive). (2) **Lint-style caller enumeration** — glob `packages/generacy/src/cli/commands/cockpit/**/*.ts` excluding `__tests__/**`, regex-match `\bemit\(|\bemitAggregate\(`, assert enclosing file set matches a pinned allow-list; fail-closed on new emit paths (FR-009 static guard). (3) **README drift check** — parse README stream-grammar table, extract `type` set, assert equality with `CockpitStreamEventSchema._def.options` discriminator values (FR-008, SC-003). (4) **Back-compat fixture stream** — assert dispatching on `type` sees 100% of lines AND filtering by `event` still sees every per-issue line unchanged (FR-010, SC-004). Depends on T005, T007, T008.

## Phase 6: Verification

- [X] T010 Run `pnpm --filter @generacy-ai/generacy test` and `pnpm --filter @generacy-ai/generacy typecheck` from repo root; confirm all new + existing tests pass and no TS errors. Manually smoke-test `pnpm generacy cockpit watch <fixture-ref>` and grep the output with `grep '"type"'` to confirm zero-drop invariant (SC-001).

## Dependencies & Execution Order

**Sequential chain (blocking)**:
- T001 → T003 → T005 → T006 → T009 → T010
- T003 → T008 → T009

**Parallel opportunities**:
- **T002 || T001**: `diff.ts` (interface) and `emit.ts` (Zod schema) are independent files; both are safe to touch concurrently.
- **T004 || T003**: `aggregate-emit.ts` stamping is independent of `emit.ts` stamping.
- **T007 || Phase 1/2/3**: README rewrite touches only `README.md` — safe to run in parallel with the code changes; T009's README drift check is the joining point.

**Critical path**: T001 → T003 → T005 → T006 → T009 → T010.

**Story coverage**:
- **US1** (dispatch on `type` sees 100%): T001, T003, T005, T006, T009 (blocks 1 & 4).
- **US2** (legacy `event` consumers unaffected): T008, T009 (block 4).
- **US3** (contributors find the contract in one place): T007, T009 (block 3).

**Suggested next step**: `/speckit:implement` to begin execution.
