# Quickstart: Protégé Recommendation Engine

## Installation

```bash
# From the generacy package (once built)
npm install generacy
```

## Basic Usage

```typescript
import {
  ProtegeRecommendationEngine,
  createDecisionRequest,
  createBaselineRecommendation
} from 'generacy/recommendation';
import { IndividualKnowledge } from '@generacy/knowledge-store';

// Create the engine
const engine = new ProtegeRecommendationEngine();

// Define a decision
const request = createDecisionRequest({
  id: 'decision-001',
  domain: ['career'],
  question: 'Should I accept the job offer?',
  options: [
    {
      id: 'accept',
      name: 'Accept the offer',
      description: 'Take the new position with higher salary',
      attributes: { salary: 150000, commute: '45min' }
    },
    {
      id: 'decline',
      name: 'Decline the offer',
      description: 'Stay in current role',
      attributes: { salary: 120000, commute: '15min' }
    }
  ]
});

// Provide baseline (from objective analysis)
const baseline = createBaselineRecommendation({
  optionId: 'accept',
  reasoning: 'Higher compensation and career growth',
  confidence: 0.8,
  factors: [
    { name: 'salary', contribution: 0.6, explanation: '25% increase' },
    { name: 'growth', contribution: 0.3, explanation: 'Senior role' }
  ]
});

// Load user's knowledge (from knowledge store)
const knowledge: IndividualKnowledge = await loadUserKnowledge(userId);

// Generate personalized recommendation
const recommendation = await engine.generateRecommendation(
  request,
  knowledge,
  baseline
);

console.log('Recommendation:', recommendation.optionId);
console.log('Confidence:', recommendation.confidence);
console.log('Reasoning:', recommendation.reasoning.map(r => r.logic).join('\n'));
```

## Understanding the Output

### ProtegeRecommendation Structure

```typescript
{
  optionId: 'decline',           // The recommended option
  confidence: 0.75,              // How confident (0-1)

  reasoning: [                   // Step-by-step explanation
    {
      step: 1,
      type: 'principle_application',
      principle: {
        principleId: 'p-001',
        principleText: 'Prioritize work-life balance over income'
      },
      logic: 'Based on your principle "Prioritize work-life balance...",
              which you weight at 8/10, the shorter commute aligns better.'
    },
    {
      step: 2,
      type: 'context_override',
      logic: 'Given your current energy level of 4/10, this recommendation
              favors the lower-stress option.'
    }
  ],

  appliedPrinciples: [...],      // All principles that applied
  contextInfluence: [...],       // How context affected result

  differsFromBaseline: true,
  differenceExplanation: 'While the objective analysis favors the higher
                          salary, your principle of prioritizing work-life
                          balance (weight 8/10) overrides the financial gain.'
}
```

## Comparing with Baseline

```typescript
// Get detailed explanation of differences
const explanation = engine.explainDifference(recommendation, baseline);

console.log('Different option:', explanation.differentOption);
console.log('Primary reason:', explanation.primaryReason);
console.log('Driving principles:', explanation.drivingPrinciples);
```

## Handling Energy Levels

```typescript
// Override energy level for this recommendation
const recommendation = await engine.generateRecommendation(
  request,
  knowledge,
  baseline,
  { energyLevel: 3 }  // Low energy
);

// Check for warnings
recommendation.warnings?.forEach(w => {
  if (w.type === 'energy_warning') {
    console.log('⚠️', w.message);
  }
});
```

## Common Patterns

### Multiple Domain Decisions

```typescript
const request = createDecisionRequest({
  domain: ['career', 'finance', 'family'],  // Multiple domains
  // ... rest of request
});

// Engine will match principles from ALL domains
```

### Time-Sensitive Decisions

```typescript
const request = createDecisionRequest({
  deadline: '2026-01-25T00:00:00Z',
  constraints: [
    { type: 'time', value: 5, unit: 'days', hard: true }
  ],
  // ... rest of request
});
```

### Debugging Recommendations

```typescript
const recommendation = await engine.generateRecommendation(
  request,
  knowledge,
  baseline,
  { debug: true }
);

console.log('Principles evaluated:', recommendation.meta.principlesEvaluated);
console.log('Principles matched:', recommendation.meta.principlesMatched);
console.log('Had conflicts:', recommendation.meta.hadConflicts);
console.log('Processing time:', recommendation.meta.processingTimeMs, 'ms');
```

## Error Handling

```typescript
try {
  const recommendation = await engine.generateRecommendation(
    request, knowledge, baseline
  );
} catch (error) {
  if (error instanceof NoPrinciplesMatchedError) {
    // No principles matched the domain - use baseline
    console.log('No personal guidance available, using objective analysis');
  } else if (error instanceof AllOptionsBoundaryViolation) {
    // All options violate user's boundaries
    console.log('Cannot recommend: all options conflict with your values');
  }
}
```

## Troubleshooting

### Low Confidence Recommendations

If confidence is consistently low:
1. Check that principle domains match decision domains
2. Verify principles have meaningful weights (not all 5/10)
3. Ensure context is being provided correctly

### Missing Principle Applications

If expected principles aren't being applied:
1. Verify principle status is 'active'
2. Check domain overlap between principle and request
3. Review principle weight (very low weights may be filtered)

### Unexpected Differences from Baseline

If results differ unexpectedly from baseline:
1. Check `differenceExplanation` for reasoning
2. Review `appliedPrinciples` to see what drove the decision
3. Check `contextInfluence` for context overrides
