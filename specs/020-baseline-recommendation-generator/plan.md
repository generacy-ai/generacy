# Implementation Plan: Baseline Recommendation Generator

**Feature**: Baseline recommendation generator for three-layer decision model
**Branch**: `020-baseline-recommendation-generator`
**Status**: Complete

## Summary

Implement the `BaselineRecommendationGenerator` - a component that produces objective AI recommendations without human wisdom. This serves as the control group in Generacy's three-layer decision model, enabling measurement of human value by comparing baseline recommendations against protégé (human-influenced) recommendations.

The generator uses an AIService abstraction for LLM invocation, receives context via DecisionRequest (no knowledge store access), and produces structured recommendations with confidence scores, factor analysis, and alternative option analysis.

## Technical Context

| Aspect | Choice |
|--------|--------|
| Language | TypeScript (ESM modules) |
| Runtime | Node.js 20+ |
| Test Framework | Vitest |
| Linting | ESLint with TypeScript plugin |
| Build | tsc (TypeScript compiler) |

### Dependencies

**Existing (no new packages needed)**:
- TypeScript 5.4+
- Vitest for testing
- ESLint for linting

**Internal Dependencies**:
- AIService interface (to be defined - abstraction for LLM invocation)
- Local contract interfaces (DecisionRequest, BaselineRecommendation)

## Project Structure

```
src/
├── baseline/
│   ├── index.ts                          # Public exports
│   ├── baseline-generator.ts             # Main generator class
│   ├── prompt-builder.ts                 # Prompting strategy for LLM
│   ├── confidence-calculator.ts          # Hybrid confidence scoring
│   └── types.ts                          # Local contract interfaces
├── services/
│   └── ai-service.ts                     # AIService interface + mock
tests/
└── baseline/
    ├── baseline-generator.test.ts        # Generator unit tests
    ├── prompt-builder.test.ts            # Prompt building tests
    ├── confidence-calculator.test.ts     # Confidence calculation tests
    └── fixtures/
        └── decision-requests.ts          # Test decision scenarios
```

## Constitution Check

No constitution.md found. Proceeding with standard implementation patterns.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      Decision Flow                               │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│               BaselineRecommendationGenerator                    │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐   │
│  │PromptBuilder │  │ AIService    │  │ConfidenceCalculator │   │
│  │              │──▶│ (injected)  │──▶│                     │   │
│  └──────────────┘  └──────────────┘  └─────────────────────┘   │
│                                                                  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
                    BaselineRecommendation
                    - optionId
                    - confidence (0-100)
                    - reasoning[]
                    - factors[]
                    - alternativeOptionAnalysis[]
```

## Key Design Decisions

### 1. AIService Abstraction (AD-1)
The generator depends on an `AIService` interface, not a concrete LLM client. This enables:
- Testability via mock implementations
- Pluggable backends (OpenAI, Anthropic, local models)
- Clean separation of prompting strategy from LLM invocation

### 2. Hybrid Confidence Calculation (AD-5)
Confidence scores combine:
1. **Algorithmic base**: Calculated from factor agreement/conflict (deterministic, explainable)
2. **LLM adjustment**: Model adjusts within bounds based on nuanced reasoning

### 3. Context via DecisionRequest (AD-4)
All context needed for recommendation is passed in the request. The generator:
- Does NOT query knowledge stores
- Does NOT access human-specific data
- Receives only project context and decision options

### 4. Local Contracts Pattern (AD-3)
Interfaces are defined locally, mirroring intended `@generacy-ai/contracts` structure for future extraction.

## Implementation Phases

### Phase 1: Foundation (Types & Interfaces)
- Define local contract interfaces (DecisionRequest, BaselineRecommendation)
- Define AIService interface
- Create mock AIService for testing

### Phase 2: Core Generator
- Implement BaselineRecommendationGenerator class
- Implement PromptBuilder for LLM prompting strategy
- Implement ConfidenceCalculator for hybrid scoring

### Phase 3: Testing & Integration
- Unit tests for all components
- Integration test with mock AIService
- Export via main index.ts

## API Design

### Generator Interface
```typescript
interface BaselineRecommendationGenerator {
  generateBaseline(request: DecisionRequest): Promise<BaselineRecommendation>;
  configure(config: BaselineConfig): void;
}
```

### Configuration
```typescript
interface BaselineConfig {
  factors: {
    projectContext: boolean;
    domainBestPractices: boolean;
    teamSize: boolean;
    existingStack: boolean;
  };
  confidenceThreshold: number;
  requireReasoning: boolean;
}
```

## Testing Strategy

| Test Type | Coverage Target | Focus Areas |
|-----------|-----------------|-------------|
| Unit Tests | >80% | Generator logic, prompt building, confidence calculation |
| Integration Tests | Key flows | Full recommendation generation with mock AIService |

### Test Scenarios
1. Single option decision → clear recommendation
2. Multiple options with trade-offs → weighted analysis
3. Conflicting factors → lower confidence
4. Missing context → graceful handling
5. Edge cases → proper error responses

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| AIService not defined elsewhere | Medium | Define minimal interface locally |
| Prompt quality affects recommendations | High | Iterative prompt refinement with tests |
| Confidence calibration inconsistent | Medium | Algorithmic base provides consistency |

## Success Metrics

- All acceptance criteria from spec met
- >80% test coverage
- Clean integration with existing codebase patterns
- Ready for protégé comparison in decision flow

---

*Generated by speckit*
