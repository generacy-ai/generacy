# Implementation Plan: Learning Loop Processor

**Feature**: Learning Loop Processor - processes human decisions and coaching into knowledge updates
**Branch**: `022-learning-loop-processor`
**Status**: Complete

## Summary

The Learning Loop Processor is the component that processes human decisions (especially overrides) and coaching into knowledge updates. It captures decisions, processes coaching data, and generates knowledge updates for principle reinforcement/refinement.

Based on clarification decisions:
- **MVP Scope**: Core learning only (decision capture + coaching processing)
- **Pattern detection**: Deferred to later iteration
- **Storage**: Repository pattern with pluggable backend (in-memory for MVP)
- **Knowledge Store**: Delegates to #24 Knowledge Store Management API

## Technical Context

| Aspect | Value |
|--------|-------|
| Language | TypeScript |
| Runtime | Node.js >= 20.0.0 |
| Build | TypeScript compiler (tsc) |
| Test | Vitest |
| Module | ESM (type: "module") |
| Lint | ESLint with @typescript-eslint |

### Dependencies

**Internal**:
- `src/recommendation/types/knowledge.ts` - Knowledge store types (Principle, Pattern, IndividualKnowledge)
- `src/recommendation/types/recommendation.ts` - ProtegeRecommendation types
- `src/baseline/types.ts` - DecisionRequest, BaselineRecommendation types

**External (deferred)**:
- `@generacy/contracts` - Learning loop and coaching schemas (when available)
- Knowledge Store Management (#24) - Storage API

## Project Structure

```
src/
  learning/
    index.ts                    # Public exports
    types.ts                    # Learning loop types
    learning-loop-processor.ts  # Main processor implementation
    coaching/
      index.ts                  # Coaching module exports
      coaching-processor.ts     # Processes coaching data into updates
      update-generator.ts       # Generates KnowledgeUpdate objects
    decision/
      index.ts                  # Decision module exports
      decision-capture.ts       # Captures and stores decisions
      decision-repository.ts    # Repository interface + in-memory impl
    updates/
      index.ts                  # Updates module exports
      update-queue.ts           # Queues updates for approval
      approval-classifier.ts    # Classifies updates as auto/manual approve

tests/
  learning/
    learning-loop-processor.test.ts
    coaching/
      coaching-processor.test.ts
      update-generator.test.ts
    decision/
      decision-capture.test.ts
      decision-repository.test.ts
    updates/
      update-queue.test.ts
      approval-classifier.test.ts
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                  LearningLoopProcessor                       │
│                                                              │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ DecisionCapture │───>│       CoachingProcessor         │ │
│  │                 │    │                                 │ │
│  │ - Store decision│    │ - Parse override reasons        │ │
│  │ - Link to update│    │ - Extract learning              │ │
│  │ - Build evidence│    │ - Generate updates              │ │
│  └────────┬────────┘    └────────────────┬────────────────┘ │
│           │                              │                   │
│           v                              v                   │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              DecisionRepository                         │ │
│  │  (Repository pattern - InMemoryDecisionRepository)      │ │
│  └────────────────────────────────────────────────────────┘ │
│                              │                               │
│                              v                               │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ ApprovalClass-  │<───│          UpdateQueue            │ │
│  │   ifier         │    │                                 │ │
│  │                 │    │ - Queue pending updates         │ │
│  │ - Auto-approve  │    │ - Track approval status         │ │
│  │   low-impact    │    │ - Emit to knowledge store       │ │
│  │ - Flag high-    │    │                                 │ │
│  │   impact        │    │                                 │ │
│  └─────────────────┘    └─────────────────────────────────┘ │
│                              │                               │
│                              v                               │
│                    ┌─────────────────┐                      │
│                    │ Knowledge Store │ (External - #24)     │
│                    │      API        │                      │
│                    └─────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Core Types & Repository (MVP Foundation)
1. Define learning loop types in `types.ts`
2. Implement `DecisionRepository` interface
3. Implement `InMemoryDecisionRepository`
4. Unit tests for repository

### Phase 2: Decision Capture
1. Implement `DecisionCapture` class
2. Store decisions with metadata
3. Link decisions to knowledge updates
4. Unit tests for decision capture

### Phase 3: Coaching Processing
1. Implement `CoachingProcessor` class
2. Parse override reasons (reasoning_incorrect, missing_context, priorities_changed, exception_case)
3. Implement `UpdateGenerator` to create `KnowledgeUpdate` objects
4. Unit tests for coaching processing

### Phase 4: Update Approval Flow
1. Implement `ApprovalClassifier` (auto vs manual approval)
2. Implement `UpdateQueue` for pending updates
3. Configure thresholds for auto-approval
4. Unit tests for approval flow

### Phase 5: Integration
1. Implement `LearningLoopProcessor` orchestrator
2. Wire up all components
3. Integration tests
4. Export public API

## Key Design Decisions

### 1. Repository Pattern for Storage
- Abstract storage behind `DecisionRepository` interface
- Start with `InMemoryDecisionRepository` for MVP
- Enables future swap to Redis, Neo4j, or other backends

### 2. Configurable Thresholds
- Default thresholds: 5+ occurrences, 80%+ consistency
- Can be overridden per domain or user
- Stored in configuration, not hardcoded

### 3. Auto-Approve Classification
Based on clarification answer:
- **Auto-approve**: Principle reinforcements with small weight changes (< 0.5)
- **Require approval**: New principles, weight changes >= 0.5, domain changes

### 4. Knowledge Store Integration
- Processor generates `KnowledgeUpdate` objects
- Delegates storage to Knowledge Store API (#24)
- Clear interface boundary via `KnowledgeStoreClient` interface

## Out of Scope (MVP)

- Pattern detection algorithms
- Statistical analysis of decision history
- Real-time pattern streaming
- Multi-tenant isolation

## Testing Strategy

- Unit tests for each component
- Integration tests for processor flow
- Mock `KnowledgeStoreClient` for isolation
- Test override reason handling for each case

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Knowledge Store API not ready | Use mock client, define clear interface |
| Complex coaching parsing | Start with structured override reasons |
| Threshold tuning | Make all thresholds configurable |

## Next Steps

1. Run `/speckit:tasks` to generate detailed task list
2. Implement Phase 1 (Core Types & Repository)
3. Iterate through remaining phases
