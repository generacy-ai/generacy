# Implementation Plan: Per-User Execution Lease Protocol

**Feature**: Add per-user lease protocol to orchestrator for concurrent workflow enforcement
**Branch**: `418-summary-update-orchestrator`
**Status**: Complete

## Summary

Integrate the orchestrator (`packages/orchestrator`) with the cloud-side execution lease service so that every workflow dispatch is gated by a per-user lease. The orchestrator must acquire a lease before dispatching work, maintain it via heartbeats, release it on completion/pause/fail, and respect tier-based worker caps. This enables per-seat billing enforcement where each cluster owner's concurrent workflow count is limited by their subscription tier.

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js
- **Framework**: Fastify (HTTP server), ioredis (queue/state)
- **Package**: `packages/orchestrator`
- **Transport**: WebSocket via `@generacy-ai/cluster-relay`
- **Test framework**: Vitest
- **Cloud dependency**: `generacy-ai/generacy-cloud#391` (lease service)

## Architecture Overview

The lease protocol inserts a new gating layer between the queue claim and worker dispatch in `WorkerDispatcher`. Instead of immediately running a claimed queue item, the dispatcher sends a `lease_request` through the relay and waits for `lease_granted` or `lease_denied`. A new `LeaseManager` service owns the lease lifecycle (request, heartbeat, release, expiry).

```
Queue claim → LeaseManager.requestLease() → relay lease_request
                                           ↓
                              lease_granted → dispatch to worker
                              lease_denied  → re-enqueue, wait for slot_available
```

## Project Structure

```
packages/orchestrator/src/
├── services/
│   ├── lease-manager.ts              # NEW — Lease lifecycle management
│   ├── worker-dispatcher.ts          # MODIFY — Gate dispatch on lease
│   ├── relay-bridge.ts               # MODIFY — Route lease messages, tier_info
│   └── queue-priority.ts             # NO CHANGE (priority scheme already correct)
├── types/
│   ├── relay.ts                      # MODIFY — Add lease message types
│   ├── monitor.ts                    # MODIFY — Add userId to QueueItem
│   └── lease.ts                      # NEW — Lease types and interfaces
├── config/
│   └── schema.ts                     # MODIFY — Add lease config options
tests/
├── unit/
│   ├── lease-manager.test.ts         # NEW — Lease lifecycle unit tests
│   └── worker-dispatcher-lease.test.ts # NEW — Dispatch gating tests
├── integration/
│   └── lease-relay.test.ts           # NEW — Integration with mock relay
```

## Implementation Phases

### Phase 1: Types & Configuration

Add new types for lease messages and lease state. Extend `DispatchConfig` with lease-specific settings.

**Files**:
- `src/types/lease.ts` — `Lease`, `LeaseState`, `LeaseConfig` interfaces
- `src/types/relay.ts` — Add `RelayLeaseRequest`, `RelayLeaseGranted`, `RelayLeaseDenied`, `RelayLeaseRelease`, `RelayLeaseHeartbeat`, `RelaySlotAvailable`, `RelayTierInfo`, `RelayClusterRejected` to `RelayMessage` union
- `src/types/monitor.ts` — Add optional `userId` field to `QueueItem`
- `src/config/schema.ts` — Add `LeaseConfigSchema` with `requestTimeoutMs` (default 30000), `heartbeatIntervalMs` (default 30000), `maxHeartbeatFailures` (default 3)

### Phase 2: LeaseManager Service

New service that owns the full lease lifecycle.

**File**: `src/services/lease-manager.ts`

**Responsibilities**:
1. **requestLease(userId, queueItemId, jobId)** — Send `lease_request` via relay, return promise that resolves to `granted`/`denied`/`timeout` within 30s
2. **releaseLease(leaseId)** — Send `lease_release` via relay
3. **startHeartbeat(leaseId)** — Send `lease_heartbeat` every 30s; track consecutive failures; after 3 failures, emit `lease:expired` event
4. **stopHeartbeat(leaseId)** — Clear heartbeat interval for a lease
5. **handleLeaseResponse(msg)** — Resolve pending lease request promises
6. **handleSlotAvailable(msg)** — Emit `slot:available` event for dispatcher
7. **handleTierInfo(msg)** — Store and expose `userTierLimit`
8. **handleClusterRejected(msg)** — Emit `cluster:rejected` event

**State**:
- `activLeases: Map<string, LeaseState>` — leaseId → { queueItemId, workerId, heartbeatInterval, consecutiveFailures }
- `pendingRequests: Map<string, { resolve, reject, timer }>` — correlationId → pending promise
- `userTierLimit: number | null` — from `tier_info` message

### Phase 3: WorkerDispatcher Integration

Modify `WorkerDispatcher.pollOnce()` to gate dispatch on lease acquisition.

**File**: `src/services/worker-dispatcher.ts`

