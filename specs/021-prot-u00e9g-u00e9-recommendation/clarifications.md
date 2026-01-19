# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 18:30

### Q1: Baseline Dependency
**Context**: The spec references `DecisionRequest` and `BaselineRecommendation` from generacy-ai/contracts, but these schemas don't exist yet. The recommendation engine needs these as inputs to function.
**Question**: Should this feature define its own interim types for DecisionRequest and BaselineRecommendation, or wait until the contracts package provides them?
**Options**:
- A: Define interim types locally that will be replaced when contracts are available
- B: Define types as part of this feature and consider them canonical (move to contracts later)
- C: Block on contracts package being implemented first

**Answer**: *Pending*

### Q2: Conflicting Principles Resolution
**Context**: The spec mentions 'handle conflicting principles (use learned weights)' but doesn't specify how weights are learned or what algorithm resolves conflicts when multiple principles apply with different recommendations.
**Question**: How should the engine resolve conflicting principles - weighted average, highest weight wins, or should it flag the conflict and return multiple weighted options?
**Options**:
- A: Highest weight principle wins; other principles only inform confidence score
- B: Weighted average across all applicable principles
- C: Return the conflict to the user with explanations for each option

**Answer**: *Pending*

### Q3: Energy/Fatigue Quantification
**Context**: The spec mentions factoring in 'energy level / decision fatigue' from context but doesn't specify how this is represented or how it affects recommendations.
**Question**: How should energy/fatigue level be represented and what is its effect on recommendations?
**Options**:
- A: Numeric scale (1-10) that adjusts recommendation toward simpler/safer options when low
- B: Boolean 'fatigued' flag that triggers explicit warnings about complex decisions
- C: Defer to context integration work; treat as optional enhancement for v2

**Answer**: *Pending*

### Q4: Confidence Calculation
**Context**: The spec says 'confidence reflects certainty of principle application' but doesn't define how confidence is calculated from principle weights, conflicts, and context factors.
**Question**: What factors should contribute to the confidence score, and should there be a minimum confidence threshold below which the engine refuses to recommend?
**Options**:
- A: Confidence = weighted average of applied principle confidences; no minimum threshold
- B: Confidence based on principle coverage and conflicts; return 'uncertain' below 0.5
- C: Simple confidence based on number of matching principles; flag low-confidence rather than blocking

**Answer**: *Pending*

### Q5: LLM Integration Scope
**Context**: The spec describes reasoning articulation 'in human's voice' but doesn't specify whether this requires LLM integration for natural language generation or can be done with templated responses.
**Question**: Should the reasoning articulation use LLM-generated natural language, or templated responses based on principle text?
**Options**:
- A: LLM-generated reasoning for natural voice; principle text as context
- B: Templated responses using principle text directly; no LLM dependency
- C: Both: templated as default, LLM as optional enhancement when available

**Answer**: *Pending*

