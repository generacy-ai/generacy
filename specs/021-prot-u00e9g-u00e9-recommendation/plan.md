# Implementation Plan: Protégé Recommendation Engine

**Feature**: Core recommendation engine that generates personalized recommendations based on a human's wisdom, principles, and philosophy
**Branch**: `021-prot-u00e9g-u00e9-recommendation`
**Status**: Complete

## Summary

Implement the Protégé Recommendation Engine - the core component that answers "What would THIS human decide?" rather than "What is objectively best?". The engine applies a human's philosophy, principles, patterns, and context to generate personalized recommendations with transparent reasoning.

## Technical Context

- **Language**: TypeScript 5.4+
- **Runtime**: Node.js 20+
- **Testing**: Vitest
- **Package Type**: ES Modules
- **Dependencies**: Existing knowledge-store package provides IndividualKnowledge types

## Design Decisions

### D1: Interim Types for DecisionRequest/BaselineRecommendation
Since the generacy-ai/contracts package doesn't exist yet, define interim types locally that align with the spec's interface requirements. These will be replaced when contracts are available.

### D2: Highest-Weight Principle Wins for Conflict Resolution
When multiple principles conflict, the highest-weight principle determines the recommendation. Lower-weight principles inform the confidence score and are included in reasoning to show what was considered.

### D3: Numeric Energy Scale (1-10) with Threshold Effects
Energy/fatigue represented as 1-10 scale. Below threshold (default: 4), recommendations bias toward simpler/safer options and include fatigue warnings.

### D4: Coverage-Based Confidence with Flagging
Confidence = (sum of applied principle weights × coverage factor). No minimum threshold; low confidence (<0.5) flagged but still returns recommendation.

### D5: Templated Reasoning with Principle References
Use templated responses that reference principle text directly. No LLM dependency. Reasoning expressed in structured steps that reference the human's own principles.

## Project Structure

```
src/
└── recommendation/
    ├── index.ts                      # Public exports
    ├── types/
    │   ├── index.ts                  # Type exports
    │   ├── decision-request.ts       # Interim DecisionRequest type
    │   ├── baseline.ts               # Interim BaselineRecommendation type
    │   ├── recommendation.ts         # ProtegeRecommendation, ReasoningStep, AppliedPrinciple
    │   └── engine.ts                 # ProtegeRecommendationEngine interface
    ├── engine/
    │   ├── index.ts                  # Engine exports
    │   ├── protege-engine.ts         # Main ProtegeRecommendationEngine implementation
    │   ├── principle-matcher.ts      # PrincipleMatcherService
    │   ├── context-integrator.ts     # ContextIntegratorService
    │   ├── philosophy-applier.ts     # PhilosophyApplierService
    │   └── reasoning-generator.ts    # ReasoningGeneratorService
    └── utils/
        ├── index.ts                  # Utility exports
        ├── confidence-calculator.ts  # Confidence calculation utilities
        └── difference-explainer.ts   # Baseline comparison utilities

tests/
└── recommendation/
    ├── engine/
    │   ├── protege-engine.test.ts
    │   ├── principle-matcher.test.ts
    │   ├── context-integrator.test.ts
    │   ├── philosophy-applier.test.ts
    │   └── reasoning-generator.test.ts
    ├── utils/
    │   ├── confidence-calculator.test.ts
    │   └── difference-explainer.test.ts
    └── integration/
        └── recommendation-flow.test.ts
```

## Component Design

### ProtegeRecommendationEngine

Main orchestrator that coordinates the recommendation process:

1. **Load Knowledge**: Accept IndividualKnowledge (from knowledge-store package)
2. **Match Principles**: Use PrincipleMatcherService to find applicable principles
3. **Integrate Context**: Apply context overrides via ContextIntegratorService
4. **Apply Philosophy**: Factor in risk tolerance, boundaries via PhilosophyApplierService
5. **Generate Reasoning**: Create templated reasoning via ReasoningGeneratorService
6. **Compare Baseline**: Explain differences using DifferenceExplainer

