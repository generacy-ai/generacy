# Data Model: Show 'waiting for slot' indicator on queued workflows

## Existing Entities (No Changes Required)

### QueueItem (unchanged)
```typescript
interface QueueItem {
  id: string;
  workflowId: string;
  workflowName: string;
  status: QueueStatus;          // 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  priority: QueuePriority;      // 'low' | 'normal' | 'high' | 'urgent'
  repository?: string;
  assigneeId?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  waitingFor?: string;          // Used for human-input gates only
  progress?: QueueItemProgressSummary;
  labels?: string[];
}
```

### Organization (unchanged — fields already exist)
```typescript
interface Organization {
  id: string;
  name: string;
  slug: string;
  tier: 'starter' | 'team' | 'enterprise';
  seats: number;
  maxConcurrentAgents: number;   // Tier-defined limit
  activeExecutions?: number;     // Currently running workflow count
  createdAt: string;
}
```

## New Types (Frontend Only)

### OrgCapacity
Derived from Organization data, used by UI components to determine slot-waiting state.

```typescript
interface OrgCapacity {
  activeExecutions: number;       // Current count of running workflows
  maxConcurrentAgents: number;    // Tier limit
  isAtCapacity: boolean;          // activeExecutions >= maxConcurrentAgents
}
```

### SlotWaitingContext (for tooltip/detail display)
```typescript
interface SlotWaitingContext {
  isSlotWaiting: boolean;
  capacityLabel?: string;         // e.g., "3/3 execution slots in use"
}
```

## Derivation Rules

### Slot-Waiting Determination
```
isSlotWaiting(item, capacity) =
  item.status === 'pending'
  AND capacity.isAtCapacity === true
```

### Capacity Label
```
capacityLabel(capacity) =
  `${capacity.activeExecutions}/${capacity.maxConcurrentAgents} execution slots in use`
```

## Relationships

```
Organization (1) ──── has ──── (*) QueueItem
     │                              │
     │ maxConcurrentAgents          │ status
     │ activeExecutions             │
     │                              │
     └──── derives ────► OrgCapacity
                              │
                              └──── combines with QueueItem
                                    to derive SlotWaitingContext
```

## Validation Rules

- `maxConcurrentAgents` must be > 0 (except enterprise = -1 for unlimited)
- `activeExecutions` must be >= 0
- When `maxConcurrentAgents` is -1 (unlimited), `isAtCapacity` is always `false`
- `isSlotWaiting` can only be `true` when `status === 'pending'`
