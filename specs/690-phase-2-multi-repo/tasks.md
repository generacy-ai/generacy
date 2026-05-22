# Tasks: Generic `phase:after` Extension Hook

**Input**: Design documents from `/specs/690-phase-2-multi-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type Definitions

- [ ] T001 [US1] Add `CommitResult` interface to `packages/orchestrator/src/worker/types.ts` — `{ prUrl?: string; hasChanges: boolean }`
- [ ] T002 [US1] Add `PhaseAfterContext` interface to `packages/orchestrator/src/worker/types.ts` — extends `WorkerContext` with `phase: WorkflowPhase` and `commitResult: CommitResult`
- [ ] T003 [US1] Add `PhaseAfterHandler` type to `packages/orchestrator/src/worker/types.ts` — `(context: PhaseAfterContext) => Promise<void>`

## Phase 2: Core Implementation

- [ ] T004 [US1] Add `phaseAfterHandlers?: PhaseAfterHandler[]` to `PhaseLoopDeps` interface in `packages/orchestrator/src/worker/phase-loop.ts:20`
- [ ] T005 [US1] Invoke `phaseAfterHandlers` sequentially after `labelManager.onPhaseComplete()` (line ~394) and before gate check (line ~397) in `phase-loop.ts` — iterate with `for...of`, fail-fast on first throw
- [ ] T006 [US1] Pass `phaseAfterHandlers: []` in `PhaseLoopDeps` construction in `packages/orchestrator/src/worker/claude-cli-worker.ts`
- [ ] T007 [P] [US1] Export new types (`PhaseAfterHandler`, `PhaseAfterContext`, `CommitResult`) from `packages/orchestrator/src/worker/index.ts`

## Phase 3: Tests

- [ ] T008 [US1] Add test: register a no-op handler, verify it runs after commit/push and before gate check in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`
- [ ] T009 [US1] Add test: register a handler that throws, verify the phase fails and gate is not checked in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`
- [ ] T010 [US1] Add test: zero handlers registered produces identical behavior (no regression) in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`
- [ ] T011 [P] [US1] Run existing test suite (`pnpm -F @generacy-ai/orchestrator test`) to verify no regressions

## Dependencies & Execution Order

```
T001 → T002 (PhaseAfterContext depends on CommitResult)
T002 → T003 (PhaseAfterHandler depends on PhaseAfterContext)
T003 → T004 (PhaseLoopDeps uses PhaseAfterHandler type)
T004 → T005 (invocation depends on the field existing)
T004 → T006 (passing handlers depends on the field existing)
T005 → T008, T009, T010 (tests depend on implementation)
T007 can run any time after T003 (parallel with T004-T006)
T011 runs after T005+T006 (regression check)
```

**Parallel opportunities**: T006 and T007 are independent of each other after T004. T008/T009/T010 can be written together. T011 is independent of T008-T010.
