# Clarifications — #418 Add Per-User Lease Protocol to Orchestrator

## Batch 1 — 2026-04-05

### Q1: Lease Request Timeout
**Context**: FR-001 says the orchestrator must wait for `lease_granted` or `lease_denied`, but doesn't specify what happens if the cloud never responds. Without a timeout, the orchestrator could block indefinitely, stalling all queued work.
**Question**: What should the timeout be for waiting on a `lease_request` response, and what should the orchestrator do on timeout — retry the request, re-enqueue the item, or surface an error?
**Options**:
- A: Timeout after N seconds, re-enqueue item with retry priority (1), back off and retry
- B: Timeout after N seconds, treat as transient failure, retry immediately up to a max count
- C: No timeout needed — the relay guarantees a response

**Answer**: A — Timeout after 30 seconds (one heartbeat interval), re-enqueue with retry priority (1), and back off before retrying. The relay doesn't guarantee a response — network issues or cloud downtime could cause silence. A 30s timeout aligns with the heartbeat cadence and avoids blocking the dispatch loop for too long.

### Q2: Heartbeat Failure Semantics
**Context**: FR-006 says "on heartbeat failure, expire lease and re-enqueue work item" but doesn't define what constitutes a failure. A single dropped packet shouldn't expire a lease, but an unresponsive cloud should.
**Question**: What counts as a heartbeat failure — a single missed acknowledgment, N consecutive failures, or a specific error response from the cloud? Should the orchestrator retry before expiring the lease?
**Options**:
- A: Single failure = expired (strict, simple)
- B: N consecutive failures before expiring (tolerant, configurable threshold)
- C: Cloud explicitly responds with a rejection/expiry message

**Answer**: B — N consecutive failures before expiring, with N=3 as the default (configurable). Heartbeats are fire-and-forget from the cloud's perspective — the cloud does NOT acknowledge them. So "failure" on the orchestrator side means the relay WebSocket send itself failed (connection dropped, write error). A single transient blip shouldn't expire a lease, but 3 consecutive failures (over ~90 seconds at 30s intervals) signals a real disconnect — which aligns with the cloud-side sweep TTL of 90 seconds. After 3 failures, the orchestrator should treat the lease as expired locally, cancel the worker, and re-enqueue.

### Q3: userTierLimit Source for Worker Cap
**Context**: FR-009 caps workers at `min(configuredWorkers, userTierLimit)`. The spec assumes tier limits come via lease protocol responses, but doesn't specify exactly how. The orchestrator needs to know the limit *before* making lease requests to set its worker count.
**Question**: How does the orchestrator learn the `userTierLimit`? Is it a field in the `lease_granted` response, a separate message sent on relay connection, or provided through another mechanism?
**Options**:
- A: Included as a field in every `lease_granted` response
- B: Sent as a separate `tier_info` message on relay connection
- C: Fetched via an API call on startup

**Answer**: B — Sent as a separate `tier_info` message on relay connection. The current cloud implementation does NOT send tier info on connection or in lease responses — it only evaluates limits server-side. However, the orchestrator needs the limit for worker capping (FR-009). The cleanest approach: after relay handshake, the cloud should respond with a `tier_info` message containing `{ maxConcurrentWorkflows, maxActiveClusters, tier }`. This is a small addition to the cloud relay handler. For now, if you need to ship without a cloud change, you could fall back to not capping (use configuredWorkers only) and add the tier_info message as a follow-up. But option B is the right design.

### Q4: Re-enqueue Priority After Heartbeat Failure
**Context**: When a lease expires due to heartbeat failure, the work item is re-enqueued. The spec defines three priority tiers (resume=0, retry=1, new=Date.now()) but doesn't specify which applies to heartbeat-expired items. Additionally, the worker may still be executing the work.
**Question**: What priority should a heartbeat-expired item get when re-enqueued? And should the orchestrator signal the worker to abort the in-flight work, or let it complete silently?
**Options**:
- A: Re-enqueue as resume (priority 0), cancel the worker
- B: Re-enqueue as retry (priority 1), cancel the worker
- C: Re-enqueue as resume (priority 0), let the worker finish (result discarded if no lease)

**Answer**: A — Re-enqueue as resume (priority 0) and cancel the worker. The work was in progress so it should be resumed first (ahead of retries and new work). Cancel the worker because without a valid lease, any completed work would be in an ambiguous state — better to restart cleanly. Note: the cloud-side sweep also re-enqueues with retry priority (1) and has a max retry count of 3 before permanently failing. Since the cloud sweep may also fire on the same expired lease, the orchestrator should check whether the queue item is already re-enqueued before adding a duplicate.

### Q5: slot_available Message Targeting
**Context**: The spec says the orchestrator listens for `slot_available` from cloud and dequeues the next item. It's unclear whether this message is broadcast to all of a user's clusters or sent to a specific cluster. This affects whether the orchestrator should race to claim the slot or can assume exclusive access.
**Question**: Is `slot_available` sent to all clusters belonging to the user (broadcast) or routed to a specific cluster? Does the message carry any payload (e.g., number of available slots)?
**Options**:
- A: Broadcast to all user's clusters — orchestrators race to claim via lease_request
- B: Targeted to a specific cluster — no race condition
- C: Broadcast with slot count — orchestrator can decide how many items to dequeue

**Answer**: C — Broadcast with slot count. The cloud implementation broadcasts `slot_available` to all clusters owned by the target user (org-wide Redis pub/sub filtered by userId). The current payload is minimal (`{ type, orgId, userId, timestamp }`) with no slot count. Since multiple clusters receive the broadcast, they will race to claim via `lease_request` — the cloud handles the race atomically (Firestore transaction). The orchestrator should dequeue one item and send a `lease_request` on each `slot_available`. If denied, it was lost in the race — just wait for the next one. The "broadcast to all user's clusters, race to claim" model from option A is what's implemented, but ideally the cloud should include available slot count so the orchestrator can decide whether to dequeue multiple items. Recommend adding `availableSlots` to the payload as a follow-up optimization. For now, dequeue one item per `slot_available` message.
