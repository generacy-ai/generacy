# Feature Specification: Baseline recommendation generator

**Branch**: `020-baseline-recommendation-generator` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

Implement the baseline recommendation generator - the component that produces AI recommendations without human wisdom for the three-layer decision model.

## Parent Epic

#2 - Generacy Core Package

## Dependencies

- AIService abstraction (shared service for LLM invocation)
- Local interfaces for DecisionRequest/BaselineRecommendation (to be extracted to @generacy-ai/contracts later)

## Architectural Decisions

Based on clarification responses:

### AD-1: LLM Integration via AIService
The baseline generator uses a shared AIService abstraction for LLM invocation. This provides:
- Clean separation of concerns (generator focuses on prompting strategy)
- Pluggable LLM backends via configuration
- Testability via mock implementations
- Consistency with plugin architecture

### AD-2: Best Practices from LLM Training
Domain best practices come from the LLM's training knowledge with appropriate prompting. For MVP, this avoids infrastructure complexity while the baseline explicitly must NOT access human knowledge stores.

### AD-3: Local Contracts Pattern
DecisionRequest and BaselineRecommendation interfaces are defined locally, mirroring intended contracts structure. This allows immediate development while making future extraction to @generacy-ai/contracts mechanical.

### AD-4: Context via DecisionRequest
Project context is passed as part of the DecisionRequest input (not queried from knowledge stores). This keeps the baseline generator dependency-free beyond AIService and makes context explicit/traceable.

### AD-5: Hybrid Confidence Calculation
Confidence scores use a hybrid approach:
1. **Algorithmic base**: Initial confidence from factor agreement/conflict (explainable, consistent)
2. **LLM adjustment**: Model adjusts within bounds based on reasoning (handles edge cases)

## Purpose

The baseline recommendation serves as the **control group** in the three-layer decision model. It represents what a well-configured AI would recommend without access to the specific human's wisdom, principles, or context.

This baseline enables measuring human value: when the protégé or human differs from baseline and proves correct, that difference represents the value of human wisdom.

## How Baseline Differs from Protégé

| Aspect | Baseline | Protégé |
|--------|----------|---------|
| Knowledge | General best practices | Human's specific principles |
| Reasoning | Standard AI analysis | Human's philosophy applied |
| Context | Project context only | Human's current priorities |
| Goal | Objectively good decision | What THIS human would decide |

## Implementation

### BaselineRecommendationGenerator
```typescript
interface BaselineRecommendationGenerator {
  // Generate baseline recommendation for a decision
  generateBaseline(request: DecisionRequest): Promise<BaselineRecommendation>;
  
  // Configure baseline model behavior
  configure(config: BaselineConfig): void;
}

interface BaselineConfig {
  // Which factors to consider
  factors: {
    projectContext: boolean;      // Use project constraints
    domainBestPractices: boolean; // Use general best practices
    teamSize: boolean;            // Consider team capacity
    existingStack: boolean;       // Prefer existing tech
  };
  
  // Model settings
  confidenceThreshold: number;    // Minimum confidence to recommend
  requireReasoning: boolean;      // Always provide reasoning
}
```

### BaselineRecommendation Output
```typescript
interface BaselineRecommendation {
  optionId: string;
  confidence: number;  // 0-100
  
  reasoning: string[];  // Step-by-step logic
  
  factors: ConsiderationFactor[];
  
  // For comparison
  alternativeOptionAnalysis: {
    optionId: string;
    whyNotChosen: string;
    confidenceIfChosen: number;
  }[];
}

interface ConsiderationFactor {
  name: string;
  value: string;
  weight: number;
  impact: 'supports' | 'opposes' | 'neutral';
}
```

### Integration Points
- Receives DecisionRequest from workflow engine (context included in request per AD-4)
- Invokes AIService for LLM-based recommendation generation (per AD-1)
- Uses LLM training knowledge for domain best practices (per AD-2)
- Returns BaselineRecommendation to decision flow
- Does NOT access individual human knowledge stores

## Features

### Factor Analysis
- Project constraints (deadline, budget, team size)
- Existing technology stack
- Domain-specific best practices
- Industry standards and patterns

### Reasoning Generation
- Clear step-by-step logic
- Explicit factor weighting
- Alternative analysis (why not other options)

### Confidence Calibration
- Confidence based on factor agreement
- Lower confidence when factors conflict
- Explicit uncertainty acknowledgment

### Isolation from Human Knowledge
- Must NOT access Philosophy, Principles, Patterns, Context
- Pure "what would generic AI recommend"
- Enables fair comparison with protégé

## Acceptance Criteria

- [ ] Generates baseline recommendation for any DecisionRequest
- [ ] Considers project context and domain best practices
- [ ] Provides clear reasoning with factor breakdown
- [ ] Confidence scores calibrated to factor agreement
- [ ] Does NOT access individual human knowledge stores
- [ ] Returns alternative analysis for non-chosen options
- [ ] Integrates with three-layer decision flow

## User Stories

### US1: Generate Baseline Recommendation

**As a** decision flow orchestrator,
**I want** to get an objective AI recommendation for a decision request,
**So that** I can compare it with the protégé's recommendation to measure human value.

**Acceptance Criteria**:
- [ ] Receives DecisionRequest with context and options
- [ ] Returns BaselineRecommendation with chosen option and reasoning
- [ ] Provides confidence score based on factor analysis

### US2: Analyze Decision Factors

**As a** decision reviewer,
**I want** to see which factors influenced the baseline recommendation,
**So that** I can understand the reasoning and compare against human judgment.

**Acceptance Criteria**:
- [ ] Lists all factors considered with weights
- [ ] Shows factor impact (supports/opposes/neutral)
- [ ] Explains why alternatives were not chosen

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Accept DecisionRequest with context, options, and constraints | P1 | Context passed in request |
| FR-002 | Generate recommendation via AIService | P1 | Uses shared abstraction |
| FR-003 | Return structured BaselineRecommendation | P1 | Includes reasoning |
| FR-004 | Calculate hybrid confidence score | P1 | Algorithmic + LLM adjustment |
| FR-005 | Analyze all provided options | P2 | Not just chosen option |
| FR-006 | Support configurable factor weights | P2 | Via BaselineConfig |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Recommendation generation | 100% | All valid requests produce recommendations |
| SC-002 | Reasoning completeness | Every recommendation | All recommendations include factor breakdown |
| SC-003 | Test coverage | >80% | Unit tests for generator logic |

## Assumptions

- AIService abstraction will be available or can be defined as an interface
- DecisionRequest will contain sufficient context for baseline analysis
- LLM can provide reasonable domain best practices via prompting

## Out of Scope

- Direct LLM client implementation (handled by AIService)
- Knowledge store integration (context comes via DecisionRequest)
- Protégé recommendation generation (separate component)
- Decision outcome tracking and learning

---

*Generated by speckit*
