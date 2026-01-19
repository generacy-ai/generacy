# Research: Protégé Recommendation Engine

## Technology Decisions

### TypeScript Strict Mode
**Decision**: Use TypeScript strict mode with all checks enabled
**Rationale**: Ensures type safety for complex recommendation logic where null/undefined checks are critical

### No External Dependencies
**Decision**: No new runtime dependencies beyond existing (knowledge-store types)
**Rationale**: Recommendation engine is pure business logic; no I/O, no persistence, no LLM calls
**Alternative Considered**: LLM integration for natural language reasoning
**Why Rejected**: Adds complexity, latency, cost; templated reasoning sufficient for MVP

### Functional Service Pattern
**Decision**: Services are stateless functions that receive all data as parameters
**Rationale**: Easier testing, no side effects, works well with TypeScript
**Pattern**: `(input, config) => output` rather than class instances

## Implementation Patterns

### Principle Matching

```typescript
// Domain-based matching with weight consideration
function matchPrinciples(
  request: DecisionRequest,
  principles: Principle[]
): AppliedPrinciple[] {
  return principles
    .filter(p => p.domain.some(d => request.domain.includes(d)))
    .filter(p => p.status === 'active')
    .sort((a, b) => b.weight - a.weight)
    .map(p => ({
      principleId: p.id,
      principleText: p.content,
      relevance: calculateRelevance(p, request),
      weight: p.weight
    }));
}
```

### Conflict Resolution

When multiple principles suggest different options:

1. **Identify Conflict**: Two principles with domain overlap recommending different options
2. **Resolve by Weight**: Higher weight principle determines recommendation
3. **Document in Reasoning**: Show which principles were overridden and why
4. **Adjust Confidence**: Reduce confidence proportional to conflict severity

### Context Override Logic

```typescript
// Context factors that can override principle-based recommendations
const contextOverrides = {
  // High energy + urgent deadline = accept more risk
  urgentHighEnergy: (ctx: UserContext, rec: Draft) => {
    if (ctx.preferences.energyLevel >= 8 && hasUrgentDeadline(ctx)) {
      return adjustForSpeed(rec);
    }
    return rec;
  },

  // Low energy = bias toward reversible decisions
  lowEnergy: (ctx: UserContext, rec: Draft) => {
    if (ctx.preferences.energyLevel <= 4) {
      return biasTowardReversible(rec);
    }
    return rec;
  }
};
```

### Reasoning Template Pattern

```typescript
const reasoningTemplates = {
  principleApplied: (p: AppliedPrinciple) =>
    `Based on your principle "${p.principleText}", which you weight at ${p.weight}/10, ` +
    `this option aligns because: ${p.relevance}`,

  conflictResolved: (winner: AppliedPrinciple, loser: AppliedPrinciple) =>
    `Your principle "${winner.principleText}" (weight ${winner.weight}) ` +
    `takes precedence over "${loser.principleText}" (weight ${loser.weight}) in this case.`,

  contextInfluence: (factor: string, effect: string) =>
    `Given your current ${factor}, this recommendation ${effect}.`,

  differenceFromBaseline: (reason: string) =>
    `This differs from the objectively optimal choice because ${reason}.`
};
```

## Key Sources

### Existing Codebase
- `/workspaces/generacy/packages/knowledge-store/src/types/knowledge.ts` - Foundation types
- `/workspaces/generacy/src/types/` - Pattern for type organization
- `/workspaces/generacy/src/router/` - Pattern for service organization

### Domain Knowledge
- Three-layer decision model (baseline → protégé → human)
- Individual knowledge stores (philosophy, principles, patterns, context)
- Decision fatigue research informing energy level handling

## Alternatives Considered

### Alternative A: LLM-Based Reasoning
**Approach**: Use LLM to generate natural language reasoning
**Pros**: More natural, flexible language
**Cons**: Latency, cost, unpredictability, hallucination risk
**Decision**: Rejected for MVP; can add as optional enhancement later

### Alternative B: Machine Learning for Principle Weights
**Approach**: Learn principle weights from decision outcomes
**Pros**: Improves over time automatically
**Cons**: Requires outcome tracking, cold start problem, less transparent
**Decision**: Deferred; manual weights provide transparency and control

### Alternative C: Multi-Option Recommendations
**Approach**: Return multiple options ranked instead of single recommendation
**Pros**: More information for human
**Cons**: Adds decision burden, defeats purpose of protégé
**Decision**: Rejected; return single best option with reasoning. Conflicts shown in reasoning, not as alternatives.

## Risk Assessment

### Risk 1: Principle Coverage Gaps
**Risk**: Decision domains with no matching principles
**Mitigation**: Fall back to philosophy-level guidance (values, risk tolerance)
**Indicator**: Confidence score reflects coverage

### Risk 2: Circular Reasoning
**Risk**: Principles that reference each other creating loops
**Mitigation**: Principles are evaluated independently; no cross-principle dependencies
**Validation**: Unit tests with principle sets designed to trigger loops

### Risk 3: Stale Context
**Risk**: UserContext not reflecting current state
**Mitigation**: Context is provided per-request; staleness is caller's responsibility
**Documentation**: Clear contract that context must be current
