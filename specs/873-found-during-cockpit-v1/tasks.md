# Tasks: Closed-issue dominance in cockpit `watch` + `status` classifier (#873)

**Input**: Design documents from `/specs/873-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, data-model.md, research.md, contracts/is-done-snapshot.md, contracts/status-envelope.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: `[US1]` — the sole story: fix closed children misclassified as actionable merge candidates

## Phase 1: Data-Plane Type Extensions (foundational — everything else depends on these)

- [X] T001 [US1] Extend `Issue` in `packages/cockpit/src/gh/wrapper.ts` (interface at :7-16): add required `stateReason: 'COMPLETED' | 'NOT_PLANNED' | null`. Extend `IssueRawSchema` (:260) with `stateReason: z.string().nullable().optional()`. Extend `--json` field lists in `listIssues()` (:525) and `getIssue()` (:545) to include `stateReason`. Update both mappers to normalize `'COMPLETED'`/`'NOT_PLANNED'` verbatim, coerce any other string (and `undefined`) to `null`.
- [X] T002 [US1] Extend `IssueSnapshot` and `PrSnapshot` in `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` (:9-29): add `stateReason: 'COMPLETED' | 'NOT_PLANNED' | null` to both. Update `buildIssueSnapshot()` and `buildPrSnapshot()` to pass `issue.stateReason` through verbatim (no transformation). `PrSnapshot.stateReason` will always resolve `null` in practice — included for shape symmetry.
- [X] T003 [US1] Extend `StatusRow` in `packages/generacy/src/cli/commands/cockpit/status/row.ts` (:4-15): add `issueState: 'OPEN' | 'CLOSED'` and `stateReason: 'COMPLETED' | 'NOT_PLANNED' | null`. Update `buildStatusRow()` signature to accept the extended `Issue` and populate `issueState = issue.state`, `stateReason = issue.stateReason`. Do NOT add a derived `done: boolean` (Q2-A rejects the drift surface). Do NOT touch `CockpitState` enum (Q2-C rejected).
- [X] T004 [US1] Thread `issue.stateReason` through the call site in `packages/generacy/src/cli/commands/cockpit/status.ts` (`runStatus`) — pass it into `buildStatusRow()` calls per T003's new signature.

## Phase 2: Shared Predicate — the single invariant surface

- [X] T005 [US1] Create `packages/generacy/src/cli/commands/cockpit/shared/is-done-snapshot.ts` exporting `isDoneSnapshot(snap: Snapshot): boolean`. Body is a one-liner: `return snap.state === 'CLOSED';`. JSDoc MUST carry the invariant text verbatim per `contracts/is-done-snapshot.md`: *"Issue `state: closed` dominates any label-derived actionability tier."* Include the caveat that the predicate reads `snap.state`, NOT `snap.classified.state` (Decision 3 in research.md — the classified `terminal` tier is exactly the label residue this fix stops trusting).
- [X] T006 [P] [US1] Create co-located tests at `packages/generacy/src/cli/commands/cockpit/shared/__tests__/is-done-snapshot.test.ts` covering the eight cases from `contracts/is-done-snapshot.md` §Test surface: open + no labels → false, open + `completed:validate` → false, closed + no labels → true, closed + `completed:validate` → true (the #873 regression case), closed + `stateReason: 'COMPLETED'` → true, closed + `stateReason: 'NOT_PLANNED'` → true, PR open → false, PR closed/merged → true.

## Phase 3: Watch Integration

- [X] T007 [US1] Modify `isActionableSnapshot()` in `packages/generacy/src/cli/commands/cockpit/watch/actionable.ts` (:22-26): add `if (isDoneSnapshot(snap)) return false;` as the FIRST line of the function body. All existing label + checks-rollup gates remain unchanged and unreordered. Import `isDoneSnapshot` from `../shared/is-done-snapshot.js`. `computeInitialSweep` in `watch/diff.ts` inherits the fix transitively — no direct change there.
- [X] T008 [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/watch.actionable.test.ts`: add regression case `{ state: 'CLOSED', labels: ['completed:validate'] }` → `false` (#873); add baseline preservation case `{ state: 'OPEN', labels: ['completed:validate'] }` → `true` (unchanged).
- [X] T009 [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/watch.diff.test.ts`: (a) startup-sweep silence — a first-poll `curr` map containing a `CLOSED` snapshot with `completed:validate` produces zero events from `computeInitialSweep`; (b) live open→closed transition emits exactly one `issue-closed` event with `to: 'terminal'` and no additional label-change event derived from the same tick.

## Phase 4: Status Integration

- [X] T010 [US1] Extend `Colorizer` interface in `packages/generacy/src/cli/commands/cockpit/status/color.ts`: add `doneMerged(text: string): string` and `doneNotPlanned(text: string): string`. `identityColorizer` returns text unchanged for both. `chalkColorizer` uses `chalk.green` for `doneMerged` and `chalk.gray` for `doneNotPlanned` (dim over red per Decision 4 — decided-not-done work is not an error).
- [X] T011 [US1] Modify `fmtRow()` in `packages/generacy/src/cli/commands/cockpit/status/render-table.ts` (:18-28) per `data-model.md` pseudo-branch: when `row.issueState === 'CLOSED'` and `row.stateReason === 'NOT_PLANNED'`, render `✗ closed` + `(not planned)` via `doneNotPlanned`; when `CLOSED` and `stateReason === 'COMPLETED'` OR `null` (defensive default), render `✓ merged` + `merged/closed` via `doneMerged`; when `OPEN`, render existing `row.state` + `row.sourceLabel` unchanged via `colorizer.state`. Add JSDoc `@see isDoneSnapshot` cross-reference on `fmtRow` (grep-link the invariant). Do NOT change `group.ts` — closed rows stay under their phase header (Q1-A rejects Q1-C sub-section). `renderJsonEnvelope` needs no code change — the new `StatusRow` fields flow through `JSON.stringify` automatically.
- [X] T012 [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts`: closed + `stateReason: 'COMPLETED'` row renders state column `✓ merged` and source column `merged/closed`; closed + `stateReason: 'NOT_PLANNED'` renders `✗ closed` and `(not planned)`; closed + `stateReason: null` defaults to the merged rendering; open rows render unchanged (baseline preservation).
- [X] T013 [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/status.color.test.ts`: closed-completed goes through `doneMerged` (green); closed-not-planned goes through `doneNotPlanned` (gray); open rows go through `colorizer.state` (baseline).
- [X] T014 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/__tests__/status.json.test.ts` (or extend an existing `status.render.test.ts` block): assert `renderJsonEnvelope` output carries `issueState` and `stateReason` on each row (per `contracts/status-envelope.md` example rows); assert `state` and `sourceLabel` fields are preserved unchanged (backwards compat).
- [X] T015 [P] [US1] Extend `packages/cockpit/src/gh/__tests__/gh-wrapper.test.ts`: `IssueRawSchema.parse` accepts `stateReason` values `'COMPLETED'`, `'NOT_PLANNED'`, `null`, `undefined`, and coerces any other string to `null`; `listIssues()` and `getIssue()` mappers propagate `stateReason` verbatim; `--json` field lists include `stateReason` (assert on the spawned `gh` command args if the test harness captures them, otherwise fixture-based).

## Phase 5: Polish & Verification

- [X] T016 [US1] Grep audit per `contracts/is-done-snapshot.md` §Grep audit (SC-005): `rg -n "state: closed dominates|closed dominates|issueState === 'CLOSED'" packages/generacy/src/cli/commands/cockpit/ packages/cockpit/src/` — expect exactly one non-test occurrence of `closed dominates` (the JSDoc on `isDoneSnapshot`) and one non-test occurrence of `issueState === 'CLOSED'` (in `render-table.ts::fmtRow`). Any other match means a second done-gate crept in and MUST be consolidated through `isDoneSnapshot`.
- [X] T017 [US1] Run the full quickstart verification per `quickstart.md`: `pnpm --filter @generacy-ai/generacy --filter @generacy-ai/cockpit build`, then `pnpm --filter @generacy-ai/generacy test packages/generacy/src/cli/commands/cockpit/` and `pnpm --filter @generacy-ai/cockpit test packages/cockpit/src/gh/`. All new + existing tests green.

## Dependencies & Execution Order

**Sequential dependencies**:
- Phase 1 (T001–T004) MUST complete before all other phases — every downstream module reads the extended `Issue` / `IssueSnapshot` / `StatusRow` shapes.
- Within Phase 1: T001 (Issue type) → T002 (IssueSnapshot builds on Issue) → T003 (StatusRow builds on Issue) → T004 (call-site threading uses T003's signature). T002 and T003 could run in parallel after T001, but T004 is strictly sequential after T003.
- T005 (shared helper) blocks T007 (actionable.ts imports it).
- T007 (actionable.ts) blocks T008/T009 (watch tests exercise the wired behaviour).
- T010 (Colorizer interface) blocks T011 (render-table.ts uses new members) blocks T012/T013 (status tests exercise the wired render).
- Phase 5 (T016, T017) MUST run last — audits and verifies the finished state.

**Parallel opportunities within phases**:
- Phase 1: T002 [P] and T003 [P] can run in parallel after T001 (different files).
- Phase 2: T006 [P] runs in parallel with T007 (test authored against the contract, code lands in either order).
- Phase 3: T008 [P] and T009 [P] can run in parallel after T007 (different test files, no shared fixtures).
- Phase 4: T012 [P], T013 [P], T014 [P], T015 [P] can all run in parallel after T011 + T010 (four independent test files, no shared fixtures; T015 is in a different package altogether).

**Critical path** (sequential): T001 → T003 → T004 → T005 → T007 → T010 → T011 → T016 → T017. Six other tasks (T002, T006, T008, T009, T012, T013, T014, T015) can be parallelized against this spine — worst-case wall time is Phase 1's ~4 files + shared helper + actionable + color/render + audit.
