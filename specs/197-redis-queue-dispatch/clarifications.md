# Clarifications: Redis Queue with Worker Claim and Dispatch

## Batch 1 — 2026-02-18

### Q1: QueueItem Schema Mismatch
**Context**: The issue body defines `QueueItem` with `command: 'start' | 'continue' | 'address-pr-feedback'`, `workflow: string`, `enqueuedAt: number`, and `resumeFromPhase?: string`. However, the existing code in `types/monitor.ts` has `command: 'process' | 'continue'`, `workflowName: string`, `enqueuedAt: string`, and no `resumeFromPhase` field.
**Question**: Should we update the existing `QueueItem` type to match the issue body schema (adding `address-pr-feedback` command, renaming `workflowName` to `workflow`, changing `enqueuedAt` to `number`, adding `resumeFromPhase`), or keep the existing type and treat the issue body schema as aspirational?
**Options**:
- A: Update existing type to match issue body (breaking change for label monitor)
- B: Keep existing type, add only `resumeFromPhase` and `address-pr-feedback` command
- C: Create a new extended interface that includes the additional fields, keep backward compat

**Answer**: *Pending*

### Q2: Extended Queue Interface
**Context**: The existing `QueueAdapter` interface only has `enqueue(item): Promise<void>`. The Redis implementation needs `claim`, `release`, `complete`, `getQueueDepth`, `getQueueItems`, and `getActiveWorkerCount`. This is a significantly broader interface than what the monitor uses.
**Question**: Should `RedisQueueAdapter` extend `QueueAdapter` with additional methods on a new broader interface (e.g., `QueueManager`), or should all methods be added directly to `QueueAdapter`?
**Options**:
- A: Create a new `QueueManager` interface extending `QueueAdapter` with claim/release/complete/query methods
- B: Expand `QueueAdapter` directly with all methods (monitor only uses `enqueue` subset)

**Answer**: *Pending*

### Q3: Worker Handler Interface
**Context**: FR-4 says the dispatcher should "spawn a worker process" via a "callback/handler interface" since actual worker implementation is out of scope. The shape of this interface determines how the dispatcher integrates with the future worker (Claude CLI spawner).
**Question**: What should the worker handler callback signature look like? Should it be a simple async function `(item: QueueItem) => Promise<void>` that the dispatcher awaits, or should it return a handle with cancel/heartbeat control?
**Options**:
- A: Simple async callback `(item: QueueItem) => Promise<void>` — dispatcher manages heartbeat externally
- B: Return a worker handle `{ promise: Promise<void>, cancel: () => void }` — worker controls its own lifecycle
- C: Event-based `WorkerProcess` interface with `onComplete`, `onError`, `onHeartbeat` events

**Answer**: *Pending*

### Q4: Retry Policy on Release
**Context**: FR-3 says released items go back to the pending queue "preserving original priority." But if a worker keeps failing on the same item, it could be re-claimed and re-failed indefinitely, blocking the queue.
**Question**: Should there be a maximum retry count for released items? If so, what happens when the limit is reached (dead-letter, label update, skip)?
**Options**:
- A: No retry limit — keep re-queuing indefinitely (simplest, handle failures externally)
- B: Max 3 retries, then move to a dead-letter set and add a `agent:failed` label
- C: Max 3 retries with exponential backoff on priority score

**Answer**: *Pending*

### Q5: Queue REST API Routes
**Context**: The existing `/queue` routes serve the decision queue (a different system for approval/choice/input/review decisions). The Redis sorted-set queue for issue processing is a separate concern. Dashboard users will need to query queue depth and list items.
**Question**: Should the Redis queue expose its own REST API routes (e.g., `/dispatch/queue`), reuse the existing `/queue` routes by namespace, or be accessible only programmatically (no HTTP API in this issue)?
**Options**:
- A: New route namespace `/dispatch/queue` with GET depth, GET items, GET workers endpoints
- B: No HTTP API in this issue — expose only programmatic methods, add routes in a follow-up
- C: Add to existing `/queue` routes under a sub-path like `/queue/dispatch`

**Answer**: *Pending*
