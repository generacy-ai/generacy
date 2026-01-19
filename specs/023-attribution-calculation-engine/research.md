# Research: Attribution Calculation Engine

## Technology Decisions

### 1. Pure TypeScript Implementation
**Decision**: Implement as pure TypeScript module with no external dependencies.

**Rationale**:
- Matches existing codebase patterns (see `src/recommendation/`, `src/baseline/`)
- Attribution logic is domain-specific, no generic library fits
- Keeps bundle size minimal
- Enables full control over attribution algorithms

**Alternatives Considered**:
- External analytics library → Overkill, doesn't fit attribution semantics
- Database-backed calculations → Over-engineered, metrics can be computed in-memory

### 2. Functional Core with Service Interfaces
**Decision**: Use service interfaces with functional implementation.

**Rationale**:
- Consistent with `ProtegeRecommendationEngine`, `BaselineGenerator` patterns
- Enables easy testing through dependency injection
- Supports future async operations (delayed outcomes)

**Pattern Example**:
```typescript
interface AttributionCalculator {
  calculateAttribution(decision: ThreeLayerDecision, outcome: DecisionOutcome): Attribution;
}

// Implementation as class with injected dependencies
class DefaultAttributionCalculator implements AttributionCalculator {
  constructor(
    private outcomeEvaluator: OutcomeEvaluator,
    private counterfactualAnalyzer: CounterfactualAnalyzer
  ) {}
}
```

### 3. Immutable Data Structures
**Decision**: All attribution data is immutable.

**Rationale**:
- Prevents accidental mutation of historical data
- Enables safe concurrent access
- Matches functional paradigm of metrics calculation

### 4. Explicit Uncertainty Handling
**Decision**: Use `null` for unknown outcomes, not special values.

**Rationale**:
- TypeScript's strict null checks enforce handling
- Clearer than magic values like `-1` or `'unknown'`
- Spec explicitly mentions `null` for unknown outcomes

## Implementation Patterns

### Attribution Category Determination

```typescript
function determineCategory(
  baselineCorrect: boolean | null,
  protegeCorrect: boolean | null,
  humanCorrect: boolean | null
): AttributionCategory {
  // Handle unknown outcomes
  if (humanCorrect === null) return 'unknown';

  // All aligned and correct
  if (baselineCorrect === humanCorrect && protegeCorrect === humanCorrect && humanCorrect) {
    return 'all_aligned';
  }

  // Human unique value
  if (baselineCorrect === protegeCorrect && baselineCorrect !== humanCorrect && humanCorrect) {
    return 'human_unique';
  }

  // Protégé wisdom (trained from human)
  if (baselineCorrect !== protegeCorrect && protegeCorrect === humanCorrect && humanCorrect) {
    return 'protege_wisdom';
  }

  // Collaboration - all different but human correct
  if (baselineCorrect !== protegeCorrect && protegeCorrect !== humanCorrect && humanCorrect) {
    return 'collaboration';
  }

  // Handle incorrect human choices...
  return deriveIncorrectCategory(baselineCorrect, protegeCorrect, humanCorrect);
}
```

### Metrics Aggregation Pattern

```typescript
function aggregateMetrics(attributions: Attribution[]): IndividualMetrics {
  const total = attributions.length;
  const validOutcomes = attributions.filter(a => a.whoWasRight !== 'unknown');

  return {
    totalDecisions: total,
    validOutcomes: validOutcomes.length,
    interventionRate: calculateInterventionRate(attributions),
    additiveValue: calculateAdditiveValue(validOutcomes),
    protegeStandalone: calculateProtegeStandalone(validOutcomes),
    uniqueHuman: calculateUniqueHuman(validOutcomes),
  };
}
```

### Counterfactual Analysis Approach

For each decision, estimate what would have happened:

1. **Baseline counterfactual**: If human had not intervened, what would baseline have produced?
2. **Protégé counterfactual**: If human had followed protégé, what would have happened?

```typescript
interface CounterfactualResult {
  alternativeOutcome: string;
  wouldHaveWorked: boolean | null;
  confidence: number;
  reasoning: string;
}
```

## Key Sources/References

### Existing Codebase Patterns
- `src/baseline/baseline-generator.ts` - Service pattern with configuration
- `src/recommendation/engine/protege-engine.ts` - Multi-component engine design
- `src/recommendation/types/` - Type organization pattern

### Domain Concepts
- Three-layer decision model from spec
- Attribution table from issue #23
- Metrics formulas from issue body

## Open Questions

### Q1: Outcome Storage
**Question**: Where do outcomes get stored between decision and attribution?

**Resolution**: Out of scope for this feature. Attribution calculator receives `DecisionOutcome` as input - storage is handled elsewhere.

### Q2: Partial Outcomes
**Question**: How to handle partial success (e.g., "mostly worked")?

**Resolution**: `OutcomeAssessment.worked` can be `boolean | null`. Partial outcomes may set confidence lower. Exact semantics left to implementation.

### Q3: Domain Classification
**Question**: How are decisions classified into domains?

**Resolution**: Decisions include domain metadata from `DecisionRequest.context.domain`. Attribution inherits this for domain breakdowns.
