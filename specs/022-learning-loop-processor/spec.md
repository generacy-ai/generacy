# Feature Specification: Learning loop processor

**Branch**: `022-learning-loop-processor` | **Date**: 2026-01-19 | **Status**: Draft

## Summary

## Summary

Implement the learning loop processor - the component that processes human decisions and coaching into knowledge updates.

## Parent Epic

#2 - Generacy Core Package

## Dependencies

- generacy-ai/contracts - Learning loop and coaching schemas
- generacy-ai/contracts - Knowledge store schemas

## Purpose

When humans make decisions (especially overrides), this is valuable training data. The learning loop:
1. Captures decision + outcome
2. Processes any coaching provided
3. Detects patterns from decision history
4. Proposes principle updates
5. Applies approved changes to knowledge stores

## The Learning Flow

```
Decision Made
    ↓
Was it an override? ──Yes──→ Coaching Capture
    │                              ↓
    │                        Process Coaching
    │                              ↓
    ↓                        Generate Updates
Add to History ◄───────────────────┘
    ↓
Pattern Detection
    ↓
Principle Refinement
    ↓
Knowledge Store Update
```

## Implementation

### LearningLoopProcessor
```typescript
interface LearningLoopProcessor {
  // Process a completed decision
  processDecision(decision: ThreeLayerDecision): Promise<LearningResult>;
  
  // Process coaching from override
  processCoaching(coaching: CoachingData): Promise<KnowledgeUpdate[]>;
  
  // Detect patterns from decision history
  detectPatterns(userId: string): Promise<PatternCandidate[]>;
  
  // Apply approved updates to knowledge
  applyUpdate(update: KnowledgeUpdate): Promise<void>;
}

interface LearningResult {
  decisionId: string;
  
  // What was learned
  patternsDetected: PatternCandidate[];
  principlesReinforced: string[];  // Principle IDs
  
  // Suggested actions
  suggestedUpdates: KnowledgeUpdate[];
  
  // Metrics impact
  metricsImpact: {
    interventionRate: number;  // Change in rate
    confidenceChange: number;  // Protégé confidence delta
  };
}
```

### Coaching Processing
```typescript
async function processCoaching(coaching: CoachingData): Promise<KnowledgeUpdate[]> {
  const updates: KnowledgeUpdate[] = [];
  
  switch (coaching.overrideReason) {
    case 'reasoning_incorrect':
      // Protégé applied principles wrongly
      // → Refine principle applicability
      updates.push(createPrincipleRefinement(coaching));
      break;
      
    case 'missing_context':
      // Protégé didn't know something
      // → Update context or add new principle
      updates.push(createContextUpdate(coaching));
      break;
      
    case 'priorities_changed':
      // Situation changed
      // → Update current context
      updates.push(createPriorityUpdate(coaching));
      break;
      
    case 'exception_case':
      // One-time deviation
      // → Note but don't update principles
      // (unless pattern emerges)
      break;
  }
  
  return updates;
}
```

### Pattern Detection
```typescript
interface PatternDetector {
  // Analyze decision history for regularities
  analyzeHistory(
    userId: string,
    decisions: ThreeLayerDecision[]
  ): PatternCandidate[];
  
  // Check if pattern should become principle
  evaluateForPromotion(pattern: PatternCandidate): PromotionEvaluation;
}

interface PromotionEvaluation {
  shouldPromote: boolean;
  confidence: number;
  suggestedPrinciple?: {
    statement: string;
    domain: string[];
    applicability: {
      when: string[];
      unless: string[];
    };
  };
  reasoning: string;
}
```

## Features

### Decision Capture
- Store all three-layer decisions
- Link decisions to knowledge updates
- Build evidence trails for principles

### Coaching Analysis
- Parse override reasons
- Extract learning from explanations
- Generate appropriate updates

### Pattern Detection
- Statistical analysis of decision history
- Identify regularities (e.g., "85% choose X when Y")
- Cluster similar decisions
- Detect domain-specific patterns

### Principle Refinement
- Reinforce confirmed principles (increase weight)
- Weaken contradicted principles
- Add exceptions from override patterns
- Deprecate consistently wrong principles

### Update Verification
- Propose updates for human review
- Explain reasoning behind proposed changes
- Track applied vs rejected updates

## Acceptance Criteria

- [ ] Processes all decisions into learning events
- [ ] Extracts learning from coaching data
- [ ] Detects patterns from decision history
- [ ] Generates principle refinement suggestions
- [ ] Reinforces/weakens principles based on outcomes
- [ ] Proposes new principles from consistent patterns
- [ ] Tracks update history and reasoning
- [ ] Human can approve/reject suggested updates

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Clarified Decisions

### Decision Storage (Q1)
**Decision**: Repository pattern with pluggable backend
- Start with in-memory storage for testing/MVP
- Allow swapping backends without changing business logic
- Aligns with architecture's plugin extensibility emphasis

### Pattern Detection Thresholds (Q2)
**Decision**: Configurable thresholds per domain/user
- Default thresholds: 5+ occurrences, 80%+ consistency
- Thresholds can be overridden per domain or user
- Supports personalization for different decision styles

### Update Approval UX (Q3)
**Decision**: Auto-approve low-impact, require approval for high-impact
- Auto-approve: Low-confidence principle reinforcements (small weight increases)
- Require approval: New principles, significant weight changes
- Aligns with "Do Without Doing" philosophy - minimize unnecessary human intervention

### Knowledge Store Integration (Q4)
**Decision**: Call existing knowledge store API (#24 Knowledge Store Management)
- This processor generates `KnowledgeUpdate` objects
- Delegates actual storage to the knowledge store component
- Clear separation of concerns between learning and storage

### MVP Scope (Q5)
**Decision**: Core learning only for initial implementation
- **In scope**: Decision capture, coaching processing
- **Deferred**: Pattern detection (added incrementally)
- Focuses on foundation that feeds the entire system

## Assumptions

- Knowledge Store Management (#24) provides the storage API
- Contract schemas from generacy-ai/contracts are available
- In-memory storage is acceptable for initial MVP

## Out of Scope

- Pattern detection algorithms (deferred to later iteration)
- Complex statistical analysis of decision history
- Real-time pattern streaming
- Multi-tenant isolation (single user context for MVP)

---

*Generated by speckit*
