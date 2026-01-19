# Tasks: Learning Loop Processor

**Input**: Design documents from `/specs/022-learning-loop-processor/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story/acceptance criteria this task addresses

## Phase 1: Core Types & Repository

- [ ] T001 Define learning loop types in `src/learning/types.ts` (CapturedDecision, CoachingData, LearningEvent, KnowledgeUpdate, LearningResult)
- [ ] T002 [P] Create `src/learning/decision/decision-repository.ts` with DecisionRepository interface
- [ ] T003 Implement `InMemoryDecisionRepository` class in `src/learning/decision/decision-repository.ts`
- [ ] T004 [P] Write unit tests in `tests/learning/decision/decision-repository.test.ts`
- [ ] T005 Create `src/learning/decision/index.ts` module exports

## Phase 2: Decision Capture

- [ ] T006 Implement `DecisionCapture` class in `src/learning/decision/decision-capture.ts`
- [ ] T007 Add decision storage with metadata linking in `DecisionCapture`
- [ ] T008 Implement evidence trail building (link decisions to updates) in `DecisionCapture`
- [ ] T009 Write unit tests in `tests/learning/decision/decision-capture.test.ts`

## Phase 3: Coaching Processing

- [ ] T010 Implement `CoachingProcessor` class in `src/learning/coaching/coaching-processor.ts`
- [ ] T011 Add override reason parsing logic for all 4 cases (reasoning_incorrect, missing_context, priorities_changed, exception_case)
- [ ] T012 [P] Implement `UpdateGenerator` class in `src/learning/coaching/update-generator.ts`
- [ ] T013 [P] Add update generation methods: `createPrincipleRefinement`, `createContextUpdate`, `createPriorityUpdate`
- [ ] T014 Write unit tests in `tests/learning/coaching/coaching-processor.test.ts`
- [ ] T015 [P] Write unit tests in `tests/learning/coaching/update-generator.test.ts`
- [ ] T016 Create `src/learning/coaching/index.ts` module exports

## Phase 4: Update Approval Flow

- [ ] T017 Implement `ApprovalClassifier` class in `src/learning/updates/approval-classifier.ts`
- [ ] T018 Add auto-approve logic for low-impact updates (weight delta < 0.5)
- [ ] T019 Add manual-approve flagging for high-impact updates (new principles, large weight changes)
- [ ] T020 [P] Implement `UpdateQueue` class in `src/learning/updates/update-queue.ts`
- [ ] T021 [P] Add pending updates tracking with approval status
- [ ] T022 Implement configurable thresholds (default: 5+ occurrences, 80%+ consistency)
- [ ] T023 Write unit tests in `tests/learning/updates/approval-classifier.test.ts`
- [ ] T024 [P] Write unit tests in `tests/learning/updates/update-queue.test.ts`
- [ ] T025 Create `src/learning/updates/index.ts` module exports

## Phase 5: Integration & Orchestration

- [ ] T026 Implement `LearningLoopProcessor` class in `src/learning/learning-loop-processor.ts`
- [ ] T027 Wire `processDecision()` method - orchestrate decision capture and learning events
- [ ] T028 Wire `processCoaching()` method - delegate to CoachingProcessor
- [ ] T029 Wire `applyUpdate()` method - emit to knowledge store client interface
- [ ] T030 Define `KnowledgeStoreClient` interface for external integration (#24)
- [ ] T031 Write integration tests in `tests/learning/learning-loop-processor.test.ts`
- [ ] T032 Create `src/learning/index.ts` public exports

## Dependencies & Execution Order

### Sequential Dependencies
1. **T001** must complete before T002, T003 (types needed for repository)
2. **T003** must complete before T006 (repository needed for DecisionCapture)
3. **T006-T008** must complete before T010 (DecisionCapture needed for CoachingProcessor)
4. **T010-T013** must complete before T017 (CoachingProcessor needed for ApprovalClassifier)
5. **T017-T021** must complete before T026 (all components needed for orchestrator)

### Parallel Opportunities
- **Phase 1**: T002 and T004 can run in parallel after T001
- **Phase 3**: T012/T013 and T015 can run in parallel; T014 can run with T015
- **Phase 4**: T020/T21 and T24 can run in parallel with T17-T19/T23

### Phase Boundaries
- Complete Phase 1 before starting Phase 2 (repository foundation)
- Complete Phase 2 before starting Phase 3 (decision capture feeds coaching)
- Complete Phase 3 before starting Phase 4 (coaching generates updates for approval)
- Complete Phase 4 before starting Phase 5 (all components needed for integration)

## Task Summary

| Phase | Tasks | Parallel Tasks |
|-------|-------|----------------|
| Phase 1: Core Types & Repository | 5 | T002, T004 |
| Phase 2: Decision Capture | 4 | - |
| Phase 3: Coaching Processing | 7 | T012, T13, T14, T15 |
| Phase 4: Update Approval Flow | 9 | T20, T21, T24 |
| Phase 5: Integration | 7 | - |
| **Total** | **32** | **9** |
