# Research: Baseline Recommendation Generator

## Technology Decisions

### Decision 1: LLM Integration Strategy

**Chosen**: AIService abstraction with dependency injection

**Rationale**:
- Aligns with spec's AD-1 (AIService abstraction)
- Enables testing without LLM costs
- Supports multiple backends (OpenAI, Anthropic, local models)
- Clean separation of prompting strategy from invocation

**Alternatives Considered**:
| Alternative | Pros | Cons | Why Not |
|-------------|------|------|---------|
| Direct OpenAI SDK | Simpler setup | Vendor lock-in, hard to test | Violates abstraction principle |
| LangChain | Rich tooling | Heavy dependency, overhead | Overkill for focused use case |
| Custom wrapper | Full control | More code to maintain | AIService interface sufficient |

### Decision 2: Confidence Calculation Approach

**Chosen**: Hybrid (Algorithmic base + LLM adjustment)

**Rationale**:
- Aligns with spec's AD-5 (Hybrid confidence calculation)
- Algorithmic base provides explainability and consistency
- LLM adjustment handles nuanced edge cases
- Bounded adjustment prevents wild swings

**Algorithm Outline**:
```
1. Calculate factor agreement score (0-100)
   - Count supporting vs opposing factors
   - Weight by factor importance

2. Apply conflict penalty
   - If factors strongly disagree, reduce base confidence

3. LLM adjustment (bounded ±15)
   - Model can adjust based on reasoning quality
   - Never exceeds algorithm ± 15 points

4. Final confidence = clamp(0, 100, adjusted_score)
```

### Decision 3: Prompt Engineering Strategy

**Chosen**: Structured system prompt with JSON output

**Rationale**:
- Consistent, parseable output format
- Clear separation of context, options, and instructions
- Enables reliable extraction of factors and reasoning

**Prompt Structure**:
```
SYSTEM:
- Role: Objective AI decision advisor
- Constraints: No personal knowledge, only provided context
- Output format: JSON with specific schema

USER:
- Decision description
- Options with details
- Project context
- Constraints
```

### Decision 4: Error Handling Strategy

**Chosen**: Explicit error types with recovery hints

**Error Types**:
| Error | Cause | Recovery |
|-------|-------|----------|
| `InvalidRequestError` | Malformed input | Fix input, retry |
| `AIServiceError` | LLM failure | Retry with backoff |
| `LowConfidenceError` | Below threshold | Return null or force |
| `ParseError` | Invalid LLM output | Retry with stricter prompt |

## Implementation Patterns

### Pattern 1: Builder Pattern for Prompts

```typescript
class PromptBuilder {
  private systemParts: string[] = [];
  private userParts: string[] = [];

  withRole(role: string): this { ... }
  withContext(context: ProjectContext): this { ... }
  withOptions(options: DecisionOption[]): this { ... }
  withOutputFormat(schema: object): this { ... }

  build(): { systemPrompt: string; userPrompt: string } { ... }
}
```

**Benefits**:
- Readable prompt construction
- Easy to test individual parts
- Flexible for different prompt strategies

### Pattern 2: Strategy Pattern for Confidence

```typescript
interface ConfidenceStrategy {
  calculate(factors: ConsiderationFactor[], llmResponse: LLMResponse): number;
}

class HybridConfidenceStrategy implements ConfidenceStrategy {
  calculate(factors, llmResponse) {
    const algorithmicBase = this.calculateBase(factors);
    const llmAdjustment = this.extractAdjustment(llmResponse);
    return this.applyBoundedAdjustment(algorithmicBase, llmAdjustment);
  }
}
```

**Benefits**:
- Easy to swap calculation strategies
- Testable in isolation
- Clear responsibility boundaries

### Pattern 3: Factory for Generator Instances

```typescript
class BaselineGeneratorFactory {
  static create(aiService: AIService, config?: BaselineConfig): BaselineRecommendationGenerator {
    return new BaselineRecommendationGeneratorImpl(
      aiService,
      new PromptBuilder(),
      new HybridConfidenceStrategy(),
      config ?? DEFAULT_BASELINE_CONFIG
    );
  }

  static createForTesting(): BaselineRecommendationGenerator {
    return this.create(new MockAIService());
  }
}
```

**Benefits**:
- Clean instantiation
- Easy test setup
- Dependency wiring in one place

## Key References

### Existing Codebase Patterns

1. **Module Structure**: Follow `src/router/` pattern
   - `index.ts` for public exports
   - Separate files per responsibility
   - Types alongside implementation

2. **Error Handling**: Follow `src/router/routing-rules.ts` pattern
   - Custom error classes extending Error
   - Descriptive error messages
   - Type-safe error handling

3. **Testing**: Follow `tests/` structure
   - Co-located test files
   - Fixtures for test data
   - Vitest assertions

### LLM Prompting Best Practices

1. **Structured Output**: Request JSON for reliable parsing
2. **Role Clarity**: Define AI's role and constraints upfront
3. **Few-shot Examples**: Include example outputs for consistency
4. **Output Schema**: Provide exact expected format

### Confidence Calibration Literature

Key insight: Algorithmic factors provide base, LLM adds nuance.

- Factor agreement: High agreement = high confidence
- Factor conflict: Opposing factors reduce confidence
- Edge cases: LLM can adjust for nuanced scenarios
- Bounded adjustment: Prevents hallucinated confidence

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| How to handle no viable options? | Return low confidence, explain in reasoning |
| Factor weight customization? | Via BaselineConfig.factors |
| LLM output parsing failures? | Retry once, then throw ParseError |
| Timeout handling? | AIService implementation concern |

---

*Generated by speckit*
