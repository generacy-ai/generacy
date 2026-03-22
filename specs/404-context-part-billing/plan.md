# Implementation Plan: Queue Priority for Resume/Retry vs New Workflows

**Feature**: Tiered priority scoring so resumes dequeue before retries, retries before new items
**Branch**: `404-context-part-billing`
**Status**: Complete

## Summary

Replace the flat `Date.now()` priority on all enqueue sites with a three-tier scheme:
- **Resume** (`0.{timestamp}`) — finish in-progress work first
- **Retry** (`1.{timestamp}`) — re-attempt failed work before starting new
- **New** (`Date.now()`) — fresh issue triggers, FIFO within this tier

Priority computation is centralized in the queue adapters (per clarification Q1:B). Callers set `queueReason` on the `QueueItem`; adapters derive the numeric score. The `release()` path sets retry priority (per Q2:A). PR feedback uses resume priority (per Q3:B).

## Technical Context

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js
- **Package**: `packages/orchestrator/`
- **Queue backing**: Redis sorted set (`ZADD`/`ZPOPMIN`) + in-memory adapter for local dev
- **Test framework**: Vitest
- **Key invariant**: Lower ZADD score = higher priority. `0.{ts}` < `1.{ts}` < `Date.now()` (~1.7×10¹²)

## Design Decisions

### D1: Priority computation lives in adapters (not callers)
Per clarification Q1:B. Callers set `queueReason` on the item; `enqueue()` and `release()` compute the numeric `priority` internally. This centralizes the scoring formula and avoids scattering `getPriorityScore()` calls across enqueue sites.

### D2: Shared `getPriorityScore()` helper
Extract a pure function used by both `RedisQueueAdapter` and `InMemoryQueueAdapter`. Place it in a small utility module (`services/queue-priority.ts`) to avoid duplicating the formula.

### D3: `release()` always uses retry priority
Per clarification Q2:A. When a failed item is re-queued, `release()` overrides its priority to `1.{timestamp}` and sets `queueReason: 'retry'`, regardless of the original reason.

### D4: `claim()` preserves `queueReason` on returned QueueItem
Both adapters explicitly reconstruct the QueueItem in `claim()`. Must include `queueReason` in the returned object so downstream consumers (dispatch routes, worker info) can observe the reason.

### D5: PR feedback uses resume priority
Per clarification Q3:B. `address-pr-feedback` items continue in-progress work and should be dispatched ahead of fresh issue triggers.

## Project Structure

```
packages/orchestrator/src/
├── types/
│   └── monitor.ts                          # MODIFY — add QueueReason type, queueReason field
├── services/
│   ├── queue-priority.ts                   # CREATE — getPriorityScore() helper
│   ├── redis-queue-adapter.ts              # MODIFY — use priority helper in enqueue/release, pass queueReason through claim
│   ├── in-memory-queue-adapter.ts          # MODIFY — same as redis adapter
│   ├── label-monitor-service.ts            # MODIFY — set queueReason on enqueue
│   └── pr-feedback-monitor-service.ts      # MODIFY — set queueReason: 'resume' on enqueue
└── ...

packages/orchestrator/tests/unit/services/
├── queue-priority.test.ts                  # CREATE — unit tests for priority helper
├── redis-queue-adapter.test.ts             # MODIFY — add priority ordering tests
└── in-memory-queue-adapter.test.ts         # MODIFY — add priority ordering tests
```

## Implementation Steps

### Step 1: Add `QueueReason` type and `queueReason` field

**File**: `packages/orchestrator/src/types/monitor.ts`

- Add `export type QueueReason = 'new' | 'resume' | 'retry';`
- Add optional `queueReason?: QueueReason` field to `QueueItem` interface (optional for backwards compat — items without it default to `Date.now()`)

### Step 2: Create priority score helper

**File**: `packages/orchestrator/src/services/queue-priority.ts` (new)

```typescript
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

### Step 3: Update `RedisQueueAdapter`

**File**: `packages/orchestrator/src/services/redis-queue-adapter.ts`

- **`enqueue()`**: Compute `priority` from `item.queueReason` via `getPriorityScore()`, ignoring the caller-provided `priority` value.
- **`claim()`**: Include `queueReason` in the returned QueueItem reconstruction (line ~130).
- **`release()`**: When re-queuing (not dead-lettering), set `queueReason: 'retry'` and compute priority via `getPriorityScore('retry')` instead of using `item.priority`.

### Step 4: Update `InMemoryQueueAdapter`

**File**: `packages/orchestrator/src/services/in-memory-queue-adapter.ts`

- Mirror all changes from Step 3.
- **`enqueue()`**: Compute priority from `item.queueReason`.
- **`claim()`**: Include `queueReason` in returned QueueItem.
- **`release()`**: Set `queueReason: 'retry'` and use retry priority on re-queue.

### Step 5: Update `LabelMonitorService` enqueue site

**File**: `packages/orchestrator/src/services/label-monitor-service.ts`

- In `processLabelEvent()` (~line 297), set `queueReason` based on event type:
  - `type === 'process'` → `queueReason: 'new'`
  - `type === 'resume'` (command: 'continue') → `queueReason: 'resume'`
- The `priority` field value no longer matters (adapter overrides it), but keep `Date.now()` for backwards-readable logging.

### Step 6: Update `PrFeedbackMonitorService` enqueue site

**File**: `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`

- In `processPrReviewEvent()` (~line 196), set `queueReason: 'resume'` on the queue item.

### Step 7: Write unit tests for priority helper

**File**: `packages/orchestrator/tests/unit/services/queue-priority.test.ts` (new)

- Test that `getPriorityScore('resume')` returns `0.{timestamp}` range
- Test that `getPriorityScore('retry')` returns `1.{timestamp}` range
- Test that `getPriorityScore('new')` returns `Date.now()` range
- Test that `getPriorityScore(undefined)` returns `Date.now()` (backwards compat)
- Test ordering: resume < retry < new

### Step 8: Add priority ordering tests to queue adapters

**Files**: `tests/unit/services/redis-queue-adapter.test.ts`, `tests/unit/services/in-memory-queue-adapter.test.ts`

- Enqueue three items with `queueReason: 'new'`, `'retry'`, `'resume'` and verify claim order is resume → retry → new.
- Enqueue + claim + release an item; verify re-queued item gets retry priority and dequeues before a new item.
- Enqueue an item with no `queueReason`; verify it gets `Date.now()` priority (backwards compat).

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| `parseFloat('0.1711036800000')` precision loss | JS can represent up to ~15 significant digits; `0.` + 13-digit timestamp = 14 digits total, within safe range. Verify in unit test. |
| Existing items in Redis have no `queueReason` | `getPriorityScore(undefined)` falls through to `Date.now()` — same behavior as today. |
| `claim()` returns items without `queueReason` for old items | Field is optional (`queueReason?`), consumers must handle `undefined`. |
| Dead-letter items inherit stale priority | Dead-lettered items exit the queue; priority is irrelevant. |
