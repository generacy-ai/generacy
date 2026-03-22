# Quickstart: Queue Priority for Resume/Retry vs New Workflows

## What Changed

Queue items now have a `queueReason` field that determines their dequeue priority:
- **Resume** items (in-progress work) are dispatched first
- **Retry** items (failed work being re-attempted) are dispatched second
- **New** items (fresh issue triggers) are dispatched last

## No Configuration Needed

The priority scheme is automatic. No new environment variables or config changes.

## Verifying Priority Ordering

### Via Queue Items API

```bash
curl http://localhost:3001/dispatch/queue/items?offset=0&limit=10
```

Items are returned in priority order. Check the `queueReason` and `priority` fields:
- Resume items: `queueReason: "resume"`, `priority: 0.17xxxxxxxxxx`
- Retry items: `queueReason: "retry"`, `priority: 1.17xxxxxxxxxx`
- New items: `queueReason: "new"`, `priority: 17xxxxxxxxxx`

### Via Logs

Enqueue log lines include the computed priority and queue reason:
```
Item enqueued to Redis sorted set { queueReason: "resume", priority: 0.1711036800000, ... }
```

## Running Tests

```bash
cd packages/orchestrator
pnpm test -- queue-priority
pnpm test -- redis-queue-adapter
pnpm test -- in-memory-queue-adapter
```

## Backwards Compatibility

- Items already in Redis (without `queueReason`) continue to work — they get `Date.now()` priority, same as before
- The `queueReason` field is optional on `QueueItem`
- No migration needed
