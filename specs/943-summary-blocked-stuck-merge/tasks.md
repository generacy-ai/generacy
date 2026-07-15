# Tasks: Cockpit classifier — `blocked:*` error tier (#943)

**Input**: Design documents from `/specs/943-summary-blocked-stuck-merge/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/classifier-error-tier.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story / clarified decision this task belongs to (CD-1, CD-2, CD-3)

## Phase 1: Setup

- [ ] T001 Locate `packages/cockpit/src/state/label-map.ts` and `packages/cockpit/src/state/precedence.ts`; confirm current `classifyByPattern` and `compareSourceLabels` shapes match the diffs described in `plan.md` (BEFORE snippets on lines 76-82 and 122-134). No code change; sanity check that the plan's line references still map to reality.

## Phase 2: Core Implementation

- [ ] T002 [CD-1] In `packages/cockpit/src/state/label-map.ts`, add module-scoped `const ERROR_BLOCKED_LABELS: ReadonlySet<string> = new Set(['blocked:stuck-merge-conflicts', 'blocked:stuck-validate-fix'])` alongside the existing `TERMINAL_COMPLETED_LABELS` pattern. Insert `if (ERROR_BLOCKED_LABELS.has(label)) return 'error';` in `classifyByPattern` **immediately before** the existing `waiting-for:` / `needs:` / `blocked:` prefix branch. Do not modify the prefix branch — `blocked:stuck-feedback-loop` and unlisted `blocked:*` names must still fall through to `'waiting'`.

- [ ] T003 [P] [CD-2, CD-3] In `packages/cockpit/src/state/precedence.ts`, add and export `const ERROR_PIPELINE_ORDER: string[] = ['blocked:stuck-merge-conflicts', 'blocked:stuck-validate-fix']`. Extend `compareSourceLabels` with a new `if (tier === 'error') { ... }` branch inserted between the existing `stage-complete` branch and the final `workflowIndex` fallback. Semantics: both listed → lower `indexOf` wins; one listed → listed wins; neither listed → fall through to `workflowLabelIndex` (existing behaviour). Mirror the shape of the existing `waiting` branch.

## Phase 3: Tests

- [ ] T004 [CD-1, CD-2, CD-3] In `packages/cockpit/src/__tests__/classifier.test.ts`, add a new `describe('#943: blocked:* labels in the error tier', () => { ... })` block covering: (a) single-label — `blocked:stuck-merge-conflicts` → `{error, blocked:stuck-merge-conflicts}`; (b) single-label — `blocked:stuck-validate-fix` → `{error, blocked:stuck-validate-fix}`; (c) `blocked:stuck-feedback-loop` still `{waiting, blocked:stuck-feedback-loop}` (safe default / preserves #883); (d) unknown `blocked:*` prefix (e.g. `blocked:future`) stays waiting; (e) `blocked:stuck-merge-conflicts` wins sourceLabel over `agent:error`; (f) wins over `failed:validate`; (g) `blocked:stuck-validate-fix` wins over `agent:error`; (h) `blocked:stuck-merge-conflicts` wins over `blocked:stuck-validate-fix` by `ERROR_PIPELINE_ORDER`; (i) cross-tier — `classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts'])` → `{error, blocked:stuck-merge-conflicts}`; (j) `classify(['waiting-for:validate-fix', 'blocked:stuck-validate-fix'])` → `{error, blocked:stuck-validate-fix}` (per contract); (k) regression guards — `agent:error` alone still `error`; `failed:plan` alone still `error`. Do **not** modify the existing `#883` or `#926` describe blocks or the `canary: error beats stage-complete` case.

- [ ] T005 [P] [CD-1] Add a `mapLabelToState` unit test (either colocated in `classifier.test.ts` or in a sibling `label-map.test.ts`, matching whichever file already tests `mapLabelToState`) asserting: `mapLabelToState('blocked:stuck-merge-conflicts') === 'error'`, `mapLabelToState('blocked:stuck-validate-fix') === 'error'`, `mapLabelToState('blocked:stuck-feedback-loop') === 'waiting'`. Verifies `LABEL_TO_STATE` rebuild picked up the new disposition (SC-001, SC-004, SC-005).

