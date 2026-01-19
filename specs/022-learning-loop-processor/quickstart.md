# Quickstart: Learning Loop Processor

## Installation

The Learning Loop Processor is part of the generacy package.

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Basic Usage

### Processing a Decision

```typescript
import {
  LearningLoopProcessor,
  InMemoryDecisionRepository,
} from 'generacy/learning';

// Create processor with in-memory storage
const repository = new InMemoryDecisionRepository();
const processor = new LearningLoopProcessor({
  repository,
  // Optional: provide knowledge store client
  // knowledgeStore: myKnowledgeStoreClient,
});

// Process a completed decision
const result = await processor.processDecision({
  request: decisionRequest,
  baseline: baselineRecommendation,
  protege: protegeRecommendation,
  finalChoice: 'option-b',
  userId: 'user-123',
});

console.log('Learning result:', result);
// {
//   decisionId: 'dec-456',
//   principlesReinforced: ['principle-1'],
//   principlesContradicted: [],
//   suggestedUpdates: [],
//   metricsImpact: { interventionRateChange: 0, confidenceChange: 0.02 }
// }
```

### Processing an Override with Coaching

```typescript
// When the user overrides the protégé recommendation
const result = await processor.processDecision({
  request: decisionRequest,
  baseline: baselineRecommendation,
  protege: protegeRecommendation,
  finalChoice: 'option-a',  // Different from protege recommendation
  userId: 'user-123',
  coaching: {
    overrideReason: 'missing_context',
    explanation: 'The project timeline changed - we now have a hard deadline in 2 weeks',
    missingContext: 'Timeline constraint: 2-week deadline',
    shouldRemember: true,
  },
});

console.log('Updates suggested:', result.suggestedUpdates);
// [
//   {
//     id: 'update-789',
//     type: 'context_update',
//     confidence: 0.85,
//     reasoning: 'User indicated timeline has changed...',
//     status: 'pending'
//   }
// ]
```

### Handling Update Approval

```typescript
// Get pending updates for a user
const pending = await processor.getPendingUpdates('user-123');

// Approve an update
await processor.approveUpdate('update-789');

// Or reject with reason
await processor.rejectUpdate('update-789', 'This was a one-time exception');
```

## Configuration

### Approval Thresholds

```typescript
const processor = new LearningLoopProcessor({
  repository,
  approvalConfig: {
    // Auto-approve weight changes below this threshold
    weightChangeThreshold: 0.5,

    // Minimum confidence for auto-approval
    minConfidenceForAutoApproval: 0.7,

    // Always require approval for these
    alwaysRequireApproval: ['new_principle', 'principle_refinement'],
  },
});
```

### Custom Repository

```typescript
import { DecisionRepository } from 'generacy/learning';

class MyCustomRepository implements DecisionRepository {
  async save(decision: CapturedDecision): Promise<void> {
    // Save to your database
  }

  async getById(id: string): Promise<CapturedDecision | null> {
    // Retrieve from your database
  }

  async getByUserId(userId: string): Promise<CapturedDecision[]> {
    // Query by user
  }

  async getOverrides(userId: string): Promise<CapturedDecision[]> {
    // Get only overrides
  }

  async count(userId: string): Promise<number> {
    // Count decisions
  }
}
```

## API Reference

### LearningLoopProcessor

Main processor class.

| Method | Description |
|--------|-------------|
| `processDecision(input)` | Process a completed decision |
| `processCoaching(coaching)` | Process coaching data separately |
| `getPendingUpdates(userId)` | Get pending updates for user |
| `approveUpdate(updateId)` | Approve an update |
| `rejectUpdate(updateId, reason)` | Reject an update |
| `applyPendingUpdates(userId)` | Apply all auto-approved updates |

### Types

| Type | Description |
|------|-------------|
| `CapturedDecision` | A captured decision with all context |
| `CoachingData` | Override feedback from human |
| `LearningEvent` | Discrete learning event |
| `KnowledgeUpdate` | Update to apply to knowledge store |
| `LearningResult` | Result of processing a decision |

## Troubleshooting

### No updates generated for override

Check that:
1. `coaching.shouldRemember` is `true`
2. `coaching.overrideReason` is not `exception_case` (these don't generate updates by default)
3. The explanation has enough detail (min 10 characters)

### Update stuck in pending

Updates require manual approval if:
1. They are new principles
2. Weight change exceeds threshold (default 0.5)
3. Confidence is below minimum (default 0.7)

Check approval config or manually approve via `approveUpdate()`.

### Repository not persisting

The `InMemoryDecisionRepository` loses data on restart. For production:
1. Implement `DecisionRepository` interface
2. Connect to your database
3. Pass custom repository to processor
