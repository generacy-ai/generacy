# Tasks: Handle `bootstrap-complete` lifecycle action

**Input**: Design documents from `/specs/562-problem-four-bootstrap-mode/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Handler

- [ ] T001 [US1] Add `'bootstrap-complete'` to `LifecycleActionSchema` enum in `packages/control-plane/src/schemas.ts`
- [ ] T002 [US1] Add `bootstrap-complete` handler branch in `packages/control-plane/src/routes/lifecycle.ts` — read `POST_ACTIVATION_TRIGGER` env var (default `/tmp/generacy-bootstrap-complete`), write empty sentinel file with `flag: 'w'`, return `{ accepted: true, action, sentinel }`

## Phase 2: Tests

- [ ] T003 [US1] Add test: `POST /lifecycle/bootstrap-complete` returns 200 and writes sentinel file — in `packages/control-plane/__tests__/routes/lifecycle.test.ts`
- [ ] T004 [US2] Add test: idempotent — second call also returns 200, no error
- [ ] T005 [P] [US1] Add test: `POST_ACTIVATION_TRIGGER` env var overrides default sentinel path
- [ ] T006 [P] [US1] Add test: missing actor returns 401 UNAUTHORIZED

## Dependencies & Execution Order

- **T001 → T002**: Schema must be extended before handler can reference the new action value.
- **T001 + T002 → T003–T006**: All tests depend on the schema and handler being in place.
- **T003 → T004**: Idempotent test builds on the basic success test.
- **T005 and T006** are independent of each other and can run in parallel.
- All tasks are small and completable in a single session.