- [ ] T006 [P] [CD-3] Add an invariant test asserting **every entry in `ERROR_PIPELINE_ORDER` classifies as `'error'` under `mapLabelToState`** (per data-model.md §`ERROR_PIPELINE_ORDER` validation rule). Guards against a future edit that adds a label to the pipeline without also adding it to `ERROR_BLOCKED_LABELS`.

## Phase 4: Validation

- [ ] T007 Run `pnpm --filter @generacy-ai/cockpit vitest run src/__tests__/classifier.test.ts` (and the sibling test file if T005 added one). All new `#943` cases pass; every pre-existing `#883`, `#926`, canary, and regression case still passes with zero edits to their assertions.

- [ ] T008 [P] Run `pnpm --filter @generacy-ai/cockpit typecheck` (or the repo's equivalent `pnpm -r tsc --noEmit` invocation) to confirm the new `ERROR_PIPELINE_ORDER` export and `ERROR_BLOCKED_LABELS` set compile cleanly under strict TypeScript.

- [ ] T009 [P] Run `pnpm --filter @generacy-ai/cockpit build`, then execute the REPL smoke check from `quickstart.md` §"Verifying the change locally": `mapLabelToState('blocked:stuck-merge-conflicts')` → `'error'`, `mapLabelToState('blocked:stuck-validate-fix')` → `'error'`, `mapLabelToState('blocked:stuck-feedback-loop')` → `'waiting'`, `classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts'])` → `{ state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' }`, `classify(['agent:error', 'blocked:stuck-merge-conflicts'])` → same.

## Phase 5: Post-merge dogfood (SC-003)

- [ ] T010 After merge and cluster rebuild, re-run the snappoll auto flow (or the next natural auto-mode run that hits a merge-conflict block). Confirm zero "unrecognized-state escalations" attributable to `blocked:stuck-merge-conflicts` in the run summary. Record the observation in the issue as the SC-003 evidence. This task is verification-only and does not gate the merge — it validates the fix landed correctly in the deployed classifier.

## Dependencies & Execution Order

- **T001** (sanity check) → gates **T002** and **T003**.
- **T002** and **T003** are on **different files** (`label-map.ts` vs `precedence.ts`) with no data dependency. Can run in parallel — T003 marked `[P]`.
- **T004** (main classifier tests) depends on both T002 and T003 landing (tests exercise the full classify pipeline).
- **T005** (`mapLabelToState` unit) depends on **T002 only** — can start once T002 is done, but a single-agent execution will typically bundle it with T004.
- **T006** (pipeline invariant) depends on **T003 only**.
- **T004**, **T005**, **T006** all edit under `packages/cockpit/src/__tests__/` — T005 and T006 marked `[P]` because they add distinct test cases and, if colocated in the same file, are additive appends. If a reviewer prefers a single test-editing pass, bundle T005/T006 into T004.
- **T007** (test run) depends on T004, T005, T006 all being present.
- **T008** (typecheck) and **T009** (build + smoke) depend on T002 + T003 (source changes) but not on the test edits — marked `[P]` with T007.
- **T010** (post-merge dogfood) is out-of-band, runs after the PR is merged and the cluster picks up the new `@generacy-ai/cockpit` build. Not gated by CI.

**Parallel opportunities**:
- Wave A (after T001): T002 ∥ T003.
- Wave B (after Wave A): T004 ∥ T005 ∥ T006 (all test additions, non-conflicting appends).
- Wave C (after Wave B): T007 ∥ T008 ∥ T009.
- Wave D (post-merge): T010 alone.

## Success Criteria Mapping

| SC | Task(s) |
|----|---------|
| SC-001 (`blocked:stuck-merge-conflicts` → `error`) | T002, T004(a), T005, T007 |
| SC-002 (`sourceLabel` outranks `agent:error` / `failed:*`) | T003, T004(e)(f)(g)(i)(j), T007 |
| SC-003 (zero unrecognized-state escalations post-fix) | T010 |
| SC-004 (`blocked:stuck-validate-fix` → `error`) | T002, T004(b)(g)(j), T005, T007 |
| SC-005 (`blocked:stuck-feedback-loop` still `waiting`) | T004(c), T005, T007 |
