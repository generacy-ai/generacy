# Research: Per-User Execution Lease Protocol

## Technology Decisions

### 1. Lease Manager as Standalone Service

**Decision**: Create a new `LeaseManager` class rather than embedding lease logic in `WorkerDispatcher`.

**Rationale**:
- `WorkerDispatcher` already has queue polling, heartbeat management, reaper logic, and graceful shutdown — adding lease state would violate SRP
- `LeaseManager` can be tested in isolation with a mock relay client
- Follows the existing pattern: `RelayBridge` delegates to `ConversationManager` via setter injection; we follow the same pattern for `LeaseManager`

**Alternatives considered**:
- **Embed in WorkerDispatcher**: Simpler initially but creates a god class with too many responsibilities. Harder to test lease logic in isolation.
- **Embed in RelayBridge**: Bridge is already a message router — adding state management would break its single concern of routing.

### 2. Promise-Based Lease Request with Timeout

**Decision**: `requestLease()` returns a `Promise<LeaseResponse>` that resolves when the cloud responds or rejects after 30s.

**Rationale**:
- The dispatch loop is already async (`pollOnce` is `async`)
- A promise-based API integrates naturally: `const result = await leaseManager.requestLease(...)`
- The 30s timeout matches the heartbeat interval (clarification Q1) and prevents indefinite blocking
- Correlation ID in the request maps responses back to the correct pending promise

**Alternatives considered**:
- **Event-based (emit/listen)**: More flexible but harder to reason about in the sequential dispatch flow. Would require manual state tracking in the dispatcher.
- **Callback-based**: Less ergonomic than promises in modern TypeScript.

### 3. Heartbeat via Relay WebSocket (not HTTP)

**Decision**: Send `lease_heartbeat` messages through the existing relay WebSocket connection.

**Rationale**:
- The relay WebSocket is already established and persistent
- Heartbeats are fire-and-forget from the cloud's perspective (clarification Q2) — no acknowledgment needed
- Failure detection is based on WebSocket send failures (connection dropped), not response timeouts
- Aligns with existing `RelayBridge.emitJobEvent()` fire-and-forget pattern

**Alternatives considered**:
- **HTTP heartbeat endpoint**: Would require a separate HTTP client, add latency, and create a second connection path to manage.
- **Redis-based heartbeat with cloud polling**: Would require the cloud to poll Redis, adding complexity and latency to the enforcement model.

### 4. Consecutive Failure Threshold (N=3)

**Decision**: Expire a lease after 3 consecutive heartbeat send failures, not on a single failure.

**Rationale**:
- Clarification Q2 explicitly chose option B with N=3 as default
- 3 failures × 30s interval = 90s total, which matches the cloud-side sweep TTL
- Single packet drops are common in containerized environments
- Configurable via `LeaseConfig.maxHeartbeatFailures`

### 5. userId = Cluster Owner

**Decision**: The `userId` in lease requests is the cluster owner (the person whose API key authenticates the relay connection), not the issue author or workflow trigger.

**Rationale**:
- Per-seat billing is per-user: each user's concurrent workflow count is capped
- All workflows dispatched from a cluster count against the cluster owner's limits
- The API key used for relay authentication already identifies the cluster owner
- The cloud can extract userId from the authenticated relay session — the orchestrator just needs to include it for explicit correlation

**Source**: Spec line: "The userId is the cluster owner — all workflows dispatched from a cluster count against that user's per-seat limits."

### 6. Graceful Fallback When Cloud Not Ready

**Decision**: If `tier_info` has not been received or relay is disconnected, skip lease gating and operate uncapped.

**Rationale**:
- The cloud-side lease service (`generacy-cloud#391`) may not ship simultaneously
- Clusters should continue functioning without the billing enforcement layer
- Once `tier_info` is received, lease gating activates automatically
- This avoids a hard dependency between orchestrator and cloud releases

## Implementation Patterns

### Event Emitter for Cross-Service Communication

`LeaseManager` extends `EventEmitter` to notify the dispatcher of async events:
- `lease:expired` — heartbeat failure threshold exceeded
- `slot:available` — cloud sent slot_available message
- `cluster:rejected` — cluster connection rejected by cloud

This follows Node.js conventions and decouples the lease manager from dispatcher internals.

### Correlation ID Pattern for Request-Response

Lease requests use a `correlationId` (UUID) to match responses:
```
lease_request  → { correlationId, userId, queueItemId, jobId }
lease_granted  → { correlationId, leaseId, ... }
lease_denied   → { correlationId, reason, ... }
```

The `LeaseManager` maintains a `pendingRequests` map from correlationId to `{ resolve, reject, timer }`. This is the same pattern used by `RelayBridge` for API request/response correlation.

### Duplicate Re-enqueue Guard

When the orchestrator re-enqueues after heartbeat expiry, it must check whether the cloud sweep has already re-enqueued the same item. The guard checks `queue.getQueueItems()` for a matching `itemKey` before calling `queue.enqueue()`. This prevents duplicate work items in the queue.

## Key Sources

- `docs/billing-concurrent-workflow-enforcement.md` in tetrad-development — canonical billing enforcement architecture
- `generacy-ai/generacy-cloud#391` — cloud-side lease service implementation
- `specs/418-summary-update-orchestrator/clarifications.md` — design decisions from Q&A
- `packages/orchestrator/src/services/worker-dispatcher.ts` — existing dispatch flow to modify
- `packages/orchestrator/src/services/relay-bridge.ts` — existing relay message routing
