# Quickstart: Attribution Calculation Engine

## Installation

The attribution engine is part of the `@generacy/core` package:

```bash
npm install @generacy/core
```

## Basic Usage

### 1. Calculate Attribution for a Decision

```typescript
import {
  AttributionCalculator,
  createAttributionCalculator,
  ThreeLayerDecision,
  DecisionOutcome
} from '@generacy/core';

// Create the calculator
const calculator = createAttributionCalculator();

// Given a decision and its outcome
const decision: ThreeLayerDecision = {
  id: 'decision-123',
  request: { /* DecisionRequest */ },
  baseline: { optionId: 'A', confidence: 85, /* ... */ },
  protege: { optionId: 'A', confidence: 90, /* ... */ },
  humanChoice: { optionId: 'B', wasOverride: true, userId: 'user-1' },
  decidedAt: new Date()
};

const outcome: DecisionOutcome = {
  decisionId: 'decision-123',
  result: { status: 'success', details: 'Option B worked well' },
  recordedAt: new Date(),
  evidence: ['Customer satisfaction increased', 'No incidents reported']
};

// Calculate attribution
const attribution = calculator.calculateAttribution(decision, outcome);

console.log(attribution.whoWasRight);  // 'human_unique'
console.log(attribution.valueSource);  // 'human_judgment'
```

### 2. Aggregate Metrics for a User

```typescript
import { MetricsAggregator, createMetricsAggregator } from '@generacy/core';

const aggregator = createMetricsAggregator();

// Given multiple decisions and their attributions
const decisions: ThreeLayerDecision[] = [/* ... */];
const attributions: Attribution[] = [/* ... */];

const metrics = aggregator.calculate(
  'user-1',
  decisions,
  attributions,
  { start: new Date('2024-01-01'), end: new Date('2024-01-31'), type: 'month' }
);

console.log(`Intervention Rate: ${(metrics.interventionRate * 100).toFixed(1)}%`);
console.log(`Additive Value: ${(metrics.additiveValue * 100).toFixed(1)}%`);
console.log(`Unique Human Contribution: ${(metrics.uniqueHuman * 100).toFixed(1)}%`);
```

### 3. Counterfactual Analysis

```typescript
import { CounterfactualAnalyzer, createCounterfactualAnalyzer } from '@generacy/core';

const analyzer = createCounterfactualAnalyzer();

// Analyze what would have happened with baseline
const baselineCounterfactual = analyzer.analyzeBaseline(decision, outcome);

if (baselineCounterfactual.wouldHaveWorked === false) {
  console.log('Human override prevented: ' + baselineCounterfactual.reasoning);
}
```

### 4. Generate Reports

```typescript
import { ReportGenerator, createReportGenerator } from '@generacy/core';

const reportGen = createReportGenerator();

// Generate a JSON report
const report = reportGen.generateReport(metrics, 'json');

// Get domain breakdown
const breakdown = reportGen.generateDomainBreakdown(metrics);
breakdown.forEach(domain => {
  console.log(`${domain.domain}: ${(domain.additiveValue * 100).toFixed(1)}% additive value`);
});
```

## Available Commands

### Attribution Calculator
| Method | Description |
|--------|-------------|
| `calculateAttribution(decision, outcome)` | Calculate attribution for a single decision |
| `aggregateMetrics(userId, attributions, period)` | Aggregate attributions into user metrics |

### Outcome Evaluator
| Method | Description |
|--------|-------------|
| `evaluateOutcome(decision, chosenOption, outcome)` | Evaluate if a choice worked |
| `evaluateCounterfactual(decision, actual, alternative, outcome)` | Evaluate an alternative choice |

### Metrics Aggregator
| Method | Description |
|--------|-------------|
| `calculate(userId, decisions, attributions, period)` | Calculate all metrics |
| `calculateByDomain(userId, attributions, domain)` | Calculate metrics for a specific domain |

### Report Generator
| Method | Description |
|--------|-------------|
| `generateReport(metrics, format)` | Generate exportable report |
| `generateDomainBreakdown(metrics)` | Get per-domain metrics |

## Configuration Options

```typescript
interface AttributionConfig {
  /** Minimum confidence threshold for counterfactuals (0-1) */
  counterfactualConfidenceThreshold: number;

  /** Whether to include detailed counterfactual analysis */
  includeCounterfactual: boolean;

  /** Domains to exclude from domain breakdown */
  excludedDomains: string[];
}

const config: AttributionConfig = {
  counterfactualConfidenceThreshold: 0.5,
  includeCounterfactual: true,
  excludedDomains: []
};

const calculator = createAttributionCalculator(config);
```

## Troubleshooting

### "Unknown" Attribution Results
If `whoWasRight` returns `'unknown'`:
- Check that `DecisionOutcome.result.status` is not `'unknown'`
- Ensure the outcome has sufficient evidence
- Verify the decision has valid option IDs

### Missing Domain Breakdown
If domain metrics are empty:
- Verify `DecisionRequest.context.domain` is set on decisions
- Check that decisions are not filtered by `excludedDomains` config

### Low Confidence Attributions
If `attribution.confidence` is low:
- Provide more evidence in `DecisionOutcome.evidence`
- Ensure outcome status is definitive (`'success'` or `'failure'`, not `'partial'`)

## Examples Repository

See full examples in `examples/attribution/`:
- `basic-attribution.ts` - Simple attribution calculation
- `metrics-dashboard.ts` - Building a metrics dashboard
- `counterfactual-report.ts` - Generating counterfactual reports
