# Research: Queue Priority for Resume/Retry vs New Workflows

## Technology Decisions

### Redis Sorted Set Scoring

The queue uses `ZADD` with numeric scores and `ZPOPMIN` for claim. The scoring scheme exploits the numeric range:

- `0.{timestamp}` → e.g., `0.1711036800000` ≈ 0.17 (resume tier)
- `1.{timestamp}` → e.g., `1.1711036800000` ≈ 1.17 (retry tier)
- `Date.now()` → e.g., `1711036800000` ≈ 1.7×10¹² (new tier)

This creates natural tier separation with FIFO ordering within each tier via the timestamp sub-component.

### Floating-Point Precision

JavaScript `Number` (IEEE 754 double) has 53 bits of significand → ~15.95 significant decimal digits.

- `parseFloat('0.1711036800000')` = 14 significant digits → safe
- `parseFloat('1.1711036800000')` = 14 significant digits → safe
- Redis stores scores as doubles with the same precision

No precision concerns for timestamps through ~2286 (when `Date.now()` reaches 10¹³).

### Priority Computation Location

**Decision**: Adapters compute priority (not callers).

**Alternatives considered**:
1. **Caller-side helper** — Each enqueue site calls `getPriorityScore(reason)` and sets `priority`. Simpler adapter code, but scatters the priority formula across call sites. If the formula changes, multiple sites need updating.
2. **Adapter-side computation** (chosen) — Callers set `queueReason`; adapters derive `priority`. Centralizes the formula. `priority` field on `QueueItem` becomes adapter-managed.
3. **Both** — Callers set priority AND adapters have fallback. Redundant; confusing ownership.

Option 2 was chosen per clarification Q1:B. The `priority` field remains on `QueueItem` for observability (queue listing endpoints expose it), but its value is set by the adapter, not the caller.

### `queueReason` as Optional Field

Making `queueReason` optional on `QueueItem` (rather than required) ensures:
- Backwards compatibility with items already in Redis that lack the field
- Adapters can handle `undefined` by defaulting to `Date.now()` (same as current behavior)
- No migration needed for in-flight queue items

## Implementation Patterns

### Adapter Pattern for Priority Override

Both adapters follow the same pattern in `enqueue()`:
```typescript
async enqueue(item: QueueItem): Promise<void> {
  const priority = getPriorityScore(item.queueReason);
  // Use `priority` for ZADD score / insertSorted, not item.priority
}
```

### Release → Retry Promotion

In `release()`, when re-queuing a failed item:
```typescript
const retryPriority = getPriorityScore('retry');
const requeueItem = { ...item, queueReason: 'retry' as const };
// Use retryPriority as the ZADD score
```

This ensures retried items are promoted above new items but below resumes.
