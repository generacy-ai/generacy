# Research: Learning Loop Processor

## Technology Decisions

### Storage Pattern: Repository with Pluggable Backend

**Decision**: Use repository pattern with in-memory storage for MVP

**Rationale**:
- Aligns with existing architecture's plugin extensibility emphasis
- Allows starting with in-memory for testing/MVP
- Backend can be swapped without changing business logic
- Future options include Graphiti/FalkorDB/Neo4j per architecture docs

**Alternatives Considered**:
1. **Direct database integration** - Too coupled, harder to test
2. **Event sourcing** - Overkill for MVP, adds complexity
3. **Simple in-memory only** - Not extensible enough

### Coaching Processing: Structured Override Reasons

**Decision**: Use enumerated override reasons with structured handling

**Rationale**:
- Clear mapping from reason → action makes logic predictable
- Easier to test and validate
- Can add new reasons incrementally
- Aligns with spec's `CoachingData.overrideReason` design

**Override Reason Handling**:
| Reason | Action | Update Type |
|--------|--------|-------------|
| `reasoning_incorrect` | Refine principle applicability | `principle_refinement` |
| `missing_context` | Add context or new principle | `context_update` or `new_principle` |
| `priorities_changed` | Update current context | `priority_update` |
| `exception_case` | Note but don't update (unless pattern) | `exception_note` |

### Approval Classification: Impact-Based

**Decision**: Classify updates by impact for auto vs manual approval

**Rationale**:
- Aligns with "Do Without Doing" philosophy
- Reduces human attention burden for routine updates
- Preserves human control for significant changes

**Classification Thresholds**:
```typescript
const APPROVAL_THRESHOLDS = {
  // Auto-approve if below these thresholds
  weightChange: 0.5,        // Principle weight change < 0.5
  confidenceMin: 0.7,       // Update confidence > 0.7

  // Always require manual approval for:
  newPrinciple: true,       // Any new principle
  domainChange: true,       // Domain addition/removal
  boundaryImpact: true,     // Updates affecting boundaries
};
```

## Implementation Patterns

### 1. Decision Capture Pattern

```typescript
interface CapturedDecision {
  id: string;
  timestamp: Date;
  request: DecisionRequest;
  baseline: BaselineRecommendation;
  protege: ProtegeRecommendation;
  finalChoice: string;  // What human actually chose
  wasOverride: boolean;
  coaching?: CoachingData;
  learningEvents: LearningEvent[];
}
```

### 2. Knowledge Update Pipeline

```
Decision → [if override] → Coaching → UpdateGenerator → ApprovalClassifier
                                            ↓
                                    UpdateQueue
                                            ↓
                          [auto-approved] ──→ KnowledgeStore
                          [needs-review] ──→ PendingUpdates
```

### 3. Event-Driven Learning

Each decision generates `LearningEvent` objects:
- `principle_reinforced` - Principle was followed
- `principle_contradicted` - Principle was overridden
- `coaching_received` - Human provided feedback
- `update_proposed` - Update generated for approval

## Key Interfaces

### DecisionRepository Interface

```typescript
interface DecisionRepository {
  save(decision: CapturedDecision): Promise<void>;
  getById(id: string): Promise<CapturedDecision | null>;
  getByUserId(userId: string, options?: QueryOptions): Promise<CapturedDecision[]>;
  getOverrides(userId: string): Promise<CapturedDecision[]>;
  count(userId: string): Promise<number>;
}
```

### KnowledgeStoreClient Interface

```typescript
interface KnowledgeStoreClient {
  applyUpdate(update: KnowledgeUpdate): Promise<ApplyResult>;
  getPrinciple(id: string): Promise<Principle | null>;
  getPattern(id: string): Promise<Pattern | null>;
  getUserKnowledge(userId: string): Promise<IndividualKnowledge>;
}
```

### UpdateQueue Interface

```typescript
interface UpdateQueue {
  enqueue(update: QueuedUpdate): Promise<void>;
  getPending(userId: string): Promise<QueuedUpdate[]>;
  approve(updateId: string): Promise<void>;
  reject(updateId: string, reason: string): Promise<void>;
  getAutoApproved(): AsyncIterable<QueuedUpdate>;
}
```

## References

### Internal Documentation
- `docs/humancy-knowledge-architecture.md` - Core knowledge entities
- `src/recommendation/types/knowledge.ts` - Existing knowledge types
- `src/recommendation/engine/protege-engine.ts` - Recommendation flow

### External Resources
- Three-layer decision model design
- Principle-based learning systems
- Human-in-the-loop ML patterns
