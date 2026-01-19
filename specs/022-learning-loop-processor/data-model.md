# Data Model: Learning Loop Processor

## Core Entities

### CapturedDecision

Represents a decision that has been made and captured for learning.

```typescript
interface CapturedDecision {
  /** Unique identifier */
  id: string;

  /** User who made the decision */
  userId: string;

  /** When the decision was captured */
  timestamp: Date;

  /** Original decision request */
  request: DecisionRequest;

  /** Baseline recommendation received */
  baseline: BaselineRecommendation;

  /** Protégé recommendation received */
  protege: ProtegeRecommendation;

  /** What the human actually chose */
  finalChoice: string;

  /** Whether this was an override of the protégé recommendation */
  wasOverride: boolean;

  /** Coaching data if this was an override */
  coaching?: CoachingData;

  /** Learning events generated from this decision */
  learningEvents: LearningEvent[];

  /** Link to any knowledge updates generated */
  generatedUpdates: string[];  // Update IDs
}
```

### CoachingData

Data provided when a human overrides a recommendation.

```typescript
interface CoachingData {
  /** Why the human overrode the recommendation */
  overrideReason: OverrideReason;

  /** Human's explanation in their own words */
  explanation: string;

  /** Specific principles that were wrong (if reasoning_incorrect) */
  incorrectPrinciples?: string[];

  /** Missing context that wasn't considered (if missing_context) */
  missingContext?: string;

  /** Updated priorities (if priorities_changed) */
  updatedPriorities?: string[];

  /** Whether this should be remembered for future decisions */
  shouldRemember: boolean;
}

type OverrideReason =
  | 'reasoning_incorrect'   // Protégé applied principles wrongly
  | 'missing_context'       // Protégé didn't know something
  | 'priorities_changed'    // Situation changed
  | 'exception_case';       // One-time deviation
```

### LearningEvent

A discrete learning event from a decision.

```typescript
interface LearningEvent {
  /** Unique identifier */
  id: string;

  /** Type of learning event */
  type: LearningEventType;

  /** When this event occurred */
  timestamp: Date;

  /** Decision that generated this event */
  decisionId: string;

  /** User this event belongs to */
  userId: string;

  /** Event-specific payload */
  payload: LearningEventPayload;
}

type LearningEventType =
  | 'principle_reinforced'    // Principle was followed
  | 'principle_contradicted'  // Principle was overridden
  | 'coaching_received'       // Human provided feedback
  | 'update_proposed';        // Update generated for approval

type LearningEventPayload =
  | PrincipleReinforcedPayload
  | PrincipleContradictedPayload
  | CoachingReceivedPayload
  | UpdateProposedPayload;

interface PrincipleReinforcedPayload {
  principleId: string;
  strength: number;  // How strongly it was applied (0-1)
}

interface PrincipleContradictedPayload {
  principleId: string;
  overrideReason: OverrideReason;
  explanation?: string;
}

interface CoachingReceivedPayload {
  coachingData: CoachingData;
  sourceDecisionId: string;
}

interface UpdateProposedPayload {
  updateId: string;
  updateType: KnowledgeUpdateType;
  requiresApproval: boolean;
}
```

### KnowledgeUpdate

An update to be applied to the knowledge store.

```typescript
interface KnowledgeUpdate {
  /** Unique identifier */
  id: string;

  /** User whose knowledge this updates */
  userId: string;

  /** Type of update */
  type: KnowledgeUpdateType;

  /** When this update was generated */
  generatedAt: Date;

  /** Decision that triggered this update */
  sourceDecisionId: string;

  /** Confidence in this update (0-1) */
  confidence: number;

  /** Human-readable reasoning for this update */
  reasoning: string;

  /** Update-specific payload */
  payload: UpdatePayload;

  /** Approval status */
  status: UpdateStatus;

  /** When status last changed */
  statusUpdatedAt: Date;
}

type KnowledgeUpdateType =
  | 'principle_reinforcement'  // Increase principle weight
  | 'principle_weakening'      // Decrease principle weight
  | 'principle_refinement'     // Add exception or modify applicability
  | 'new_principle'            // Create new principle
  | 'context_update'           // Update user context
  | 'priority_update'          // Update priorities
  | 'exception_note';          // Note exception without update

type UpdatePayload =
  | PrincipleReinforcementPayload
  | PrincipleWeakeningPayload
  | PrincipleRefinementPayload
  | NewPrinciplePayload
  | ContextUpdatePayload
  | PriorityUpdatePayload
  | ExceptionNotePayload;

type UpdateStatus =
  | 'pending'      // Waiting for approval
  | 'approved'     // Approved (auto or manual)
  | 'rejected'     // Rejected by user
  | 'applied';     // Applied to knowledge store
```

