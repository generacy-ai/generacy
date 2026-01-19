# Feature Specification: Attribution calculation engine

**Branch**: `023-attribution-calculation-engine` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

## Summary

Implement the attribution calculation engine - the component that determines which layer (baseline, protégé, or human) added value in each decision.

## Parent Epic

#2 - Generacy Core Package

## Dependencies

- generacy-ai/contracts - Attribution and metrics schemas
- generacy-ai/contracts - Three-layer decision model schemas

## Purpose

Attribution is core to Humancy's value proposition. By tracking which layer was right, we can:
- Measure human value objectively
- Demonstrate protégé learning
- Generate marketable metrics
- Justify human-in-the-loop costs

## Attribution Model

| Scenario | Attribution | Interpretation |
|----------|-------------|----------------|
| B = P = H ✓ | All aligned | System was right, no unique contribution |
| B = P ≠ H ✓ | Human unique | Human added value baseline/protégé missed |
| B ≠ P = H ✓ | Protégé value | Human's trained wisdom proved valuable |
| B ≠ P ≠ H ✓ | Both added | Collaboration was key |
| B ✓, P ≠ B | Protégé wrong | Protégé diverged incorrectly |
| P ✓, H ≠ P | Human wrong | Human override was incorrect |

## Implementation

### AttributionCalculator
```typescript
interface AttributionCalculator {
  // Calculate attribution after outcome is known
  calculateAttribution(
    decision: ThreeLayerDecision,
    outcome: DecisionOutcome
  ): Attribution;
  
  // Aggregate attributions into metrics
  aggregateMetrics(
    userId: string,
    attributions: Attribution[],
    period: MetricsPeriod
  ): IndividualMetrics;
}

interface Attribution {
  decisionId: string;
  
  // Which layer was correct
  baselineCorrect: boolean | null;
  protegeCorrect: boolean | null;
  humanCorrect: boolean | null;
  
  // Attribution category
  whoWasRight: 'baseline' | 'protege' | 'human_unique' | 'all_aligned' | 'unknown';
  
  // Value source
  valueSource: 'system' | 'protege_wisdom' | 'human_judgment' | 'collaboration' | 'none';
  
  // Counterfactual analysis
  baselineAlternativeOutcome?: string;
  protegeAlternativeOutcome?: string;
}
```

### Outcome Evaluation
```typescript
interface OutcomeEvaluator {
  // Evaluate if a decision option would have worked
  evaluateOutcome(
    decision: DecisionRequest,
    chosenOption: string,
    actualOutcome: string
  ): OutcomeAssessment;
  
  // Counterfactual: would another option have worked better?
  evaluateCounterfactual(
    decision: DecisionRequest,
    actualChoice: string,
    alternativeChoice: string,
    actualOutcome: string
  ): CounterfactualAssessment;
}

interface OutcomeAssessment {
  worked: boolean | null;  // null = unknown
  confidence: number;
  evidence: string[];
}
```

### Metrics Aggregation
```typescript
interface MetricsAggregator {
  // Calculate core metrics for a user
  calculate(
    userId: string,
    decisions: ThreeLayerDecision[],
    attributions: Attribution[],
    period: MetricsPeriod
  ): IndividualMetrics;
}

// Core calculations
const interventionRate = overrideCount / totalDecisions;
const additiveValue = (protegeCorrect + humanUniqueCorrect) / totalDecisions;
const protegeStandalone = protegeCorrect / totalDecisions;
const uniqueHuman = humanUniqueCorrect / totalDecisions;
```

## Features

### Outcome Tracking
- Link decisions to outcomes
- Capture success/failure/partial
- Handle delayed outcome validation

### Counterfactual Analysis
- "Would baseline have worked?"
- "Would protégé have worked?"
- Estimate alternative outcomes

### Attribution Calculation
- Classify each decision into attribution category
- Handle uncertainty (null/unknown)
- Weight by decision importance

### Metrics Aggregation
- Intervention rate per period
- Additive value calculation
- Domain breakdown
- Volume metrics
- Trend detection

### Reporting
- Generate IndividualMetrics
- Calculate domain breakdowns
- Identify strongest/weakest areas
- Generate exportable reports

## Edge Cases

### Unknown Outcomes
- Some decisions can't be validated
- Track as "unknown" in attribution
- Exclude from confidence metrics

### Multiple Correct Options
- Sometimes baseline AND human are both valid
- Attribution: "all_aligned" with note

### Delayed Outcomes
- Some outcomes take months to validate
- Support async outcome recording
- Recalculate metrics when outcomes arrive

## Acceptance Criteria

- [ ] Calculates attribution for each decision
- [ ] Handles all attribution scenarios (aligned, unique, etc.)
- [ ] Performs counterfactual analysis
- [ ] Aggregates into intervention rate metric
- [ ] Calculates additive value
- [ ] Calculates protégé standalone value
- [ ] Calculates unique human contribution
- [ ] Breaks down by domain
- [ ] Handles unknown/delayed outcomes
- [ ] Generates exportable metrics reports

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
