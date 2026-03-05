# Tasks: Post Clarification Questions to Issue

**Input**: Design documents from `/specs/316-summary-when-speckit-workflow/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Create `packages/orchestrator/src/worker/clarification-poster.ts` with `parsePendingQuestions()` — parse `clarifications.md` markdown, split on `### Q\d+:` headers, extract topic/context/question/options, filter to `**Answer**: *Pending*` only
- [ ] T002 [US1] Add `formatQuestionsComment()` to `clarification-poster.ts` — format `PendingQuestion[]` into a GitHub-flavored markdown comment with header, question blocks, and footer
- [ ] T003 [US1] Add `postClarificationQuestions()` to `clarification-poster.ts` — glob for `specs/{issueNumber}-*/clarifications.md` in `checkoutPath`, read/parse/format, call `github.addIssueComment()`. Wrap in try/catch so failures log but don't block gate-hit flow

## Phase 2: Integration

- [ ] T004 [US1] Integrate into `packages/orchestrator/src/worker/phase-loop.ts` — import `postClarificationQuestions`, call it **before** `labelManager.onGateHit()` when `gate.gateLabel === 'waiting-for:clarification'` (around line 195)

## Phase 3: Tests

- [ ] T005 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` — unit tests for `parsePendingQuestions()`: valid markdown with multiple questions, mixed pending/answered, malformed input, empty file
- [ ] T006 [P] [US1] Add tests for `formatQuestionsComment()` — verify output format, single question, multiple questions, questions with and without options
- [ ] T007 [P] [US1] Add tests for `postClarificationQuestions()` — mock fs/glob and GitHubClient: happy path posts comment, missing file is no-op with warning, no pending questions skips posting, GitHub API error is caught and logged
- [ ] T008 [US1] Add integration test in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — verify that when clarify phase gate is hit, `postClarificationQuestions` is called before `onGateHit`

## Dependencies & Execution Order

1. **T001 → T002 → T003** (sequential within same file, each builds on prior)
2. **T003 → T004** (integration requires the utility to exist)
3. **T005, T006, T007** can run in **parallel** (independent test suites for different functions)
4. **T004 → T008** (integration test requires the phase-loop change)

**Critical path**: T001 → T002 → T003 → T004 → T008
**Parallel opportunity**: T005 + T006 + T007 after T003 is complete
