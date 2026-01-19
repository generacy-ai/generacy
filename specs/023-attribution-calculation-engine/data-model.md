# Data Model: Attribution Calculation Engine

## Core Entities

### ThreeLayerDecision
Represents a complete decision with all three layer choices.

```typescript
interface ThreeLayerDecision {
  /** Unique decision identifier */
  id: string;

  /** Original decision request */
  request: DecisionRequest;

  /** Baseline layer recommendation */
  baseline: BaselineRecommendation;

  /** Protégé layer recommendation */
  protege: ProtegeRecommendation;

  /** Human's final choice */
  humanChoice: HumanDecision;

  /** Timestamp of the final decision */
  decidedAt: Date;
}

interface HumanDecision {
  /** ID of the chosen option */
  optionId: string;

  /** Whether human overrode the recommendation */
  wasOverride: boolean;

  /** Human's reasoning for override (if any) */
  overrideReason?: string;

  /** User who made the decision */
  userId: string;
}
```

### DecisionOutcome
Records what actually happened after a decision was made.

```typescript
interface DecisionOutcome {
  /** Links to the decision */
  decisionId: string;

  /** The actual result */
  result: OutcomeResult;

  /** When the outcome was recorded */
  recordedAt: Date;

  /** Evidence supporting the outcome assessment */
  evidence: string[];

  /** Optional notes */
  notes?: string;
}

type OutcomeResult =
  | { status: 'success'; details: string }
  | { status: 'failure'; details: string; severity: 'minor' | 'major' | 'critical' }
  | { status: 'partial'; successRate: number; details: string }
  | { status: 'unknown'; reason: string };
```

### Attribution
The result of attribution calculation for a single decision.

```typescript
interface Attribution {
  /** Links to the decision */
  decisionId: string;

  /** Which layer was correct */
  baselineCorrect: boolean | null;
  protegeCorrect: boolean | null;
  humanCorrect: boolean | null;

  /** Attribution category */
  whoWasRight: AttributionCategory;

  /** Value source */
  valueSource: ValueSource;

  /** Confidence in this attribution (0-1) */
  confidence: number;

  /** Counterfactual analysis */
  counterfactual?: CounterfactualAnalysis;

  /** When attribution was calculated */
  calculatedAt: Date;
}

type AttributionCategory =
  | 'all_aligned'     // B = P = H, all correct
  | 'human_unique'    // B = P ≠ H, human correct
  | 'protege_wisdom'  // B ≠ P = H, protégé/human correct
  | 'collaboration'   // B ≠ P ≠ H, human correct
  | 'baseline_only'   // B ✓, P/H wrong
  | 'protege_wrong'   // B ✓, P diverged incorrectly
  | 'human_wrong'     // P ✓, H overrode incorrectly
  | 'all_wrong'       // Everyone was wrong
  | 'unknown';        // Cannot determine

type ValueSource =
  | 'system'          // Baseline/automated was right
  | 'protege_wisdom'  // Protégé learned wisdom proved valuable
  | 'human_judgment'  // Human unique insight was key
  | 'collaboration'   // Combined effort was needed
  | 'none';           // No value source identified
```

### OutcomeAssessment
Evaluation of whether a specific choice worked.

```typescript
interface OutcomeAssessment {
  /** Whether the choice worked */
  worked: boolean | null;

  /** Confidence in this assessment (0-1) */
  confidence: number;

  /** Evidence supporting the assessment */
  evidence: string[];

  /** Assessment method used */
  method: AssessmentMethod;
}

type AssessmentMethod =
  | 'direct_observation'  // Outcome directly observed
  | 'proxy_metric'        // Inferred from proxy metrics
  | 'expert_review'       // Human expert assessment
  | 'automated';          // Automated validation
```

### CounterfactualAnalysis
What-if analysis for alternative choices.

```typescript
interface CounterfactualAnalysis {
  /** What would baseline have produced? */
  baselineAlternative?: CounterfactualResult;

  /** What would protégé have produced? */
  protegeAlternative?: CounterfactualResult;
}

interface CounterfactualResult {
  /** The alternative outcome */
  alternativeOutcome: string;

  /** Would it have worked? */
  wouldHaveWorked: boolean | null;

  /** Confidence in this counterfactual (0-1) */
  confidence: number;

  /** Reasoning for the counterfactual assessment */
  reasoning: string;
}
```

### IndividualMetrics
Aggregated metrics for a user over a period.

```typescript
interface IndividualMetrics {
  /** User these metrics are for */
  userId: string;

  /** Time period covered */
  period: MetricsPeriod;

  /** Total decisions in period */
  totalDecisions: number;

  /** Decisions with known outcomes */
  validOutcomes: number;

  /** Core metrics */
  interventionRate: number;    // Overrides / total
  additiveValue: number;       // (protégé + human unique) / total
  protegeStandalone: number;   // Protégé correct / total
  uniqueHuman: number;         // Human unique / total

  /** Domain breakdown */
  domainBreakdown: DomainMetrics[];

  /** Trend indicators */
  trends: MetricsTrends;

  /** When metrics were calculated */
  calculatedAt: Date;
}

interface MetricsPeriod {
  start: Date;
  end: Date;
  type: 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';
}

interface DomainMetrics {
  domain: string;
  totalDecisions: number;
  interventionRate: number;
  additiveValue: number;
  protegeStandalone: number;
  uniqueHuman: number;
}

interface MetricsTrends {
  interventionRateTrend: TrendDirection;
  additiveValueTrend: TrendDirection;
  volumeTrend: TrendDirection;
}

type TrendDirection = 'increasing' | 'decreasing' | 'stable' | 'insufficient_data';
```

## Validation Rules

### Attribution Validation
- `decisionId` must be non-empty string
- At least one of `baselineCorrect`, `protegeCorrect`, `humanCorrect` must be non-null
- `confidence` must be between 0 and 1
- `whoWasRight` must match the correct layer(s) state

### Metrics Validation
- `totalDecisions` >= `validOutcomes`
- All rate metrics must be between 0 and 1
- `period.start` < `period.end`

## Entity Relationships

```
┌─────────────────────┐      ┌──────────────────┐
│  ThreeLayerDecision │      │  DecisionOutcome │
│  ─────────────────  │      │  ──────────────  │
│  id                 │◄────►│  decisionId      │
│  request            │      │  result          │
│  baseline           │      │  recordedAt      │
│  protege            │      └──────────────────┘
│  humanChoice        │                │
└─────────────────────┘                │
         │                             │
         │                             ▼
         │                    ┌────────────────┐
         └───────────────────►│  Attribution   │
                              │  ────────────  │
                              │  decisionId    │
                              │  whoWasRight   │
                              │  valueSource   │
                              └────────────────┘
                                       │
                                       │ aggregates into
                                       ▼
                              ┌──────────────────┐
                              │ IndividualMetrics│
                              │ ────────────────  │
                              │ userId           │
                              │ period           │
                              │ metrics...       │
                              └──────────────────┘
```
