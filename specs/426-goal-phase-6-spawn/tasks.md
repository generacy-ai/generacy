# Tasks: Extend ProcessFactory with optional uid/gid

**Input**: Design documents from `/specs/426-goal-phase-6-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Interface Extension

- [X] T001 [US1] Add `uid?: number` and `gid?: number` to `ProcessFactory.spawn` options type in `packages/orchestrator/src/worker/types.ts:269-275`

## Phase 2: Implementation

- [X] T002 [P] [US1] Update `defaultProcessFactory.spawn` in `packages/orchestrator/src/worker/claude-cli-worker.ts:25-54` to forward `uid`/`gid` to `child_process.spawn` using conditional spread (only include when defined)
- [X] T003 [P] [US1] Update `conversationProcessFactory.spawn` in `packages/orchestrator/src/conversation/process-factory.ts:10-40` to forward `uid`/`gid` to `child_process.spawn` using conditional spread (only include when defined)

## Phase 3: Tests

- [X] T004 [P] [US2] Add unit tests for `defaultProcessFactory` uid/gid forwarding in `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts` — mock `child_process.spawn` at module level, assert uid/gid present in spawn options when provided, assert uid/gid keys absent when omitted
- [X] T005 [P] [US2] Add unit tests for `conversationProcessFactory` uid/gid forwarding — create `packages/orchestrator/src/conversation/__tests__/process-factory.test.ts` or extend existing tests — mock `child_process.spawn` at module level, assert uid/gid present when provided, assert keys absent when omitted

## Phase 4: Validation

- [X] T006 [US1] Run `pnpm test` in orchestrator package to verify all existing and new tests pass
- [X] T007 [US1] Verify no callers were modified — `git diff` should show no changes to files outside the 3 source files and test files

## Dependencies & Execution Order

```
T001 (interface) → T002, T003 (implementations, parallel)
                 → T004, T005 (tests, parallel with each other, can start after T002/T003)
T002-T005 all complete → T006 (validation)
T006 → T007 (final check)
```

- **T001** must complete first — both implementations depend on the updated interface type
- **T002 and T003** can run in parallel (different files, no shared state)
- **T004 and T005** can run in parallel (different test files); each depends on its corresponding implementation task
- **T006** runs after all implementation and test tasks complete
- **T007** is a final sanity check
