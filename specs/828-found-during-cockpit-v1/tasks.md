# Tasks: cockpit status renders phase grouping for epic children

**Input**: Design documents from `/specs/828-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/status-envelope.json
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type & Signature Changes

- [X] T001 [US1][US2] Add `phase: string | null` field to `StatusRow` interface and extend `buildStatusRow` signature with required trailing `phase: string | null` argument in `packages/generacy/src/cli/commands/cockpit/status/row.ts` (per data-model.md §Types). Body-only change; do not update callers yet — they will fail typecheck until T003 lands, which is intentional.

## Phase 2: Core Grouping Logic

- [X] T002 [US1] Rewrite `groupRows` in `packages/generacy/src/cli/commands/cockpit/status/group.ts` per research.md §P2 and data-model.md §`groupRows`:
  - New signature: `groupRows(rows: StatusRow[], phases: ParsedPhase[], epicOwnerRepo: string): RowGroup[]`.
  - Bucket rows by `row.phase` (Map keyed by `string | null`).
  - For each `ParsedPhase` in body order: emit one `RowGroup` sorted by `${repo}#${number}` join against `ParsedPhase.refs` body order.
  - Header format (FR-003): `— <heading> —` when `heading.toLowerCase() !== token`, else `— <TOKEN-UPPER> —` (fallback for label-less phases).
  - Emit trailing `RowGroup` with header `— (no phase) —` when the `null` bucket has rows OR when `phases.length === 0` (FR-004 + FR-008 collapsed into single predicate).
  - Remove today's `(a, b) => a.number - b.number` sort (FR-009 removes this behavior entirely — do not preserve behind a flag).
  - Import `ParsedPhase` from `@generacy-ai/cockpit`.

## Phase 3: Row Emission Wiring

- [X] T003 [US1][US2] Update the row-emission loop in `packages/generacy/src/cli/commands/cockpit/status.ts` (~line 74) per research.md §P1:
  - Before the fetch loop, build `membershipByKey: Map<string, string[]>` where key = `${ref.repo}#${ref.number}`, iterating `resolved.parsed.phases` and pushing `phase.token` per membership.
  - Inside the per-issue loop, look up `memberships = membershipByKey.get(key) ?? []`. If empty, emit one row with `phase: null` (the "no phase" case). Otherwise emit one row per phase token — same `(state, sourceLabel, prNumber, checks, title, url)` for every emitted row (invariant I7).
  - Pass the phase token (or `null`) as the new trailing arg to `buildStatusRow`.
  - Replace the current `groupRows(rows, epicOwnerRepo)` call with `groupRows(rows, resolved.parsed.phases, resolved.epic.repo)`. Drop any pre-group flat sort.
  - Confirm the JSON path receives rows in phase-body order: pass `groupRows(...).flatMap(g => g.rows)` (or equivalent) into the JSON envelope so both surfaces share one ordering source of truth (research.md §P3 option A).

## Phase 4: Render / Envelope Confirmation

- [X] T004 [US2] Verify `packages/generacy/src/cli/commands/cockpit/status/render-table.ts`:
  - The table path already iterates `RowGroup[]` and prints headers — no logic change; only sanity-check that phase headers render legibly with and without color (FR-003).
  - The JSON envelope: since `StatusRow.phase` is added at T001, `phase` is automatically emitted on every row. Verify row order matches `groupRows(...).flatMap(g => g.rows)` (phase body order → within-phase `ParsedPhase.refs` order → trailing `phase: null` last) — this is invariant I6 in data-model.md.
  - No new file created; if a code change is needed here (unlikely) keep it minimal.

## Phase 5: Tests

- [X] T005 [P] [US1][US3] Rewrite / extend `packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts` per plan.md step 5:
  - **Delete** the existing "epic mode flattens rows under a single header sorted by number" case (asserts behavior removed by FR-009).
  - Add: `phase groups appear in body order; rows within each group in ParsedPhase.refs order` (FR-002 + FR-009 + AC on US1).
  - Add: `header uses full 'heading' when heading !== token; falls back to '— <TOKEN-UPPER> —' when label-less` (FR-003).
  - Add: `trailing '— (no phase) —' group appears when any StatusRow.phase is null` (FR-004).
  - Add: `phase-less epic (phases.length === 0) renders single '— (no phase) —' group and exits 0` (FR-008 + SC-004).
  - Add: `cross-phase duplicate ref renders once per phase group in the table AND emits one row per (ref × phase) membership in the JSON envelope` (FR-006).
  - Add: `every row in the --json envelope has 'phase' as string | null` (FR-005 + SC-002 assertion using `Object.prototype.hasOwnProperty` or similar).
  - Fixtures should provide a mocked `parsed.phases` with 2+ phases including one label-less phase and one cross-phase duplicate ref.

- [X] T006 [P] [US1] Update `packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts` to match new grouped-output expectations:
  - Extend integration fixtures with a `parsed.phases: ParsedPhase[]` array on the mocked resolver return value (previously only `allRefs` was needed).
  - Update stdout-snapshot / string assertions to expect phase-headed groups instead of the single `epic <owner/repo>#N` header.
  - Preserve all non-grouping assertions (state resolution, PR rollup, check rollup) — they are unchanged per FR-007.

## Phase 6: Manual Verification

- [ ] T007 [US3] Run the repro against `christrudelpw/sniplink#1` (three `### P1/P2/P3` phases, 12 children) per quickstart.md / SC-001 / SC-002:
  - `pnpm --filter @generacy-ai/generacy build && node packages/generacy/dist/cli/index.js cockpit status christrudelpw/sniplink#1` → expect ≥3 phase-headed groups matching epic body headings; visually confirm SC-001.
  - `... cockpit status --json christrudelpw/sniplink#1 | jq '.rows[] | has("phase")' | sort -u` → expect `[true]` (SC-002).
  - Diff pre/post JSON (ignoring `phase`) to confirm SC-003 (no regression to existing row fields).
  - Note: if `christrudelpw/sniplink#1` is unavailable in the test env, substitute any epic with ≥2 `### <phase>` headings.

## Dependencies & Execution Order

**Sequential chain**:
- T001 (type change) → T002 (grouping rewrite; imports the new `phase` field) → T003 (wire status.ts; calls updated groupRows with the new phase arg) → T004 (render/envelope sanity check).

**Parallel opportunities**:
- **T005 and T006 [P]** can run in parallel — different test files, no shared symbols beyond re-exported types. Both depend on T001–T004 being complete (the code under test must have the new signatures).

**Manual verification (T007)** runs last and depends on the full T001–T006 chain.

**Rationale for ordering**: T001 changes types that T002 and T003 consume; running T002/T003 before T001 introduces mid-task typecheck failures that mask real errors. Bundling T002/T003 after T001 keeps each task independently green.