### Update Payloads

```typescript
interface PrincipleReinforcementPayload {
  principleId: string;
  currentWeight: number;
  newWeight: number;
  delta: number;
}

interface PrincipleWeakeningPayload {
  principleId: string;
  currentWeight: number;
  newWeight: number;
  delta: number;
  contradictionCount: number;
}

interface PrincipleRefinementPayload {
  principleId: string;
  refinementType: 'add_exception' | 'narrow_applicability' | 'broaden_applicability';
  change: string;  // Description of the change
}

interface NewPrinciplePayload {
  principle: {
    name: string;
    content: string;
    domains: string[];
    suggestedWeight: number;
    source: 'learned';
  };
  evidenceDecisions: string[];  // Decision IDs that support this
}

interface ContextUpdatePayload {
  field: 'constraints' | 'priorities' | 'goals';
  previousValue: unknown;
  newValue: unknown;
}

interface PriorityUpdatePayload {
  previousPriorities: string[];
  newPriorities: string[];
}

interface ExceptionNotePayload {
  note: string;
  relatedPrinciples: string[];
  occurrence: 'single' | 'potential_pattern';
}
```

### LearningResult

Result of processing a decision through the learning loop.

```typescript
interface LearningResult {
  /** Decision that was processed */
  decisionId: string;

  /** Learning events generated */
  learningEvents: LearningEvent[];

  /** Principles that were reinforced (IDs) */
  principlesReinforced: string[];

  /** Principles that were contradicted (IDs) */
  principlesContradicted: string[];

  /** Knowledge updates suggested */
  suggestedUpdates: KnowledgeUpdate[];

  /** Metrics impact estimate */
  metricsImpact: MetricsImpact;
}

interface MetricsImpact {
  /** Estimated change to intervention rate */
  interventionRateChange: number;

  /** Estimated change to protégé confidence */
  confidenceChange: number;
}
```

## Relationships

```
┌─────────────────┐
│ CapturedDecision│
└────────┬────────┘
         │ 1
         │
         │ generates
         │
         │ *
┌────────▼────────┐
│  LearningEvent  │
└────────┬────────┘
         │ *
         │
         │ triggers
         │
         │ *
┌────────▼────────┐
│ KnowledgeUpdate │
└─────────────────┘
```

## Validation Rules

### CapturedDecision
- `id` must be unique (UUID)
- `finalChoice` must be one of the options from `request.options`
- `coaching` required if `wasOverride` is true
- `timestamp` must be after `request.requestedAt`

### CoachingData
- `explanation` required, min 10 characters
- `incorrectPrinciples` required if `overrideReason` is `reasoning_incorrect`
- `missingContext` required if `overrideReason` is `missing_context`
- `updatedPriorities` required if `overrideReason` is `priorities_changed`

### KnowledgeUpdate
- `confidence` must be between 0 and 1
- `reasoning` required, min 20 characters
- Status transitions: `pending` → (`approved` | `rejected`), `approved` → `applied`

## Indexes (for future persistence)

```typescript
// Decision queries
decisions_by_user: userId + timestamp (desc)
decisions_overrides: userId + wasOverride + timestamp (desc)
decisions_by_id: id

// Learning events
events_by_decision: decisionId
events_by_user: userId + timestamp (desc)
events_by_type: userId + type + timestamp (desc)

// Knowledge updates
updates_by_user: userId + status
updates_pending: status='pending' + userId
updates_by_decision: sourceDecisionId
```
