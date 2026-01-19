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

**Answer**: B - Shared AIService abstraction. The architecture docs show a plugin-based design with clean separation of concerns. An AIService abstraction allows the generator to focus on business logic (prompting strategy, factor analysis), different LLM backends to be plugged in via configuration, easier testing via mock implementations, and consistency with the overall plugin architecture pattern.

### Q2: Best Practices Source
**Context**: The spec mentions 'domain best practices' and 'curated knowledge' but doesn't define where this comes from. Implementation needs a concrete data source.
**Question**: Where should domain best practices come from? Should there be a static knowledge base, dynamic lookup, or LLM's training knowledge?
**Options**:
- A: Static YAML/JSON files shipped with the package
- B: Query knowledge stores (issue #24) for domain-specific best practices
- C: Rely entirely on the LLM's training knowledge with appropriate prompting

**Answer**: C - Rely on LLM's training knowledge with appropriate prompting. Per the knowledge architecture docs, the baseline explicitly "Does NOT access individual human knowledge stores." The LLM's training knowledge naturally provides general industry best practices. For MVP, prompting the LLM to consider project constraints, team size, and domain conventions gives us the "objectively good decision" baseline without adding infrastructure complexity.

### Q3: DecisionRequest Schema
**Context**: The spec references DecisionRequest from generacy-ai/contracts but this dependency doesn't exist yet. We need to know if we should define it or wait.
**Question**: Should this feature define the DecisionRequest/BaselineRecommendation schemas locally, or wait for the contracts package?
**Options**:
- A: Define schemas locally in this package for now
- B: Create contracts package first as a dependency
- C: Define local interfaces that will later be extracted to contracts

**Answer**: C - Define local interfaces that will later be extracted to contracts. The repo structure shows @generacy-ai/contracts as the shared contracts package, but it doesn't exist yet. Defining local interfaces that mirror the intended contracts structure allows development to proceed immediately, establishes the pattern for eventual extraction, and makes extraction mechanical when contracts package is created.

### Q4: Project Context Access
**Context**: The spec says baseline consults 'project context from knowledge stores' but knowledge stores (issue #24) may not be available yet. Need clarity on the integration.
**Question**: How should baseline access project context? Should it expect a ProjectContext object as input, or query knowledge stores directly?
**Options**:
- A: ProjectContext passed as part of DecisionRequest input
- B: Query knowledge stores directly (requires #24)
- C: Accept either - context in request OR query if available

**Answer**: A - ProjectContext passed as part of DecisionRequest input. The DecisionRequest interface in the docs already includes rich context (summary, domain, constraints, stakeholders, timeline). This design means baseline generator has no external dependencies beyond the AIService, context is explicit and traceable, works regardless of knowledge store availability, and aligns with the existing decision flow where context is gathered before reaching baseline.

### Q5: Confidence Calculation
**Context**: The spec mentions confidence 0-100 based on 'factor agreement' but doesn't specify the algorithm. This affects how consistent/deterministic results are.
**Question**: How should confidence scores be calculated? Should it be algorithmic (weighted factors), LLM-estimated, or hybrid?
**Options**:
- A: Algorithmic: weighted average of factor scores
- B: LLM-estimated: ask the model to self-report confidence
- C: Hybrid: algorithmic baseline adjusted by LLM reasoning

**Answer**: C - Hybrid approach (algorithmic baseline adjusted by LLM reasoning). The spec mentions confidence based on "factor agreement" with "lower confidence when factors conflict" - this suggests a systematic approach. The hybrid approach uses an algorithmic base to calculate initial confidence from factor agreement/conflict (explainable, consistent), then allows LLM adjustment within bounds based on reasoning (handles edge cases). This gives explainability for auditing while preserving LLM judgment.

