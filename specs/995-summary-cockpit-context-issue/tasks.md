# Tasks: fix `cockpit_context` clarification-comment finder against label re-application

**Input**: Design documents from `/specs/995-summary-cockpit-context-issue/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/finder.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Implementation

- [X] T001 [US1] Rewrite `findClarificationComment` in `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` to marker-first / timeline-fallback.
  - Add imports: `matchClarificationQuestionMarker` from `@generacy-ai/orchestrator`; `getLogger` from `../../utils/logger.js`.
  - Pass 1: filter comments by `matchClarificationQuestionMarker(c.body) !== undefined` AND `!isStageStatusComment(c.body)`; sort descending by `Date.parse(c.createdAt)`; return `markerHits[0]` when non-empty (FR-001, FR-002, FR-003, FR-006).
  - Pass 2 (fallback): emit exactly one `warn` log — `getLogger().warn({ owner, repo, issue: number }, `marker-less clarification comment; poster should be updated — issue=${repo}#${number}`)` at branch entry (FR-005, contract §Logging).
  - Fallback body: preserve today's `fetchIssueTimeline` walk + `latestLabelTs` scan + first-post-label-non-stage-status-comment return verbatim (D2, R2).
  - Defer `fetchIssueTimeline` to the fallback branch only (contract §API-call budget).
  - Public signature `(gh, repo, number) → Promise<IssueComment | null>` unchanged (FR-008, D6).
  - Keep the existing `isStageStatusComment` helper and its override list untouched (Assumption 2, R5).
  - Add at most one short "why" comment above the marker-first pass noting it survives label re-application (per plan §Constitution Check).

## Phase 2: Tests

- [X] T002 [US1] Add regression test `US1: returns marker-carrying comment when label re-applied after question comment (regression for #995)` in `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts`.
  - Fixture: timeline has a `labeled` event for `waiting-for:clarification` at `2026-07-18T04:31:08Z`; comments include one marker-carrying comment (`<!-- generacy-clarifications:42 -->` at column 0) with `createdAt: 2026-07-18T03:02:00Z` (i.e., before the label event).
  - Assert `c?.url` equals the marker comment's url (not `null`). (SC-001, SC-005.)

- [X] T003 [US2] Add multi-batch test `FR-002: returns latest-by-createdAt marker comment when multiple exist` in the same test file.
  - Fixture: two marker-carrying comments (`<!-- generacy-clarifications:1 -->` at `T1`, `<!-- generacy-clarifications:2 -->` at `T2 > T1`), no timeline events required.
  - Assert `c?.url` equals the `T2` batch comment. (FR-002, SC-002.)

- [X] T004 [US2] Add fallback test `FR-005: falls back to label-timeline heuristic when no marker present, emits warn` in the same test file.
  - Fixture: no marker-carrying comment; timeline has a `waiting-for:clarification` `labeled` event; one non-stage-status comment created at-or-after the label event.
  - Spy on `getLogger()` (via `vi.spyOn`, or `vi.mock('../../utils/logger.js')` returning a stub whose `warn` is a `vi.fn`) to assert exactly one `warn` call whose message contains `marker-less clarification comment; poster should be updated — issue=<repo>#<n>` and whose fields include `{ owner, repo, issue }` (contract §Logging).
  - Assert the returned comment is the post-label comment (fallback still works). (FR-005, contract return #2.)

- [X] T005 [US2] Adjust existing tests in `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts` per plan §Test Plan (per-line walkthrough).
  - Lines 23, 43, 59, 69, 92, 185, 206: no marker in fixture — pass 1 misses, fallback runs. Existing `c?.url` / `null` assertions stay the same. Update any strict "no log lines" assertions to tolerate exactly one `warn` (or add an explicit "warn fired once" assertion where useful).
  - Lines 113, 135, 163: fixture carries a `<!-- generacy-stage:clarification-batch-*` marker which IS in `CLARIFICATION_QUESTION_MARKERS` — pass 1 wins. Existing `c?.url` assertions unchanged; verify **no** warn log fires for these tests.
  - Do NOT weaken any existing assertion to make a test pass. If an existing assertion appears to conflict with the new contract, verify against `contracts/finder.md` first.

## Phase 3: Changeset

- [X] T006 [US1] Add new file `.changeset/995-cockpit-clarification-finder-marker.md` (CLAUDE.md changeset gate; FR-007).
  - Frontmatter: `'@generacy-ai/generacy': patch`.
  - Body: one-line summary followed by the paragraph from `quickstart.md` §Step 4 (`fix: cockpit_context now finds clarification comments after ...`), ending with `Resolves #995.`.
  - Must be a **newly added** file (the CI gate matches `--diff-filter=A`); do not edit an existing changeset (CLAUDE.md).

## Phase 4: Verification

- [X] T007 [US1] Run the targeted test suite: `cd packages/generacy && pnpm test clarification-comment-finder`. All existing tests plus the 3 new tests (T002–T004) must pass green (SC-004).

- [X] T008 [US1] Run the package lint + build: `pnpm --filter @generacy-ai/generacy lint && pnpm --filter @generacy-ai/generacy build`. No new errors.

- [X] T009 [US1] SC-005 regression proof: temporarily revert T001's finder change (`git stash` the file), re-run `pnpm test clarification-comment-finder`, confirm the US1 regression test (T002) fails. Restore the fix (`git stash pop`) and re-run to confirm green.

- [ ] T010 [US1] SC-003 spot-check (manual, optional if snappoll unavailable): after merge or against a synthetic reproduction, run `/cockpit:auto` on an issue whose `waiting-for:clarification` label has been re-applied *after* the question comments were posted; confirm D.1 uses the engine bundle (`cockpit_context.clarificationComment` is non-null) with no `gh issue view` fallback path fired. Snappoll #8 (2026-07-18) is the natural reproduction.

## Dependencies & Execution Order

- **T001 → T002, T003, T004, T005** — tests exercise the new code path; the finder must be rewritten first (or they will not run against the intended behavior).
- **T002, T003, T004, T005** can run in parallel *after* T001 — they touch the same file (`clarification-comment-finder.test.ts`), so parallelism is by editor session, not by process; land them together in a single edit pass to avoid conflicts.
- **T006** is independent of T001–T005; can land first, in parallel, or last, as long as it ships in the same PR (CI gate).
- **T007 → T008 → T009** — sequential verification. T007 must be green before T008; T009 depends on the fix being in-place and reversibly stashable.
- **T010** is post-merge / manual and does not block the PR.

## Notes

- Scope guard (spec §Out of Scope, plan §Out of Scope): only the three files in `plan.md` §Project Structure are touched. No poster changes, no label-lifecycle changes, no MCP contract changes, no signature changes.
- The poster-side companion (FR-004, per Q1 answer A) is a separate follow-up issue in this repo — do NOT include it here.
- The fallback branch (FR-005) is preserved verbatim from today's code; it is removed only in a follow-up once the poster fix has universalised markers (Q2 answer C).
