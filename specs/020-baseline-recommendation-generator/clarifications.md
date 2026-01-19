# Clarifications

Questions and answers to clarify the feature specification.

## Batch 1 - 2026-01-19 18:32

### Q1: LLM Integration
**Context**: The BaselineRecommendationGenerator needs to produce AI recommendations, but the spec doesn't specify how the AI/LLM is invoked. This is critical for implementation.
**Question**: How should the baseline generator invoke the underlying LLM? Should it use a direct LLM client, or go through an abstraction layer (e.g., a shared AIService)?
**Options**:
- A: Direct LLM client injection (e.g., constructor takes an LLMClient)
- B: Shared AIService abstraction that handles prompts/completions
- C: Message-based via the message router from issue #26

**Answer**: *Pending*

### Q2: Best Practices Source
**Context**: The spec mentions 'domain best practices' and 'curated knowledge' but doesn't define where this comes from. Implementation needs a concrete data source.
**Question**: Where should domain best practices come from? Should there be a static knowledge base, dynamic lookup, or LLM's training knowledge?
**Options**:
- A: Static YAML/JSON files shipped with the package
- B: Query knowledge stores (issue #24) for domain-specific best practices
- C: Rely entirely on the LLM's training knowledge with appropriate prompting

**Answer**: *Pending*

### Q3: DecisionRequest Schema
**Context**: The spec references DecisionRequest from generacy-ai/contracts but this dependency doesn't exist yet. We need to know if we should define it or wait.
**Question**: Should this feature define the DecisionRequest/BaselineRecommendation schemas locally, or wait for the contracts package?
**Options**:
- A: Define schemas locally in this package for now
- B: Create contracts package first as a dependency
- C: Define local interfaces that will later be extracted to contracts

**Answer**: *Pending*

### Q4: Project Context Access
**Context**: The spec says baseline consults 'project context from knowledge stores' but knowledge stores (issue #24) may not be available yet. Need clarity on the integration.
**Question**: How should baseline access project context? Should it expect a ProjectContext object as input, or query knowledge stores directly?
**Options**:
- A: ProjectContext passed as part of DecisionRequest input
- B: Query knowledge stores directly (requires #24)
- C: Accept either - context in request OR query if available

**Answer**: *Pending*

### Q5: Confidence Calculation
**Context**: The spec mentions confidence 0-100 based on 'factor agreement' but doesn't specify the algorithm. This affects how consistent/deterministic results are.
**Question**: How should confidence scores be calculated? Should it be algorithmic (weighted factors), LLM-estimated, or hybrid?
**Options**:
- A: Algorithmic: weighted average of factor scores
- B: LLM-estimated: ask the model to self-report confidence
- C: Hybrid: algorithmic baseline adjusted by LLM reasoning

**Answer**: *Pending*

