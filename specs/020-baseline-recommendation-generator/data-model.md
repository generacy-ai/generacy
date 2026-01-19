# Data Model: Baseline Recommendation Generator

## Core Entities

### DecisionRequest

The input to the baseline generator. Contains all context needed for recommendation.

```typescript
interface DecisionRequest {
  /** Unique identifier for this decision request */
  id: string;

  /** Human-readable description of the decision */
  description: string;

  /** Available options to choose from */
  options: DecisionOption[];

  /** Project context for decision-making */
  context: ProjectContext;

  /** Optional constraints on the decision */
  constraints?: DecisionConstraints;

  /** When the decision was requested */
  requestedAt: Date;
}

interface DecisionOption {
  /** Unique identifier for this option */
  id: string;

  /** Human-readable name */
  name: string;

  /** Detailed description */
  description: string;

  /** Known pros of this option */
  pros?: string[];

  /** Known cons of this option */
  cons?: string[];

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

interface ProjectContext {
  /** Project name */
  name: string;

  /** Project description */
  description?: string;

  /** Technology stack in use */
  techStack?: string[];

  /** Team size (for capacity considerations) */
  teamSize?: number;

  /** Project phase (planning, development, maintenance) */
  phase?: 'planning' | 'development' | 'maintenance';

  /** Domain (web, mobile, data, etc.) */
  domain?: string;

  /** Additional context key-value pairs */
  additionalContext?: Record<string, string>;
}

interface DecisionConstraints {
  /** Hard deadline for implementation */
  deadline?: Date;

  /** Budget constraints */
  budget?: {
    amount: number;
    currency: string;
  };

  /** Required capabilities/features */
  requiredFeatures?: string[];

  /** Technologies that must not be used */
  excludedTechnologies?: string[];
}
```

### BaselineRecommendation

The output from the baseline generator.

```typescript
interface BaselineRecommendation {
  /** ID of the recommended option */
  optionId: string;

  /** Confidence score (0-100) */
  confidence: number;

  /** Step-by-step reasoning for the recommendation */
  reasoning: string[];

  /** Factors considered in the decision */
  factors: ConsiderationFactor[];

  /** Analysis of why alternatives were not chosen */
  alternativeOptionAnalysis: AlternativeAnalysis[];

  /** When the recommendation was generated */
  generatedAt: Date;

  /** Configuration used for this recommendation */
  configSnapshot: BaselineConfig;
}

interface ConsiderationFactor {
  /** Factor name (e.g., "scalability", "cost") */
  name: string;

  /** Factor value (e.g., "high", "$50k") */
  value: string;

  /** Weight given to this factor (0-1) */
  weight: number;

  /** How this factor affected the decision */
  impact: 'supports' | 'opposes' | 'neutral';

  /** Brief explanation of the impact */
  explanation?: string;
}

interface AlternativeAnalysis {
  /** ID of the alternative option */
  optionId: string;

  /** Why this option was not chosen */
  whyNotChosen: string;

  /** Confidence if this option had been chosen */
  confidenceIfChosen: number;

  /** Key differentiating factors vs. chosen option */
  keyDifferences?: string[];
}
```

### BaselineConfig

Configuration for the generator's behavior.

```typescript
interface BaselineConfig {
  /** Which factors to consider */
  factors: FactorConfig;

  /** Minimum confidence to provide recommendation (0-100) */
  confidenceThreshold: number;

  /** Always include reasoning in output */
  requireReasoning: boolean;
}

interface FactorConfig {
  /** Consider project constraints (deadline, budget) */
  projectContext: boolean;

  /** Use general domain best practices */
  domainBestPractices: boolean;

  /** Consider team capacity */
  teamSize: boolean;

  /** Prefer existing technology stack */
  existingStack: boolean;
}

const DEFAULT_BASELINE_CONFIG: BaselineConfig = {
  factors: {
    projectContext: true,
    domainBestPractices: true,
    teamSize: true,
    existingStack: true,
  },
  confidenceThreshold: 50,
  requireReasoning: true,
};
```

### AIService Interface

Abstraction for LLM invocation.

```typescript
interface AIService {
  /** Generate a completion for the given prompt */
  complete(request: AICompletionRequest): Promise<AICompletionResponse>;
}

interface AICompletionRequest {
  /** System prompt setting context */
  systemPrompt: string;

  /** User prompt with the specific request */
  userPrompt: string;

  /** Maximum tokens in response */
  maxTokens?: number;

  /** Temperature for response variability (0-1) */
  temperature?: number;

  /** Response format hint */
  responseFormat?: 'text' | 'json';
}

interface AICompletionResponse {
  /** The generated completion */
  content: string;

  /** Token usage statistics */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };

  /** Model that generated the response */
  model?: string;
}
```

## Validation Rules

### DecisionRequest Validation

| Field | Rule | Error |
|-------|------|-------|
| `id` | Non-empty string | `InvalidRequestError: id is required` |
| `options` | At least 1 option | `InvalidRequestError: at least one option required` |
| `options[].id` | Unique within request | `InvalidRequestError: duplicate option id` |
| `context` | Must be present | `InvalidRequestError: context is required` |

### BaselineConfig Validation

| Field | Rule | Error |
|-------|------|-------|
| `confidenceThreshold` | 0-100 | `InvalidConfigError: threshold out of range` |
| `factors` | At least one true | `InvalidConfigError: no factors enabled` |

### Confidence Score Validation

| Rule | Enforcement |
|------|-------------|
| Range 0-100 | Clamped at boundaries |
| Integer only | Rounded to nearest integer |
| Threshold check | Returns null if below threshold |

## Entity Relationships

```
┌─────────────────┐     1        *    ┌─────────────────┐
│ DecisionRequest │──────────────────▶│  DecisionOption │
└────────┬────────┘                   └─────────────────┘
         │
         │ 1
         │
         ▼ 1
┌─────────────────┐
│  ProjectContext │
└─────────────────┘

┌──────────────────────┐    1     *   ┌────────────────────┐
│ BaselineRecommendation│─────────────▶│ ConsiderationFactor│
└──────────┬───────────┘              └────────────────────┘
           │
           │ 1      *
           │
           ▼
┌────────────────────┐
│ AlternativeAnalysis│
└────────────────────┘
```

## State Transitions

The BaselineRecommendationGenerator itself is stateless per invocation. Configuration can be updated between calls.

```
                    configure()
                         │
                         ▼
┌──────────┐    ┌──────────────┐    ┌───────────────┐
│ Unconfigured │──▶│  Configured  │──▶│ Recommendation│
└──────────┘    └──────────────┘    └───────────────┘
                         │                   │
                         │   generateBaseline()
                         │◀──────────────────┘
                         │
                    configure()
```

---

*Generated by speckit*
