# Tasks: Clarify Phase Gate-Skip Race

**Input**: Design documents from `/specs/818-observed-generacy-ai-agency/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Scope

All behaviour changes land in **one production file** and **one test file**:

- `packages/orchestrator/src/worker/clarification-poster.ts`
- `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`

Because both phases (tests and implementation) mutate the same file inside their phase, no `[P]` markers apply — tasks are strictly sequential to avoid merge/edit conflicts on adjacent regions.

## Phase 1: Setup

- [ ] T001 Verify baseline test status: run `pnpm --filter @generacy-ai/orchestrator test -- clarification-poster` from repo root and confirm all existing tests pass. Snapshot the passing count so regressions in Phase 4 are attributable.

## Phase 2: Tests First (TDD)

Add failing regression tests before touching production code. All new tests extend `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`.

- [ ] T002 [US1] Add `describe('isQuestionComment — markup co-occurrence (FR-001)', ...)` block covering the 5 cases from research.md D1/D6: (a) marker-absent + all three markups, (b) marker-absent + `**Question**:` only, (c) marker-absent + `**Context**:` only, (d) marker-absent + `**Options**:` only, (e) marker-absent + markup outside any `### Q<n>:` section (must return `false` — negative case).
- [ ] T003 [US1] Add FR-006 test in the existing `describe('integrateClarificationAnswers', ...)` block: given a well-formed bot questions comment (matching `formatComment` output verbatim with a `<!-- generacy-clarifications:N -->` marker), `parseAnswersFromComments` must integrate **0** answers.
- [ ] T004 [US1] Add FR-007 test: given a variant questions comment (no dedup marker, no `## Clarification Questions` heading, only `### Q<n>:` headings + `**Question**:` markup), `integrateClarificationAnswers` must integrate 0 answers and `hasPendingClarifications` must return `true` — this is the exact agency#374 failure mode.
- [ ] T005 [US1] Add `describe('parseAnswersFromComments — line anchoring (FR-005, FR-008)', ...)` block: (a) `Q1: A` at line start still captures, (b) mid-prose `as per Q1: yes` does NOT capture, (c) `Q1: A\ncontext prose\nas per Q2: no` captures Q1 only.
- [ ] T006 [US2] Add `describe('parseAnswersFromComments — suspicious answer skip (FR-002, US2)', ...)` block: (a) captured answer text contains `**Question**:` → answer NOT integrated, `logger.warn` called with `{ code: 'SKIPPED_SUSPICIOUS_ANSWER', commentId, questionNumber, excerpt }` matching `contracts/log-skipped-suspicious-answer.schema.json`; (b) same for `**Context**:`; (c) clean human answer does NOT trip the warn. Use `vi.spyOn(logger, 'warn')`.
- [ ] T007 [US2] Add `describe('integrateClarificationAnswers — residual race warn (FR-004)', ...)` block: (a) comment has `### Q1:` heading but no markup + provides `Q1: real answer` → integration succeeds AND `logger.warn` fires with `{ code: 'TRANSITION_WITH_QUESTION_HEADINGS', commentId: <real-id>, issueNumber, questionNumber, answer }` matching `contracts/log-transition-with-question-headings.schema.json`; (b) normal human answer with no `### Q<n>:` heading → NO warn; (c) comment with `### Q1:` heading but the question is already answered (no transition) → NO warn.
- [ ] T008 Run `pnpm --filter @generacy-ai/orchestrator test -- clarification-poster` and confirm **only the new tests fail** (existing tests still pass, new tests fail with `expect(...).toBe(...)` mismatches, not with `TypeError` — signal that the tests are well-formed against the current code path).

## Phase 3: Core Implementation

All edits in `packages/orchestrator/src/worker/clarification-poster.ts`.

