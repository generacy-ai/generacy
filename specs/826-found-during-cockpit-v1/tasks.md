# Tasks: Cockpit epic-body parser accepts titled task-list refs

**Input**: Design documents from `/specs/826-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, research.md, contracts/parser-behavior.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Fixture Setup

Verbatim regression fixtures — frozen at PR time (data-model.md §Fixture layout, FR-006). Both are independent files; they can be captured in parallel.

- [ ] T001 [P] [US1] Capture the verbatim body of `christrudelpw/sniplink#1` at PR time and save it to `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md`. Use `gh issue view christrudelpw/sniplink#1 --json body -q .body > packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md`. Do NOT edit — this is historical evidence.
- [ ] T002 [P] [US1] Capture the verbatim body of `generacy-ai/tetrad-development#85` at PR time and save it to `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-tetrad-88.md` (naming per plan.md: the `-88` suffix references the smoke-test issue `tetrad-development#88` finding #4 where the bug was surfaced). Use `gh issue view 85 --repo generacy-ai/tetrad-development --json body -q .body > packages/cockpit/src/resolver/__tests__/fixtures/epic-826-tetrad-88.md`.
- [ ] T003 [US1] Manually enumerate ground-truth ref lists per phase for each snapshot. Record the expected `phases[k].refs` array for each phase heading in both fixture files as inline test constants in `parse-epic-body.test.ts` (needed by T007). This is a read-the-markdown exercise; keep the constants adjacent to the snapshot import so drift is obvious in review.

## Phase 2: Regression Tests (write before the fix)

Extend `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts` (single file — all these subtasks land in the same file, so they are sequential). Every added test is expected to **fail** against the current `parse-epic-body.ts` and **pass** after Phase 3.

- [ ] T004 [US1] Add inline integration excerpt to `parse-epic-body.test.ts`: one `### <phase>` heading with all 4 accepted ref shapes (bare, md-link-bare-label, md-link-hash-label, plain URL) × 2 primary delimiter styles (em-dash `—` and ASCII hyphen `-`). Assert `parseEpicBody(body).phases[0].refs` equals the expected 8-entry list and `warnings` is `[]`. Covers FR-002, FR-003 (title-less also covered via existing tests), acceptance criteria on US1.
- [ ] T005 [US1] Add snapshot-loader test in `parse-epic-body.test.ts` importing `fixtures/epic-826-sniplink.md` via `readFileSync` (pattern per data-model.md §Fixture layout). Assert each phase's `refs` matches the ground-truth list from T003 and `warnings === []`. Covers SC-001.
- [ ] T006 [US1] Add snapshot-loader test in `parse-epic-body.test.ts` importing `fixtures/epic-826-tetrad-88.md` via `readFileSync`. Assert each phase's `refs` matches the ground-truth list from T003 and `warnings === []`. Covers SC-001, SC-002 pre-condition (parser side).
- [ ] T007 [US2] Add three warning-family assertions to `parse-epic-body.test.ts` using `toContain()` on marker substrings (contracts/parser-behavior.md §Warnings): `bare '#N'` for `- [ ] #8`, `titled but not ref-shaped` for `- [ ] owner/repo#N — title` (this line exposes the bug pre-fix and asserts the corrected marker post-fix), and `URL path not /(issues|pull)/N` for `- [ ] https://github.com/owner/repo/commit/abc123`. Also assert the envelope: `expect(warnings[0]).toMatch(/ignored ref-shaped task-list line \d+/)` and `expect(warnings[0]).toContain("'<offendingRefText>'")`. Covers FR-005, SC-003.
- [ ] T008 [US2] Add prose-line silence test to `parse-epic-body.test.ts`: `- [ ] Do X, see owner/repo#5` under a phase heading → `phases[0].refs === []` AND `warnings === []`. Covers FR-007, SC-004.
- [ ] T009 [US1] Add additional-refs-in-title silence test to `parse-epic-body.test.ts`: `- [ ] owner/repo#1 — depends on owner/repo#2` → `phases[0].refs` is exactly `[{ repo: 'owner/repo', number: 1 }]`, `warnings === []`. Covers FR-008.
- [ ] T010 [US1] Run `pnpm --filter @generacy-ai/cockpit test src/resolver/__tests__/parse-epic-body.test.ts` and confirm the new tests T004–T009 fail (existing tests still pass). This is the "red" step — proves the tests actually cover the bug before the fix lands.

## Phase 3: Fix Implementation

Single-file edit inside `packages/cockpit/src/resolver/parse-epic-body.ts` (data-model.md §Types touched, plan.md §Structure). Must land after Phase 2 so the new tests turn green.

- [ ] T011 [US1] In `packages/cockpit/src/resolver/parse-epic-body.ts` at the task-list-line handling site (`parse-epic-body.ts:71-73` per spec.md root-cause 1), extract the first whitespace-delimited token from `refText` (`const firstToken = refText.split(/\s+/)[0]!;`) and pass **only** `firstToken` to `parseRef` (not `refText`). Preserve `refText` for the warning envelope. Covers FR-001, FR-002, FR-003.
- [ ] T012 [US2] In the same file, at the warning branch (spec.md root-cause 2, `parse-epic-body.ts:77`), add a `classifyRejection(firstToken, refText)` helper (module-local) that returns a string containing exactly one documented marker substring per the taxonomy in data-model.md §Rejection-family taxonomy: `bare '#N'` when `firstToken` matches `^#\d+$`, `URL path not /(issues|pull)/N` when `firstToken` matches `^https?://`, otherwise `titled but not ref-shaped`. Update the warning push to interpolate the classification result into the envelope `cockpit: ignored ref-shaped task-list line <N>: '<refText>' (<reason>)`. Add a short comment near `classifyRejection` naming the three marker substrings so future edits do not accidentally break test assertions. Covers FR-005.
- [ ] T013 [US1] In the same file, ensure the `REF_SHAPED_RE.test(...)` check that guards the warning branch is run against `firstToken` (not `refText`), so prose lines whose first token is not ref-shaped are silent even when a ref appears later in the title portion. Covers FR-007, FR-008.
- [ ] T014 [US1] Run `pnpm --filter @generacy-ai/cockpit test src/resolver/__tests__/parse-epic-body.test.ts` and confirm all tests (T004–T009 plus pre-existing) now pass. This is the "green" step.

## Phase 4: Validation & Polish

- [ ] T015 [P] [US1] Run `pnpm --filter @generacy-ai/cockpit test packages/cockpit/src/resolver` — full resolver suite (`parse-epic-body`, `ref-shapes`, `heading-match`, `resolve`) must be green. Confirms `ref-shapes.ts`, `resolve.ts`, `heading-match.ts` were not touched and their tests still pass.
- [ ] T016 [P] [US1] Run `pnpm --filter @generacy-ai/cockpit build` — confirms no type errors introduced (the fix is pure JS logic but the module still compiles under tsc-ESM).
- [ ] T017 [US1] Walk through quickstart.md Cases 1–7 by hand (or as a scratch node script per the file) using the built package. Each case's expected output must match. Case 8 is covered by the test suite (T005/T006).
- [ ] T018 [US2] Draft the PR description with the Q4→C manual `gh issue edit` post-merge step for `tetrad-development#88`: revert the title-stripped workaround and restore the original `- [ ] owner/repo#N — title` lines on that issue's body. Include the exact `gh` command from quickstart.md §Post-merge manual step. This step is documentation only — no code change lands in this PR to touch `tetrad-development` — but the PR description must call it out so the reviewer and the person merging know it's expected.

## Dependencies & Execution Order

**Sequential spine**:
1. Phase 1 (fixtures + ground-truth) → 2. Phase 2 (failing tests) → 3. Phase 3 (fix + tests turn green) → 4. Phase 4 (validation).

**Within-phase parallelism**:
- **T001 and T002** are independent (two different `.md` snapshot files) — safe to run in parallel.
- **T003** depends on T001 and T002 (need the fixtures to read).
- **T004–T009** all edit the same file (`parse-epic-body.test.ts`) — must land sequentially. Ordering among them is not load-bearing, but a single commit is cleanest.
- **T010** depends on T004–T009 being in place.
- **T011–T013** all edit the same file (`parse-epic-body.ts`) — sequential. Order T011 → T012 → T013 keeps the diff readable (core extraction → warning rewrite → guard tightening).
- **T014** depends on T011–T013.
- **T015 and T016** are independent commands against a green test tree — run in parallel.
- **T017** should follow the build (T016) so the quickstart cases use compiled dist.
- **T018** is documentation-only and can be drafted at any point in Phase 4.

**Rationale for tests-before-fix ordering (TDD-ish)**: The core bug is that the test suite codified the shipped behavior instead of the documented contract (spec.md §Why tests didn't catch it). Writing the tests first and watching them fail (T010) enforces the invariant that the new tests actually exercise the bug before we edit any production code. This closes the loop on the meta-issue as well as the immediate bug.

**Files touched (final tally)**:
- MODIFIED: `packages/cockpit/src/resolver/parse-epic-body.ts` (~15 net LOC, one function)
- MODIFIED: `packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts` (~80 net LOC)
- NEW: `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-sniplink.md`
- NEW: `packages/cockpit/src/resolver/__tests__/fixtures/epic-826-tetrad-88.md`
- UNTOUCHED: `ref-shapes.ts`, `resolve.ts`, `heading-match.ts`, `errors.ts`, `types.ts`, `docs/label-protocol.md`.

## User Story Traceability

- **US1 (epic author writes house-style task lists)**: T001, T002, T003, T004, T005, T006, T008, T009, T010, T011, T013, T014, T015, T016, T017.
- **US2 (operator sees accurate warning)**: T007, T012, T018.

## Success Criteria Traceability

- **SC-001** (real-world bodies resolve without warnings): T005, T006.
- **SC-002** (smoke test emits 0 warnings on house-style lines): T005, T006 (parser-side), T018 (post-merge live check).
- **SC-003** (warning marker substrings): T007, T012.
- **SC-004** (prose lines mentioning a ref outside the first-token position do not warn): T008, T013.
