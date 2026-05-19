# Tasks: Phase 3 Cleanup — Delete PHASE_TO_COMMAND and Claude Flags from Orchestrator

**Input**: Design documents from `/specs/435-goal-final-step-phase/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Verify Prerequisites

- [X] T001 [US1] Verify plugin exports `PTY_WRAPPER` — confirm `PTY_WRAPPER` is exported from `@generacy-ai/generacy-plugin-claude-code` public API (`packages/generacy-plugin-claude-code/src/launch/constants.ts` and barrel export). If not, add it to the package's barrel export.

## Phase 2: Core Deletions

- [X] T002 [P] [US1] Delete `PHASE_TO_COMMAND` from `packages/orchestrator/src/worker/types.ts` — remove the constant and its JSDoc comment (lines 70-80)
- [X] T003 [P] [US1] Remove `PHASE_TO_COMMAND` re-export from `packages/orchestrator/src/worker/index.ts` — delete `PHASE_TO_COMMAND,` from the re-export block (line 17)
- [X] T004 [P] [US1] Delete `PTY_WRAPPER` constant from `packages/orchestrator/src/conversation/conversation-spawner.ts` — remove lines 40-57 and add import from `@generacy-ai/generacy-plugin-claude-code`
- [X] T005 [P] [US1] Delete deprecated `spawn()` method and `ConversationSpawnOptions` interface from `packages/orchestrator/src/conversation/conversation-spawner.ts` — remove lines 6-13 (interface) and lines 107-136 (method)

## Phase 3: Caller Updates

- [X] T006 [P] [US1] Update `packages/orchestrator/src/worker/phase-loop.ts` — remove `PHASE_TO_COMMAND` import; replace `PHASE_TO_COMMAND[phase] === null` with `phase === 'validate'` (line 147); replace `PHASE_TO_COMMAND[phase] !== null` with `phase !== 'validate'` (line 217)
- [X] T007 [P] [US1] Update `packages/orchestrator/src/worker/cli-spawner.ts` — remove `PHASE_TO_COMMAND` import; replace `const command = PHASE_TO_COMMAND[phase]` with `` const command = `/${phase}` `` (line 42); delete null guard (line 43); update JSDoc (lines 33-35)

## Phase 4: Test Updates

- [X] T008 [P] [US1] Update `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` and `cli-spawner-snapshot.test.ts` — remove any `PHASE_TO_COMMAND` references; update snapshots for inline command derivation
- [X] T009 [P] [US1] Update `packages/orchestrator/src/conversation/__tests__/conversation-spawner.test.ts` — remove tests for deprecated `spawn()` method; verify `spawnTurn()` tests work with imported `PTY_WRAPPER`
- [X] T010 [P] [US1] Verify `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` — confirm validate-phase routing tests pass with inline `phase === 'validate'` check

## Phase 5: Verification

- [X] T011 [US2] Run grep verification — confirm `grep -rn "PHASE_TO_COMMAND" packages/orchestrator/src/` returns 0 results; confirm `grep -rn '"claude"' packages/orchestrator/src/` returns only process command references (cli-spawner.ts, pr-feedback-handler.ts, conversation-spawner.ts)
- [X] T012 [US2] Run full test suite — `pnpm --filter @generacy-ai/orchestrator test` and `pnpm --filter @generacy-ai/orchestrator build` to confirm clean compilation and all tests pass

## Dependencies & Execution Order

**Phase boundaries (sequential)**:
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

**Parallel opportunities within phases**:
- **Phase 2**: T002, T003, T004, T005 can all run in parallel (different files)
- **Phase 3**: T006, T007 can run in parallel (different files)
- **Phase 4**: T008, T009, T010 can run in parallel (different test files)

**Key dependencies**:
- T002 must complete before T006, T007 (they remove imports of the deleted constant)
- T003 depends on T002 (removing re-export of deleted symbol)
- T004 depends on T001 (plugin must export `PTY_WRAPPER` before orchestrator imports it)
- T005 is independent of other Phase 2 tasks (different code section in same file as T004, but non-overlapping)
- T008-T010 depend on Phase 2+3 changes being complete
- T011-T012 are final validation after all code changes
