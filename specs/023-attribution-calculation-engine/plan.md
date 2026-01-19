# Implementation Plan: Attribution Calculation Engine

**Feature**: Attribution calculation engine - determines which layer (baseline, protégé, or human) added value in each decision
**Branch**: `023-attribution-calculation-engine`
**Status**: Complete

## Summary

Build the attribution calculation engine that analyzes decisions post-outcome to determine which layer (baseline, protégé, or human) was correct. This enables measuring human value objectively, demonstrating protégé learning, and generating marketable metrics for the three-layer decision system.

## Technical Context

| Aspect | Details |
|--------|---------|
| Language | TypeScript (ESM modules) |
| Runtime | Node.js |
| Testing | Vitest |
| Package | `@generacy/core` (internal module) |
| Dependencies | Internal types from `src/recommendation/types`, `src/baseline/types` |

## Project Structure

```
src/
├── attribution/
│   ├── index.ts                      # Public exports
│   ├── types.ts                      # Attribution-specific types
│   ├── attribution-calculator.ts     # Main calculator implementation
│   ├── outcome-evaluator.ts          # Outcome assessment logic
│   ├── counterfactual-analyzer.ts    # Counterfactual analysis
│   ├── metrics-aggregator.ts         # Metrics aggregation service
│   └── report-generator.ts           # Exportable reports
tests/
├── attribution/
│   ├── attribution-calculator.test.ts
│   ├── outcome-evaluator.test.ts
│   ├── counterfactual-analyzer.test.ts
│   ├── metrics-aggregator.test.ts
│   └── report-generator.test.ts
```

## Core Components

### 1. AttributionCalculator
The main entry point for attribution calculation.

**Responsibilities:**
- Calculate attribution after outcome is known
- Classify decisions into attribution categories
- Handle uncertainty (null/unknown outcomes)
- Weight by decision importance

**Key Methods:**
- `calculateAttribution(decision, outcome)` → Attribution
- `aggregateMetrics(userId, attributions, period)` → IndividualMetrics

### 2. OutcomeEvaluator
Evaluates whether a decision option was correct.

**Responsibilities:**
- Evaluate if chosen option worked
- Assess success/failure/partial outcomes
- Track confidence in evaluations

**Key Methods:**
- `evaluateOutcome(decision, chosenOption, actualOutcome)` → OutcomeAssessment
- `evaluateCounterfactual(decision, actual, alternative, outcome)` → CounterfactualAssessment

### 3. CounterfactualAnalyzer
Analyzes what would have happened with different choices.

**Responsibilities:**
- Estimate baseline alternative outcome
- Estimate protégé alternative outcome
- Support "what if" analysis

**Key Methods:**
- `analyzeBaseline(decision, outcome)` → CounterfactualResult
- `analyzeProtege(decision, outcome)` → CounterfactualResult

### 4. MetricsAggregator
Aggregates attributions into meaningful metrics.

**Responsibilities:**
- Calculate intervention rate
- Calculate additive value
- Calculate protégé standalone value
- Calculate unique human contribution
- Break down by domain
- Detect trends

**Key Methods:**
- `calculate(userId, decisions, attributions, period)` → IndividualMetrics
- `calculateByDomain(userId, attributions, domain)` → DomainMetrics

### 5. ReportGenerator
Creates exportable reports from metrics.

**Responsibilities:**
- Generate IndividualMetrics reports
- Create domain breakdowns
- Identify strongest/weakest areas
- Format for export (JSON, summary)

**Key Methods:**
- `generateReport(metrics, format)` → Report
- `generateDomainBreakdown(metrics)` → DomainBreakdown[]

## Attribution Categories

| Category | Condition | Value Source |
|----------|-----------|--------------|
| `all_aligned` | B = P = H, all correct | `system` |
| `human_unique` | B = P ≠ H, human correct | `human_judgment` |
| `protege_wisdom` | B ≠ P = H, protégé/human correct | `protege_wisdom` |
| `collaboration` | B ≠ P ≠ H, human correct | `collaboration` |
| `baseline_only` | B ✓, P/H wrong | `system` |
| `unknown` | Outcome cannot be determined | `none` |

## Key Metrics Formulas

```typescript
interventionRate = overrideCount / totalDecisions
additiveValue = (protegeCorrect + humanUniqueCorrect) / totalDecisions
protegeStandalone = protegeCorrect / totalDecisions
uniqueHuman = humanUniqueCorrect / totalDecisions
```

## Edge Case Handling

### Unknown Outcomes
- Track as `unknown` in attribution
- Exclude from confidence metrics
- Still count in total decisions

### Multiple Correct Options
- Classify as `all_aligned`
- Note in attribution metadata

### Delayed Outcomes
- Support async outcome recording
- Recalculate metrics when outcomes arrive
- Track pending outcome decisions

## Integration Points

| Component | Interaction |
|-----------|-------------|
| `ThreeLayerDecision` | Input - decision with all three layer choices |
| `DecisionOutcome` | Input - actual outcome after decision |
| `IndividualMetrics` | Output - aggregated metrics per user |
| `BaselineRecommendation` | Reference - baseline layer choice |
| `ProtegeRecommendation` | Reference - protégé layer choice |

## Implementation Order

1. **Types & Interfaces** - Define Attribution, OutcomeAssessment, etc.
2. **OutcomeEvaluator** - Basic outcome assessment
3. **AttributionCalculator** - Core attribution logic
4. **CounterfactualAnalyzer** - What-if analysis
5. **MetricsAggregator** - Metrics calculation
6. **ReportGenerator** - Export capabilities
7. **Integration** - Wire up with existing types

## Testing Strategy

- Unit tests for each component
- Integration tests for full attribution flow
- Edge case coverage for unknown/delayed outcomes
- Property-based tests for metrics calculations

## Success Criteria

- [ ] All acceptance criteria from spec met
- [ ] 90%+ test coverage on new code
- [ ] Types properly exported from module
- [ ] Integration with existing recommendation types
