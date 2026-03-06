# Tasks: Post Clarification Questions on Issue

**Input**: Design documents from `/specs/316-summary-when-speckit-workflow/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Create `ClarificationPoster` class (`packages/orchestrator/src/worker/clarification-poster.ts`) — implement `postPendingQuestions(checkoutPath)` method that globs for `specs/{issueNumber}-*/clarifications.md`, parses pending questions (those with `**Answer**: *Pending*`), formats them as a readable GitHub comment, and posts via `context.github.addIssueComment()`. Follow the DI pattern from `StageCommentManager` (constructor takes `github`, `owner`, `repo`, `issueNumber`, `logger`).

- [ ] T002 [US1] Integrate `ClarificationPoster` into `phase-loop.ts` — after `labelManager.onGateHit()` and before the stage comment update, add a conditional check: if `gate.gateLabel === 'waiting-for:clarification'`, instantiate `ClarificationPoster` and call `postPendingQuestions(context.checkoutPath)`.

## Phase 2: Cleanup

- [ ] T003 [US1] Remove `gh issue comment` posting from `executeClarify()` (`packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` lines 268-305) — the orchestrator now owns this responsibility using the authenticated GitHub client instead of the fragile `gh` CLI subprocess.

## Phase 3: Tests

- [ ] T004 [US1] Add unit tests for `ClarificationPoster` (`packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`):
  - Parses pending questions from `clarifications.md` correctly
  - Skips answered questions (non-`*Pending*` answers)
  - Posts formatted comment via GitHub client mock
  - Handles missing `clarifications.md` gracefully (no error, returns false)
  - Handles file with no pending questions (no comment posted)

## Dependencies & Execution Order

- **T001** must complete before **T002** (T002 imports and uses ClarificationPoster)
- **T003** is independent of T001/T002 and can run in parallel, but logically cleaner after T002
- **T004** depends on T001 (tests the class created in T001)
- No parallelization opportunities — this is a small, linear bugfix
