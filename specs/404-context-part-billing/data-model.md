# Data Model: Queue Priority for Resume/Retry vs New Workflows

## Type Changes

### New Type: `QueueReason`

```typescript
// packages/orchestrator/src/types/monitor.ts
export type QueueReason = 'new' | 'resume' | 'retry';
```

| Value | Priority Score | Use Case |
|-------|---------------|----------|
| `'resume'` | `0.{timestamp}` | Continue in-progress work (label resume, PR feedback) |
| `'retry'` | `1.{timestamp}` | Re-attempt failed work (release() re-queue) |
| `'new'` | `Date.now()` | Fresh issue trigger |

### Modified Interface: `QueueItem`

```typescript
export interface QueueItem {
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  command: 'process' | 'continue' | 'address-pr-feedback';
  priority: number;
  enqueuedAt: string;
  metadata?: Record<string, unknown>;
  queueReason?: QueueReason;  // NEW — optional for backwards compat
}
```

The `priority` field remains but is now **adapter-managed**. Callers set `queueReason`; adapters compute `priority` from it.

### Unchanged Interface: `SerializedQueueItem`

`SerializedQueueItem extends QueueItem` — inherits `queueReason` automatically. No changes needed.

## Priority Score Function

```typescript
// packages/orchestrator/src/services/queue-priority.ts
export function getPriorityScore(reason: QueueReason | undefined): number {
  const timestamp = Date.now();
  switch (reason) {
    case 'resume': return parseFloat(`0.${timestamp}`);
    case 'retry':  return parseFloat(`1.${timestamp}`);
    case 'new':
    default:       return timestamp;
  }
}
```

## Queue Item Flow

### Enqueue (new/resume)
```
Caller → sets queueReason → adapter.enqueue()
  → getPriorityScore(queueReason) → ZADD with computed score
```

### Claim → Release (retry)
```
adapter.claim() → returns QueueItem with queueReason
  → worker fails → adapter.release(workerId, item)
    → sets queueReason: 'retry' → getPriorityScore('retry') → ZADD with retry score
```

### Backwards Compatibility
```
Old item (no queueReason) → adapter.enqueue()
  → getPriorityScore(undefined) → Date.now() → same behavior as before
```

## Validation Rules

- `queueReason` is optional — `undefined` treated as `'new'`
- Priority score is always computed by adapters, never trusted from caller input
- Items without `queueReason` in Redis are valid (pre-migration items)