### PrincipleMatcherService

Matches decision domain to relevant principles:
- Domain-based matching using principle.domain array
- Weight-based ranking for conflicts
- Support for "unless" exceptions in principle content
- Returns ranked list of AppliedPrinciple objects

### ContextIntegratorService

Applies temporary context factors:
- Check active goals against decision options
- Apply constraint awareness (budget, time, resources)
- Factor energy level (1-10 scale) into recommendation
- Generate contextInfluence records for transparency

### PhilosophyApplierService

Applies core values and beliefs:
- Map values to decision criteria
- Enforce absolute boundaries (from beliefs with confidence=1.0)
- Apply risk tolerance adjustments to uncertain options
- Consider time horizon preferences

### ReasoningGeneratorService

Creates transparent, human-referenced reasoning:
- Template-based reasoning steps
- References principles by name and text
- Explains tradeoffs in human's value terms
- Structures as ReasoningStep array

## Type Definitions

### Interim Types (until contracts available)

```typescript
// DecisionRequest - what the human needs to decide
interface DecisionRequest {
  id: string;
  domain: string[];           // e.g., ['career', 'finance']
  question: string;           // The decision question
  options: DecisionOption[];  // Available choices
  constraints?: Constraint[]; // Time, budget, etc.
  deadline?: string;          // ISO date
}

interface DecisionOption {
  id: string;
  name: string;
  description: string;
  attributes: Record<string, unknown>;
}

interface Constraint {
  type: 'time' | 'budget' | 'resource' | 'custom';
  value: string | number;
  unit?: string;
}

// BaselineRecommendation - the "objectively best" option
interface BaselineRecommendation {
  optionId: string;
  reasoning: string;
  confidence: number;
  factors: BaselineFactor[];
}

interface BaselineFactor {
  name: string;
  contribution: number; // -1 to 1
  explanation: string;
}
```

### Core Output Types

```typescript
interface ProtegeRecommendation {
  optionId: string;
  confidence: number;
  reasoning: ReasoningStep[];
  appliedPrinciples: AppliedPrinciple[];
  contextInfluence: ContextInfluenceRecord[];
  differsFromBaseline: boolean;
  differenceExplanation?: string;
}

interface ReasoningStep {
  step: number;
  principle?: PrincipleReference;
  logic: string;
}

interface PrincipleReference {
  principleId: string;
  principleText: string;
}

interface AppliedPrinciple {
  principleId: string;
  principleText: string;
  relevance: string;
  weight: number;
}

interface ContextInfluenceRecord {
  factor: string;
  effect: string;
}
```

## Confidence Calculation

```
confidence = Σ(principle.weight × relevance_score) / max_possible_weight
           × coverage_factor × context_modifier

where:
- relevance_score: 0-1 based on domain match
- coverage_factor: (matched_principles / expected_principles_for_domain)
- context_modifier: 1.0 normally, reduced if conflicts or low energy
```

## Energy/Fatigue Effects

| Energy Level | Effect |
|-------------|--------|
| 8-10 | Normal processing, no adjustments |
| 5-7 | Minor bias toward familiar options |
| 3-4 | Significant bias toward simpler options, warning added |
| 1-2 | Strong bias toward safe/reversible options, urgent warning |

## Integration Points

### With Knowledge Store
```typescript
import { IndividualKnowledge, Principle, Pattern } from '@generacy/knowledge-store';
```

### With Message Router (Future)
The recommendation engine will be called by Agency instances via the message router when humans request decisions.

## Error Handling

- **No matching principles**: Return recommendation with low confidence, note absence of guidance
- **All options violate boundaries**: Return null recommendation with explanation
- **Missing context**: Proceed with available data, note gaps in reasoning
- **Conflicting high-weight principles**: Return highest weight, explain conflict in reasoning

## Testing Strategy

1. **Unit Tests**: Each service independently
2. **Integration Tests**: Full recommendation flow with mock knowledge
3. **Edge Cases**: No principles, conflicting principles, boundary violations
4. **Confidence Verification**: Validate confidence calculations
