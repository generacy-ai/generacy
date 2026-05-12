# Tasks: Fix malformed EventMessage shape in internal-relay-events handler

**Input**: Design documents from `/specs/600-symptoms-after-all-594/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Fix

- [ ] T001 [US1,US2,US3] Fix EventMessage field mapping in `packages/orchestrator/src/routes/internal-relay-events.ts:42-46` — change `channel` to `event: channel`, `event: payload` to `data: payload`, add `timestamp: new Date().toISOString()`
- [ ] T002 [P] [US1,US2,US3] Update test assertion in `packages/orchestrator/src/routes/__tests__/internal-relay-events.test.ts:58-62` — change expected `{ channel, event }` to `{ event, data, timestamp: expect.any(String) }`

## Phase 2: Verify

- [ ] T003 Run `pnpm --filter @generacy-ai/orchestrator test` to confirm all tests pass
- [ ] T004 Verify no other `as unknown as RelayMessage` double-casts exist in the relay event path (SC-004)

## Dependencies & Execution Order

- T001 and T002 can run in parallel (different files, no data dependency)
- T003 depends on T001 + T002 (tests must reflect the fix)
- T004 can run in parallel with T003 (code search, read-only)
