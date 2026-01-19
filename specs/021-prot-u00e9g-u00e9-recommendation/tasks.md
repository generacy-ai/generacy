# Tasks: Protégé Recommendation Engine

**Input**: Design documents from `/specs/021-protégé-recommendation/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which acceptance criterion this task addresses

## Phase 1: Setup & Types

- [ ] T001 Create `src/recommendation/` directory structure and index.ts exports
- [ ] T002 [P] Create `src/recommendation/types/decision-request.ts` with DecisionRequest, DecisionOption, Constraint types
- [ ] T003 [P] Create `src/recommendation/types/baseline.ts` with BaselineRecommendation, BaselineFactor types
- [ ] T004 [P] Create `src/recommendation/types/recommendation.ts` with ProtegeRecommendation, ReasoningStep, AppliedPrinciple, ContextInfluenceRecord, RecommendationWarning, RecommendationMeta types
- [ ] T005 Create `src/recommendation/types/engine.ts` with ProtegeRecommendationEngine interface, RecommendationOptions, DifferenceExplanation types
- [ ] T006 Create `src/recommendation/types/index.ts` consolidating all type exports

## Phase 2: Core Tests (TDD)

- [ ] T010 [AC1] Create `tests/recommendation/engine/principle-matcher.test.ts` with tests for domain matching, weight ranking, inactive principle filtering
- [ ] T011 [P] [AC4] Create `tests/recommendation/engine/context-integrator.test.ts` with tests for priority checking, constraint application, energy level effects
- [ ] T012 [P] [AC5] Create `tests/recommendation/engine/philosophy-applier.test.ts` with tests for value mapping, boundary enforcement, risk tolerance
- [ ] T013 [P] [AC6] Create `tests/recommendation/engine/reasoning-generator.test.ts` with tests for template generation, principle references
- [ ] T014 [AC8] Create `tests/recommendation/utils/confidence-calculator.test.ts` with confidence formula tests
- [ ] T015 [P] [AC7] Create `tests/recommendation/utils/difference-explainer.test.ts` with baseline comparison tests

## Phase 3: Core Implementation

- [ ] T020 [AC1] [AC2] Implement `src/recommendation/engine/principle-matcher.ts` - PrincipleMatcherService with domain matching, weight ranking, unless exception handling
- [ ] T021 [AC4] Implement `src/recommendation/engine/context-integrator.ts` - ContextIntegratorService with goal checking, constraint awareness, energy level factoring
- [ ] T022 [AC5] Implement `src/recommendation/engine/philosophy-applier.ts` - PhilosophyApplierService with value mapping, boundary enforcement, risk tolerance adjustment
- [ ] T023 [AC6] Implement `src/recommendation/engine/reasoning-generator.ts` - ReasoningGeneratorService with template-based reasoning generation
- [ ] T024 [AC8] Implement `src/recommendation/utils/confidence-calculator.ts` - coverage-based confidence calculation with flagging
- [ ] T025 [AC7] Implement `src/recommendation/utils/difference-explainer.ts` - baseline comparison and explanation generation

## Phase 4: Engine Integration

- [ ] T030 [AC1-8] Implement `src/recommendation/engine/protege-engine.ts` - main ProtegeRecommendationEngine orchestrating all services
- [ ] T031 Create `src/recommendation/engine/index.ts` consolidating engine exports
- [ ] T032 Create `src/recommendation/utils/index.ts` consolidating utility exports
- [ ] T033 Update `src/recommendation/index.ts` with complete public API exports

## Phase 5: Integration Tests & Validation

- [ ] T040 [AC1-8] Create `tests/recommendation/engine/protege-engine.test.ts` with unit tests for engine orchestration
- [ ] T041 [AC3] Create `tests/recommendation/integration/recommendation-flow.test.ts` with full flow tests including conflicting principles scenario
- [ ] T042 Run full test suite and fix any issues (`npm test`)
- [ ] T043 Run linter and fix any issues (`npm run lint`)

## Dependencies & Execution Order

### Phase Dependencies
1. **Phase 1 (Setup)** must complete before Phase 2 and 3
2. **Phase 2 (Tests)** and **Phase 3 (Implementation)** can run in parallel (TDD approach: write tests first, then implementation)
3. **Phase 4 (Integration)** requires Phase 3 completion
4. **Phase 5 (Validation)** requires Phase 4 completion

### Within-Phase Parallel Opportunities
- **Phase 1**: T002, T003, T004 can run in parallel (independent type files)
- **Phase 2**: T010-T015 can run in parallel (independent test files)
- **Phase 3**: T020-T025 must run sequentially (service dependencies) OR can be parallelized if different developers

### Acceptance Criteria Mapping
- **AC1**: Loads and applies individual knowledge stores → T010, T020, T030
- **AC2**: Matches principles to decision domain → T020
- **AC3**: Handles conflicting principles with learned weights → T041
- **AC4**: Applies context (priorities, constraints) → T011, T021
- **AC5**: Respects philosophy (values, boundaries) → T012, T022
- **AC6**: Generates reasoning in terms of human's principles → T013, T023
- **AC7**: Compares with baseline and explains differences → T015, T025
- **AC8**: Confidence reflects certainty of principle application → T014, T024

### File Paths Reference
```
src/recommendation/
├── index.ts                      # T001, T033
├── types/
│   ├── index.ts                  # T006
│   ├── decision-request.ts       # T002
│   ├── baseline.ts               # T003
│   ├── recommendation.ts         # T004
│   └── engine.ts                 # T005
├── engine/
│   ├── index.ts                  # T031
│   ├── protege-engine.ts         # T030
│   ├── principle-matcher.ts      # T020
│   ├── context-integrator.ts     # T021
│   ├── philosophy-applier.ts     # T022
│   └── reasoning-generator.ts    # T023
└── utils/
    ├── index.ts                  # T032
    ├── confidence-calculator.ts  # T024
    └── difference-explainer.ts   # T025

tests/recommendation/
├── engine/
│   ├── protege-engine.test.ts    # T040
│   ├── principle-matcher.test.ts # T010
│   ├── context-integrator.test.ts# T011
│   ├── philosophy-applier.test.ts# T012
│   └── reasoning-generator.test.ts# T013
├── utils/
│   ├── confidence-calculator.test.ts # T014
│   └── difference-explainer.test.ts  # T015
└── integration/
    └── recommendation-flow.test.ts   # T041
```