**Changes**:
1. **Before dispatch**: After `queue.claim()`, call `leaseManager.requestLease()` instead of immediately running the worker
2. **On `lease_granted`**: Proceed with `runWorker()`, pass `leaseId` to track
3. **On `lease_denied` (at_capacity)**: Call `queue.release()` to re-enqueue, stop polling until `slot:available`
4. **On timeout**: Re-enqueue with retry priority, back off
5. **On worker complete/pause/fail**: Call `leaseManager.releaseLease(leaseId)` in `runWorker()` finally block
6. **On heartbeat expiry** (`lease:expired` event): Cancel worker, re-enqueue with resume priority (0), check for duplicate before enqueue
7. **Worker cap**: Cap `activeWorkers.size` check at `min(1, leaseManager.userTierLimit)` — the "1 per container" model means the cap mostly applies at the lease level, but this prevents claiming when tier limit is 0
8. **slot_available handler**: On event, attempt `pollOnce()` to claim and request lease for next item

### Phase 4: RelayBridge Message Routing

Extend `RelayBridge.handleMessage()` to route lease-protocol messages to `LeaseManager`.

**File**: `src/services/relay-bridge.ts`

**Changes**:
1. Add `setLeaseManager(manager)` method (same pattern as `setConversationManager`)
2. Route incoming `lease_granted`, `lease_denied`, `slot_available`, `tier_info`, `cluster_rejected` messages to the lease manager
3. On `connected` event: Expect `tier_info` message from cloud after handshake
4. On `cluster_rejected`: Log error, surface to user via SSE event: "Active cluster limit reached for your plan"

### Phase 5: Cluster Rejection Handling

Handle `cluster_rejected` message received on relay connection.

**File**: `src/services/relay-bridge.ts`

**Changes**:
1. On `cluster_rejected` message: broadcast SSE error event with user-facing message
2. Prevent queue processing while rejected (set flag on lease manager)
3. Log at error level with tier details

### Phase 6: Tests

**Unit tests** (`tests/unit/lease-manager.test.ts`):
- Lease request → granted flow
- Lease request → denied flow (re-enqueue)
- Lease request → timeout (30s, re-enqueue with retry)
- Heartbeat loop sends every 30s
- 3 consecutive heartbeat failures → lease expired
- Single heartbeat failure → no expiry (tolerance)
- Lease release on workflow complete/pause/fail
- slot_available triggers dequeue attempt
- tier_info sets userTierLimit
- Duplicate re-enqueue prevention

**Unit tests** (`tests/unit/worker-dispatcher-lease.test.ts`):
- Dispatch gated on lease_granted
- Dispatch blocked on lease_denied
- Worker cap respects tier limit
- Heartbeat expiry cancels worker and re-enqueues with resume priority

**Integration tests** (`tests/integration/lease-relay.test.ts`):
- Full lifecycle with mock relay: enqueue → lease_request → granted → dispatch → complete → release
- Denied flow with slot_available recovery
- Heartbeat failure and re-enqueue

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Lease timeout | 30s (one heartbeat interval) | Aligns with heartbeat cadence; avoids blocking dispatch loop |
| Heartbeat failure threshold | 3 consecutive (configurable) | Tolerates transient blips; 3×30s = 90s matches cloud sweep TTL |
| Re-enqueue on heartbeat expiry | Resume priority (0), cancel worker | Work was in-progress; restart cleanly without ambiguous state |
| Tier limit source | `tier_info` message on relay connect | Clean separation; falls back to uncapped if cloud hasn't shipped yet |
| slot_available handling | Dequeue one item per message, race via lease_request | Cloud handles race atomically; simple and correct |
| Lease manager placement | Standalone service, injected into dispatcher | Single responsibility; testable in isolation |
| userId source | Cluster owner from relay handshake / config | All workflows from a cluster count against the cluster owner |

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify against.

## Dependencies

- **Cloud**: `generacy-ai/generacy-cloud#391` must implement `lease_request`/`lease_granted`/`lease_denied`/`lease_release`/`lease_heartbeat`/`slot_available`/`tier_info`/`cluster_rejected` message handling
- **Relay**: `@generacy-ai/cluster-relay` — no changes needed (generic `send()` already supports arbitrary message types)
- **Fallback**: If cloud hasn't shipped tier_info yet, orchestrator operates uncapped (uses `configuredWorkers` only)

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Cloud lease service not ready | Fallback: skip lease gating when relay disconnected or tier_info not received |
| Race condition on slot_available | Cloud handles atomically via Firestore transaction; denied = lost race, wait for next |
| Heartbeat failure false positives | 3-failure threshold with 90s total window; matches cloud sweep TTL |
| Duplicate re-enqueue (orchestrator + cloud sweep) | Check queue for existing item before re-enqueue |
