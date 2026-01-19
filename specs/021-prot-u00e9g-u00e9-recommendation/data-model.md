# Data Model: Protégé Recommendation Engine

## Core Entities

### Input Types

#### DecisionRequest (Interim)
The decision that needs to be made. Interim type until contracts package provides canonical version.

```typescript
interface DecisionRequest {
  /** Unique identifier for this decision request */
  id: string;

  /** Domain tags for principle matching (e.g., ['career', 'finance']) */
  domain: string[];

  /** The question or decision to be made */
  question: string;

  /** Available options to choose from */
  options: DecisionOption[];

  /** Optional constraints on the decision */
  constraints?: Constraint[];

  /** Optional deadline for the decision */
  deadline?: string; // ISO 8601 date string

  /** Additional context specific to this request */
  metadata?: Record<string, unknown>;
}

interface DecisionOption {
  /** Unique identifier for this option */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description of what this option entails */
  description: string;

  /** Structured attributes for comparison */
  attributes: Record<string, unknown>;

  /** Whether this option is reversible */
  reversible?: boolean;

  /** Complexity rating 1-10 */
  complexity?: number;
}

interface Constraint {
  /** Type of constraint */
  type: 'time' | 'budget' | 'resource' | 'custom';

  /** Constraint value */
  value: string | number;

  /** Unit for numeric constraints */
  unit?: string;

  /** Whether this is a hard constraint (violation = option invalid) */
  hard?: boolean;
}
```

#### BaselineRecommendation (Interim)
The "objectively optimal" recommendation from the first layer of the three-layer model.

```typescript
interface BaselineRecommendation {
  /** Recommended option ID */
  optionId: string;

  /** Plain language reasoning */
  reasoning: string;

  /** Confidence in this recommendation (0-1) */
  confidence: number;

  /** Factors that contributed to this recommendation */
  factors: BaselineFactor[];
}

interface BaselineFactor {
  /** Factor name (e.g., "cost efficiency", "time to completion") */
  name: string;

  /** How much this factor contributed (-1 to 1, negative = against) */
  contribution: number;

  /** Human-readable explanation */
  explanation: string;
}
```

### Output Types

#### ProtegeRecommendation
The personalized recommendation based on the human's knowledge.

```typescript
interface ProtegeRecommendation {
  /** Recommended option ID */
  optionId: string;

  /** Confidence in this recommendation (0-1) */
  confidence: number;

  /** Step-by-step reasoning in human's terms */
  reasoning: ReasoningStep[];

  /** Principles that were applied */
  appliedPrinciples: AppliedPrinciple[];

  /** How context influenced the recommendation */
  contextInfluence: ContextInfluenceRecord[];

  /** Whether this differs from baseline recommendation */
  differsFromBaseline: boolean;

  /** Explanation of why it differs (if applicable) */
  differenceExplanation?: string;

  /** Warnings or caveats */
  warnings?: RecommendationWarning[];

  /** Metadata about the recommendation process */
  meta: RecommendationMeta;
}

interface RecommendationMeta {
  /** Time taken to generate recommendation (ms) */
  processingTimeMs: number;

  /** Number of principles evaluated */
  principlesEvaluated: number;

  /** Number of principles that matched */
  principlesMatched: number;

  /** Whether any conflicts were resolved */
  hadConflicts: boolean;

  /** Version of the recommendation engine */
  engineVersion: string;
}
```

#### ReasoningStep
A single step in the recommendation reasoning.

```typescript
interface ReasoningStep {
  /** Step number (1-indexed) */
  step: number;

  /** Principle applied in this step (if any) */
  principle?: PrincipleReference;

  /** The logical reasoning for this step */
  logic: string;

  /** Type of reasoning in this step */
  type: 'principle_application' | 'conflict_resolution' | 'context_override' | 'philosophy_application' | 'conclusion';
}

interface PrincipleReference {
  /** ID of the principle */
  principleId: string;

  /** Full text of the principle */
  principleText: string;
}
```

#### AppliedPrinciple
A principle that was applied to generate the recommendation.

```typescript
interface AppliedPrinciple {
  /** ID of the principle */
  principleId: string;

  /** Full text of the principle */
  principleText: string;

  /** Why this principle is relevant to this decision */
  relevance: string;

  /** Weight of this principle (from knowledge store) */
  weight: number;

  /** How strongly this principle applied (0-1) */
  strength: number;

  /** Which option this principle favors */
  favorsOption?: string;
}
```

