# Tasks: Task Chunking with Session Restart for Large Task Lists

**Input**: Design documents from `/specs/360-summary-issues-many-tasks/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Definitions

- [X] T001 [US1] Add `max_tasks_per_increment` to `ImplementInput` and `partial`/`tasks_remaining` to `ImplementOutput` in `packages/workflow-engine/src/actions/builtin/speckit/types.ts`
- [X] T002 [P] [US1] Add `ImplementPartialResult` interface and `implementResult?` field to `PhaseResult` in `packages/orchestrator/src/worker/types.ts`

## Phase 2: Core Implementation

- [X] T003 [US1] Implement increment boundary logic in `packages/workflow-engine/src/actions/builtin/speckit/operations/implement.ts`: read `max_tasks_per_increment`, track `tasksThisIncrement` counter, check limit before each sequential task or parallel batch, return `partial: true` early when limit reached
- [X] T004 [P] [US1] Add sentinel parsing in `packages/orchestrator/src/worker/output-capture.ts`: private `_implementResult` field, parse `SPECKIT_IMPLEMENT_PARTIAL: {...}` prefix from text chunks in `parseLine`, expose via getter
- [X] T005 [P] [US1] Populate `result.implementResult` from `capture?.implementResult` in `packages/orchestrator/src/worker/cli-spawner.ts`
- [X] T006 [US1] Add partial re-invocation loop in `packages/orchestrator/src/worker/phase-loop.ts`: declare `lastTasksRemaining`, after successful implement phase check `result.implementResult?.partial`, call `commitPushAndEnsurePr` with wip message, clear `currentSessionId`, update stage comment, guard against infinite loop (fail if no progress), decrement `i` and continue
- [X] T007 [P] [US1] Update `/workspaces/agency/packages/agency-plugin-spec-kit/commands/implement.md`: output `SPECKIT_IMPLEMENT_PARTIAL: {...}` sentinel when MCP result has `partial: true`, and add Task Increment Boundaries documentation section

## Phase 3: Tests

- [ ] T008 [US1] Write unit tests for increment counter logic in `implement.ts`: counter increments per task and per parallel batch, limit check before sequential task, limit check before parallel batch, returns `partial: true` with correct counts, no partial when all tasks complete in one increment
- [ ] T009 [P] [US1] Write unit tests for sentinel parsing in `output-capture.ts`: valid sentinel parsed correctly, malformed JSON ignored, non-sentinel text lines ignored, getter returns undefined when no sentinel seen
- [ ] T010 [US1] Write integration test for `phase-loop.ts` re-invocation: mock partial result triggers commit/push/fresh-session/re-invoke, zero-progress guard fails correctly, normal completion (no sentinel) takes standard path

## Dependencies & Execution Order

**Phase 1 → Phase 2 → Phase 3** (must complete in order)

**Parallel opportunities within Phase 1**:
- T001 and T002 target different packages — can run in parallel

**Parallel opportunities within Phase 2**:
- T003 depends on T001 (ImplementInput/Output types)
- T004 depends on T002 (ImplementPartialResult type)
- T005 depends on T002 (ImplementPartialResult type)
- T006 depends on T002 (PhaseResult.implementResult type)
- T007 depends on T001 (knows what fields partial output includes)
- T004, T005, T007 can run in parallel with each other (different files, no shared deps)
- T003 and T006 depend on each other only indirectly — they are in different packages and can be developed in parallel, but T006 should be validated after T003 is working

**Parallel opportunities within Phase 3**:
- T008 and T009 can run in parallel (testing different files)
- T010 depends on Phase 2 completion (especially T006)
