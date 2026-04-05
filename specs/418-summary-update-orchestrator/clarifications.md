# Clarifications — #418 Add Per-User Lease Protocol to Orchestrator

## Batch 1 — 2026-04-05

### Q1: Lease Request Timeout
**Context**: FR-001 says the orchestrator must wait for `lease_granted` or `lease_denied`, but doesn't specify what happens if the cloud never responds. Without a timeout, the orchestrator could block indefinitely, stalling all queued work.
**Question**: What should the timeout be for waiting on a `lease_request` response, and what should the orchestrator do on timeout — retry the request, re-enqueue the item, or surface an error?
**Options**:
- A: Timeout after N seconds, re-enqueue item with retry priority (1), back off and retry
- B: Timeout after N seconds, treat as transient failure, retry immediately up to a max count
- C: No timeout needed — the relay guarantees a response

**Answer**: *Pending*

### Q2: Heartbeat Failure Semantics
**Context**: FR-006 says "on heartbeat failure, expire lease and re-enqueue work item" but doesn't define what constitutes a failure. A single dropped packet shouldn't expire a lease, but an unresponsive cloud should.
**Question**: What counts as a heartbeat failure — a single missed acknowledgment, N consecutive failures, or a specific error response from the cloud? Should the orchestrator retry before expiring the lease?
**Options**:
- A: Single failure = expired (strict, simple)
- B: N consecutive failures before expiring (tolerant, configurable threshold)
- C: Cloud explicitly responds with a rejection/expiry message

**Answer**: *Pending*

### Q3: userTierLimit Source for Worker Cap
**Context**: FR-009 caps workers at `min(configuredWorkers, userTierLimit)`. The spec assumes tier limits come via lease protocol responses, but doesn't specify exactly how. The orchestrator needs to know the limit *before* making lease requests to set its worker count.
**Question**: How does the orchestrator learn the `userTierLimit`? Is it a field in the `lease_granted` response, a separate message sent on relay connection, or provided through another mechanism?
**Options**:
- A: Included as a field in every `lease_granted` response
- B: Sent as a separate `tier_info` message on relay connection
- C: Fetched via an API call on startup

**Answer**: *Pending*

### Q4: Re-enqueue Priority After Heartbeat Failure
**Context**: When a lease expires due to heartbeat failure, the work item is re-enqueued. The spec defines three priority tiers (resume=0, retry=1, new=Date.now()) but doesn't specify which applies to heartbeat-expired items. Additionally, the worker may still be executing the work.
**Question**: What priority should a heartbeat-expired item get when re-enqueued? And should the orchestrator signal the worker to abort the in-flight work, or let it complete silently?
**Options**:
- A: Re-enqueue as resume (priority 0), cancel the worker
- B: Re-enqueue as retry (priority 1), cancel the worker
- C: Re-enqueue as resume (priority 0), let the worker finish (result discarded if no lease)

**Answer**: *Pending*

### Q5: slot_available Message Targeting
**Context**: The spec says the orchestrator listens for `slot_available` from cloud and dequeues the next item. It's unclear whether this message is broadcast to all of a user's clusters or sent to a specific cluster. This affects whether the orchestrator should race to claim the slot or can assume exclusive access.
**Question**: Is `slot_available` sent to all clusters belonging to the user (broadcast) or routed to a specific cluster? Does the message carry any payload (e.g., number of available slots)?
**Options**:
- A: Broadcast to all user's clusters — orchestrators race to claim via lease_request
- B: Targeted to a specific cluster — no race condition
- C: Broadcast with slot count — orchestrator can decide how many items to dequeue

**Answer**: *Pending*
