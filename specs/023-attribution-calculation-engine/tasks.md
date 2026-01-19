# Tasks: Attribution Calculation Engine

**Input**: Design documents from `/specs/023-attribution-calculation-engine/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story/acceptance criteria this task addresses

## Phase 1: Setup & Types

- [ ] T001 Create `src/attribution/` directory structure
- [ ] T002 [P] Create `src/attribution/types.ts` with all core types (Attribution, AttributionCategory, ValueSource, OutcomeAssessment, CounterfactualAnalysis, CounterfactualResult)
- [ ] T003 [P] Create `src/attribution/index.ts` with public exports
- [ ] T004 [P] Create `tests/attribution/` directory structure

## Phase 2: Tests First

- [ ] T010 Create `tests/attribution/outcome-evaluator.test.ts` with test cases for:
  - Evaluating success outcomes
  - Evaluating failure outcomes
  - Evaluating partial outcomes
  - Handling unknown outcomes
  - Counterfactual evaluation
- [ ] T011 [P] Create `tests/attribution/attribution-calculator.test.ts` with test cases for:
  - All attribution scenarios (all_aligned, human_unique, protege_wisdom, collaboration)
  - Incorrect scenarios (baseline_only, protege_wrong, human_wrong, all_wrong)
  - Unknown/null outcome handling
  - Confidence calculation
- [ ] T012 [P] Create `tests/attribution/counterfactual-analyzer.test.ts` with test cases for:
  - Baseline counterfactual analysis
  - Protégé counterfactual analysis
  - Confidence scoring
- [ ] T013 [P] Create `tests/attribution/metrics-aggregator.test.ts` with test cases for:
  - Intervention rate calculation
  - Additive value calculation
  - Protégé standalone value
  - Unique human contribution
  - Domain breakdown
  - Trend detection
- [ ] T014 [P] Create `tests/attribution/report-generator.test.ts` with test cases for:
  - JSON report generation
  - Summary report generation
  - Domain breakdown report
  - Strongest/weakest areas identification

## Phase 3: Core Implementation

- [ ] T020 Implement `src/attribution/outcome-evaluator.ts`:
  - `OutcomeEvaluator` interface
  - `DefaultOutcomeEvaluator` class
  - `evaluateOutcome()` method - assess if chosen option worked
  - `evaluateCounterfactual()` method - assess alternative outcomes
- [ ] T021 Implement `src/attribution/counterfactual-analyzer.ts`:
  - `CounterfactualAnalyzer` interface
  - `DefaultCounterfactualAnalyzer` class
  - `analyzeBaseline()` method - estimate baseline alternative
  - `analyzeProtege()` method - estimate protégé alternative
- [ ] T022 Implement `src/attribution/attribution-calculator.ts`:
  - `AttributionCalculator` interface
  - `DefaultAttributionCalculator` class with injected OutcomeEvaluator and CounterfactualAnalyzer
  - `calculateAttribution()` method - main attribution logic
  - `determineCategory()` helper - classify into AttributionCategory
  - `determineValueSource()` helper - identify ValueSource
  - Handle all 6 attribution scenarios from spec

## Phase 4: Metrics & Reporting

- [ ] T030 Implement `src/attribution/metrics-aggregator.ts`:
  - `MetricsAggregator` interface
  - `DefaultMetricsAggregator` class
  - `calculate()` method - compute IndividualMetrics from attributions
  - `calculateByDomain()` method - domain-level metrics
  - `calculateTrends()` helper - detect trend directions
  - Formula implementations: interventionRate, additiveValue, protegeStandalone, uniqueHuman
- [ ] T031 Implement `src/attribution/report-generator.ts`:
  - `ReportGenerator` interface
  - `DefaultReportGenerator` class
  - `generateReport()` method - create exportable reports (JSON, summary)
  - `generateDomainBreakdown()` method - per-domain analysis
  - `identifyStrengths()` and `identifyWeaknesses()` helpers

## Phase 5: Integration

- [ ] T040 Update `src/attribution/index.ts` with all public exports:
  - All interfaces (AttributionCalculator, OutcomeEvaluator, MetricsAggregator, ReportGenerator)
  - All default implementations
  - All types
- [ ] T041 [P] Create factory functions in `src/attribution/index.ts`:
  - `createAttributionCalculator()` - creates fully wired calculator
  - `createMetricsAggregator()` - creates metrics aggregator
  - `createReportGenerator()` - creates report generator
- [ ] T042 [P] Add integration tests in `tests/attribution/integration.test.ts`:
  - Full flow: decision → outcome → attribution → metrics → report
  - Edge cases: delayed outcomes, unknown outcomes, multiple domains

## Phase 6: Polish

- [ ] T050 Verify all tests pass with `npm test`
- [ ] T051 [P] Verify lint passes with `npm run lint`
- [ ] T052 [P] Verify 90%+ test coverage on `src/attribution/`
- [ ] T053 Review exports match acceptance criteria from spec

## Dependencies & Execution Order

**Sequential dependencies:**
- T001 → T002, T003, T004 (directory must exist first)
- T010-T014 → T020-T022 (tests before implementation, TDD)
- T020-T021 → T022 (calculator depends on evaluator and analyzer)
- T020-T022 → T030-T031 (metrics/reports depend on core)
- T030-T031 → T040-T042 (integration depends on all components)
- T040-T042 → T050-T053 (polish depends on integration)

**Parallel opportunities:**
- T002, T003, T004 can run in parallel after T001
- T010-T014 can all run in parallel (independent test files)
- T041, T042 can run in parallel after T040
- T051, T052 can run in parallel after T050

**Phase boundaries:**
- Complete Phase 1 (setup) before Phase 2 (tests)
- Complete Phase 2 (tests) before Phase 3 (core)
- Complete Phase 3 (core) before Phase 4 (metrics)
- Complete Phase 4 (metrics) before Phase 5 (integration)
- Complete Phase 5 (integration) before Phase 6 (polish)