#### ContextInfluenceRecord
How context factors influenced the recommendation.

```typescript
interface ContextInfluenceRecord {
  /** The context factor */
  factor: string;

  /** How it affected the recommendation */
  effect: string;

  /** Magnitude of the effect */
  magnitude: 'low' | 'medium' | 'high';
}
```

#### RecommendationWarning
Warning or caveat about the recommendation.

```typescript
interface RecommendationWarning {
  /** Type of warning */
  type: 'low_confidence' | 'energy_warning' | 'missing_context' | 'conflict_resolved' | 'boundary_close';

  /** Warning message */
  message: string;

  /** Severity level */
  severity: 'info' | 'warning' | 'critical';
}
```

### Engine Types

#### ProtegeRecommendationEngine
The main engine interface.

```typescript
interface ProtegeRecommendationEngine {
  /**
   * Generate a personalized recommendation
   */
  generateRecommendation(
    request: DecisionRequest,
    knowledge: IndividualKnowledge,
    baseline: BaselineRecommendation,
    options?: RecommendationOptions
  ): Promise<ProtegeRecommendation>;

  /**
   * Explain the difference between protégé and baseline recommendations
   */
  explainDifference(
    protege: ProtegeRecommendation,
    baseline: BaselineRecommendation
  ): DifferenceExplanation;
}

interface RecommendationOptions {
  /** Override energy level (1-10) */
  energyLevel?: number;

  /** Skip context integration */
  skipContext?: boolean;

  /** Include detailed debugging info */
  debug?: boolean;
}
```

#### DifferenceExplanation
Explanation of why recommendations differ.

```typescript
interface DifferenceExplanation {
  /** Whether they recommend different options */
  differentOption: boolean;

  /** Primary reason for the difference */
  primaryReason: string;

  /** Principles that caused the difference */
  drivingPrinciples: AppliedPrinciple[];

  /** Context factors that caused the difference */
  drivingContext: ContextInfluenceRecord[];

  /** Structured comparison */
  comparison: {
    aspect: string;
    baseline: string;
    protege: string;
  }[];
}
```

## Service Interfaces

```typescript
interface PrincipleMatcherService {
  match(
    request: DecisionRequest,
    principles: Principle[]
  ): AppliedPrinciple[];
}

interface ContextIntegratorService {
  integrate(
    request: DecisionRequest,
    context: UserContext,
    principles: AppliedPrinciple[]
  ): {
    adjustedPrinciples: AppliedPrinciple[];
    influence: ContextInfluenceRecord[];
    warnings: RecommendationWarning[];
  };
}

interface PhilosophyApplierService {
  apply(
    request: DecisionRequest,
    philosophy: Philosophy,
    candidates: AppliedPrinciple[]
  ): {
    recommendation: string; // option ID
    reasoning: ReasoningStep[];
  };
}

interface ReasoningGeneratorService {
  generate(
    request: DecisionRequest,
    appliedPrinciples: AppliedPrinciple[],
    contextInfluence: ContextInfluenceRecord[],
    selectedOption: string
  ): ReasoningStep[];
}
```

## Validation Rules

### DecisionRequest
- `id` must be non-empty string
- `domain` must have at least one element
- `options` must have at least two elements
- Option IDs must be unique
- Deadline (if provided) must be valid ISO 8601 date

### ProtegeRecommendation
- `optionId` must match one of the request options
- `confidence` must be 0-1
- `reasoning` must have at least one step
- If `differsFromBaseline` is true, `differenceExplanation` must be present

### Principle Application
- `weight` preserved from knowledge store (0-10 scale)
- `strength` calculated during matching (0-1 scale)
- `relevance` must be non-empty explanation

## Relationships

```
DecisionRequest
    │
    ├──> IndividualKnowledge (input)
    │         ├── Philosophy
    │         ├── Principle[] ──> AppliedPrinciple[]
    │         ├── Pattern[]
    │         └── UserContext ──> ContextInfluenceRecord[]
    │
    ├──> BaselineRecommendation (input)
    │
    └──> ProtegeRecommendation (output)
              ├── ReasoningStep[]
              ├── AppliedPrinciple[]
              ├── ContextInfluenceRecord[]
              └── DifferenceExplanation? (via explainDifference)
```
