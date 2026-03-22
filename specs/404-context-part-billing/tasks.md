# Tasks: Queue Priority for Resume/Retry vs New Workflows

**Input**: Design documents from `/specs/404-context-part-billing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Type & Utility Setup

- [X] T001 Add `QueueReason` type and `queueReason` field to `QueueItem` in `packages/orchestrator/src/types/monitor.ts`
- [X] T002 [P] Create priority score helper `getPriorityScore()` in `packages/orchestrator/src/services/queue-priority.ts`
- [X] T003 [P] Create unit tests for priority helper in `packages/orchestrator/tests/unit/services/queue-priority.test.ts`

## Phase 2: Adapter Updates

- [X] T004 Update `RedisQueueAdapter.enqueue()` to compute priority from `item.queueReason` via `getPriorityScore()` in `packages/orchestrator/src/services/redis-queue-adapter.ts`
- [X] T005 Update `RedisQueueAdapter.claim()` to include `queueReason` in returned QueueItem in `packages/orchestrator/src/services/redis-queue-adapter.ts`
- [X] T006 Update `RedisQueueAdapter.release()` to set `queueReason: 'retry'` and use `getPriorityScore('retry')` on re-queue in `packages/orchestrator/src/services/redis-queue-adapter.ts`
- [X] T007 [P] Update `InMemoryQueueAdapter.enqueue()` to compute priority from `item.queueReason` via `getPriorityScore()` in `packages/orchestrator/src/services/in-memory-queue-adapter.ts`
- [X] T008 [P] Update `InMemoryQueueAdapter.claim()` to include `queueReason` in returned QueueItem in `packages/orchestrator/src/services/in-memory-queue-adapter.ts`
- [X] T009 [P] Update `InMemoryQueueAdapter.release()` to set `queueReason: 'retry'` and use `getPriorityScore('retry')` on re-queue in `packages/orchestrator/src/services/in-memory-queue-adapter.ts`

## Phase 3: Enqueue Site Updates

- [X] T010 [P] Update `LabelMonitorService.processLabelEvent()` (~line 303) to set `queueReason: 'new'` for process events and `queueReason: 'resume'` for continue events in `packages/orchestrator/src/services/label-monitor-service.ts`
- [X] T011 [P] Update `PrFeedbackMonitorService.processPrReviewEvent()` (~line 202) to set `queueReason: 'resume'` in `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`

## Phase 4: Integration Tests

- [X] T012 [P] Add priority ordering tests to `packages/orchestrator/tests/unit/services/redis-queue-adapter.test.ts` — enqueue resume/retry/new items and verify claim order
- [X] T013 [P] Add priority ordering tests to `packages/orchestrator/tests/unit/services/in-memory-queue-adapter.test.ts` — enqueue resume/retry/new items and verify claim order
- [X] T014 Add backwards-compatibility test: enqueue item with no `queueReason`, verify it gets `Date.now()` priority (in either adapter test file)

## Dependencies & Execution Order

**Phase 1** (Setup):
- T001 must complete first — T002/T003 depend on the `QueueReason` type export
- T002 and T003 can run in parallel once T001 is done

**Phase 2** (Adapters):
- All tasks depend on T001 (type) and T002 (helper function)
- T004/T005/T006 (Redis adapter) can run in parallel with T007/T008/T009 (in-memory adapter)

**Phase 3** (Enqueue sites):
- T010 and T011 depend on T001 (type) but not on adapter changes
- T010 and T011 can run in parallel with each other

**Phase 4** (Tests):
- T012 depends on T004/T005/T06 (Redis adapter changes)
- T013 depends on T007/T08/T009 (in-memory adapter changes)
- T012 and T013 can run in parallel
- T014 depends on adapter changes from Phase 2

**Parallel opportunities**: Phases 2 and 3 can run concurrently. Within Phase 2, Redis and in-memory adapter work is independent. Within Phase 4, both adapter test files can be worked simultaneously.