- [ ] T009 [US1] FR-001 — add private helper `splitByQuestionHeading(body: string): string[]` per data-model.md §2 (walks `### Q<n>:` headings, cuts sections at next `### `). Extend `isQuestionComment(body)` with a new final branch that returns `true` if any returned section contains `**Question**:`, `**Context**:`, or `**Options**:`. Keep the four existing marker/heading branches unchanged (short-circuit before the new rule).
- [ ] T010 [US2] Widen `parseAnswersFromComments` signature per data-model.md §1: input `Array<{ id: number; body: string; created_at?: string }>`, add `logger: Logger` param, return `Map<number, ParsedAnswer>` where `ParsedAnswer = { answer: string; sourceCommentId: number; sourceHadQuestionHeadings: boolean }`. Compute `sourceHadQuestionHeadings` per comment via `/(?:^|\n)###\s+Q\d+:/.test(comment.body)`.
- [ ] T011 [US1] FR-005 — inside the widened `parseAnswersFromComments`, replace the current regex at `clarification-poster.ts:326-327` with the line-anchored version from research.md D3: `/(?:^|\n)(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs`.
- [ ] T012 [US2] FR-002 — inside `parseAnswersFromComments`'s capture loop, immediately after `answer = extractEmbeddedAnswer(answer) ?? answer.trim()` and BEFORE the `Skip placeholder text` check, add a rejection: if `answer.includes('**Question**:')` or `answer.includes('**Context**:')`, `continue` and emit `logger.warn({ code: 'SKIPPED_SUSPICIOUS_ANSWER', commentId: comment.id, questionNumber, excerpt: answer.slice(0, 120) }, 'Skipped suspicious clarification answer (contains question-side markup)')`.
- [ ] T013 [US2] Update the local `let comments: Array<{ body: string }>` declaration inside `integrateClarificationAnswers` (per plan.md §Project Structure, ~line 405) to `Array<{ id: number; body: string; created_at?: string }>` so `id` reaches the widened `parseAnswersFromComments`. Update the `parseAnswersFromComments(...)` call to pass `logger`.
- [ ] T014 [US2] FR-004 — inside `integrateClarificationAnswers`'s transition loop (research.md D5), for each `[questionNum, ParsedAnswer]`, wrap the `updatedContent = updatedContent.replace(pattern, ...)` with a before/after content check. If `updatedContent !== previousContent` (i.e., transition actually happened) AND `parsed.sourceHadQuestionHeadings === true`, emit `logger.warn({ code: 'TRANSITION_WITH_QUESTION_HEADINGS', commentId: parsed.sourceCommentId, issueNumber, questionNumber: questionNum, answer: parsed.answer.slice(0, 120) }, 'Integrated answer from a comment containing question headings — possible bot self-answer')`.
- [ ] T015 Re-run `pnpm --filter @generacy-ai/orchestrator test -- clarification-poster`. All Phase 2 tests (T002–T007) must now pass.

## Phase 4: Polish & Verification

- [ ] T016 Run the full orchestrator test suite: `pnpm --filter @generacy-ai/orchestrator test`. Confirm no regressions in unrelated test files.
- [ ] T017 Run typecheck: `pnpm --filter @generacy-ai/orchestrator typecheck` (or workspace-level `pnpm typecheck` if that's the convention). The `parseAnswersFromComments` signature change must not leak type errors into callers.
- [ ] T018 Manual smoke test per `quickstart.md` Step 2 (pre-fix repro) then Step 3 (post-fix verification): confirm the fake bot comment integrates 0 answers and `hasPendingClarifications` returns `true`.
- [ ] T019 Manual verify the two warn payloads against the JSON schemas in `contracts/` — e.g., paste a sample log line through `ajv validate` or a small vitest fixture that spies on `logger.warn` and asserts the object shape matches the schema.

## Dependencies & Execution Order

**Strict sequential ordering** — no `[P]` because both files (production + test) are edited across many tasks, and adjacent-region edits would conflict.

**Phase gates**:
- Phase 1 (T001) must complete before Phase 2 (baseline needed to attribute regressions).
- Phase 2 (T002–T008) must complete before Phase 3 (tests-first — tests should be red before implementation).
- Phase 3 (T009–T015) must complete before Phase 4 (verification).

**Intra-Phase 3 ordering** (production edits share one file, order matters):
- T009 (isQuestionComment widen) is independent of T010–T014, but conceptually the FR-001 primary fix — do first.
- T010 (signature widening) is a prerequisite for T011, T012, T013, T014 (they all depend on the new input shape / logger / return type).
- T011 (regex anchor) is independent of T012/T014 semantically but sits in the same function as T012 — sequence them to keep diffs reviewable.
- T012 (FR-002 skip) inside `parseAnswersFromComments`; T013 (call-site widening) in `integrateClarificationAnswers`; T014 (FR-004 warn) in `integrateClarificationAnswers`.

**Parallel opportunities**: none within this feature. If splitting across multiple developers, one could own Phase 2 (tests) and another Phase 3 (impl), but they can't overlap in time because Phase 3 needs the tests to exist first.

## User Story → Task Mapping

- **US1 (gate always pauses)**: T002, T003, T004, T005, T009, T011 (plus polish tasks).
- **US2 (detecting silent skips)**: T006, T007, T010, T012, T013, T014.

## Suggested Next Step

`/speckit:implement` — begin execution starting with T001.
