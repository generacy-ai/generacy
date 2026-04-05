# Tasks: Per-User Execution Lease Protocol

**Input**: Design documents from `/specs/418-summary-update-orchestrator/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/relay-lease-protocol.ts
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which acceptance criterion this task addresses (AC#)

## Phase 1: Types & Configuration

- [X] T001 [P] Create lease types file (`src/types/lease.ts`) — Define `Lease`, `LeaseState`, `LeaseRequestResult`, `TierInfo`, `LeaseConfig`, `ILeaseManager` interfaces per contracts/relay-lease-protocol.ts
- [X] T002 [P] Add lease message types to relay union (`src/types/relay.ts`) — Add `RelayLeaseRequest`, `RelayLeaseGranted`, `RelayLeaseDenied`, `RelayLeaseRelease`, `RelayLeaseHeartbeat`, `RelaySlotAvailable`, `RelayTierInfo`, `RelayClusterRejected` interfaces and extend the `RelayMessage` union (L119-126)
- [X] T003 [P] Add `userId` field to QueueItem (`src/types/monitor.ts`) — Add optional `userId?: string` to `QueueItem` interface (L12-31)
- [X] T004 [P] Add lease config schema (`src/config/schema.ts`) — Add `LeaseConfigSchema` with `requestTimeoutMs` (default 30000), `heartbeatIntervalMs` (default 30000), `maxHeartbeatFailures` (default 3) and nest into `OrchestratorConfigSchema` (L232-253)

## Phase 2: Core Implementation

- [X] T010 [AC1,AC2,AC3] Create LeaseManager service (`src/services/lease-manager.ts`) — Implement `ILeaseManager` extending `EventEmitter`:
  - `requestLease(userId, queueItemId, jobId)` — send `lease_request` via relay, return promise resolving to granted/denied/timeout within 30s using correlation ID pattern
  - `releaseLease(leaseId)` — send `lease_release`, stop heartbeat, remove from activeLeases map
  - `startHeartbeat(leaseId)` — send `lease_heartbeat` every 30s, track consecutive failures, emit `lease:expired` after 3 failures
  - `stopHeartbeat(leaseId)` — clear heartbeat interval
  - `handleLeaseResponse(msg)` — resolve pending lease request promises
  - `handleSlotAvailable(msg)` — emit `slot:available` event
  - `handleTierInfo(msg)` — store `userTierLimit` and `tierInfo`
  - `handleClusterRejected(msg)` — set `clusterRejected` flag, emit `cluster:rejected` event
  - Internal state: `activeLeases` Map, `pendingRequests` Map, `userTierLimit`, `clusterRejected`

- [X] T011 [AC1,AC4,AC6] Integrate lease gating into WorkerDispatcher (`src/services/worker-dispatcher.ts`) — Modify `pollOnce()` (L164-202):
  - After `queue.claim()`, call `leaseManager.requestLease()` instead of immediately running worker
  - On `lease_granted`: proceed with `runWorker()`, pass `leaseId`
  - On `lease_denied`: call `queue.release()` to re-enqueue, stop polling until `slot:available`
  - On timeout: re-enqueue with retry priority, back off
  - On worker complete/pause/fail: call `leaseManager.releaseLease(leaseId)` in finally block
  - On `lease:expired` event: cancel worker, re-enqueue with resume priority (0), check for duplicate before enqueue
  - Worker cap: check `activeWorkers.size` against `min(configuredWorkers, leaseManager.userTierLimit)`
  - Add `slot:available` listener to attempt `pollOnce()` for next item
  - Add `setLeaseManager(manager)` method
  - Graceful fallback: skip lease gating if `leaseManager` not set or `userTierLimit` is null

- [X] T012 [AC4,AC7] Extend RelayBridge message routing (`src/services/relay-bridge.ts`) — Modify `handleMessage()` (L191-204):
  - Add `setLeaseManager(manager)` method following `setConversationManager()` pattern (L182-189)
  - Route incoming `lease_granted`, `lease_denied` to `leaseManager.handleLeaseResponse()`
  - Route `slot_available` to `leaseManager.handleSlotAvailable()`
  - Route `tier_info` to `leaseManager.handleTierInfo()`
  - Route `cluster_rejected` to `leaseManager.handleClusterRejected()`
  - On `cluster_rejected`: broadcast SSE error event "Active cluster limit reached for your plan"
  - Send outbound lease messages (`lease_request`, `lease_release`, `lease_heartbeat`) via existing relay `send()`

## Phase 3: Wiring

- [X] T020 Wire LeaseManager into orchestrator startup — Instantiate `LeaseManager` with config, inject into both `WorkerDispatcher` and `RelayBridge` via setter methods. Ensure proper shutdown (clear all heartbeats, release active leases).

## Phase 4: Tests

- [X] T030 [P] [AC8] Unit tests for LeaseManager (`tests/unit/lease-manager.test.ts`):
  - Lease request → granted flow (correlation ID matching)
  - Lease request → denied flow (re-enqueue signal)
  - Lease request → timeout (30s, rejects with timeout status)
  - Heartbeat loop sends every 30s
  - 3 consecutive heartbeat failures → `lease:expired` event emitted
  - Single heartbeat failure → no expiry (tolerance)
  - Lease release stops heartbeat and sends message
  - `slot_available` emits `slot:available` event
  - `tier_info` sets `userTierLimit`
  - `cluster_rejected` sets flag and emits event
  - Duplicate re-enqueue prevention guard

- [X] T031 [P] [AC8] Unit tests for WorkerDispatcher lease integration (`tests/unit/worker-dispatcher-lease.test.ts`):
  - Dispatch gated on `lease_granted`
  - Dispatch blocked and re-enqueued on `lease_denied`
  - Worker cap respects `userTierLimit`
  - Heartbeat expiry cancels worker and re-enqueues with resume priority (0)
  - `slot_available` triggers `pollOnce()`
  - Graceful fallback when lease manager not set

- [X] T032 [AC9] Integration tests with mock relay (`tests/integration/lease-relay.test.ts`):
  - Full lifecycle: enqueue → lease_request → granted → dispatch → complete → release
  - Denied flow with slot_available recovery
  - Heartbeat failure and re-enqueue
  - Cluster rejection prevents queue processing

## Dependencies & Execution Order

```
Phase 1 (all parallel):  T001 ║ T002 ║ T003 ║ T004
                              ↓
Phase 2 (sequential):    T010 → T011 → T012
                              ↓
Phase 3:                 T020
                              ↓
Phase 4 (partial parallel): T030 ║ T031 → T032
```

**Key dependencies**:
- T001-T004 are independent setup tasks (different files), run in parallel
- T010 (LeaseManager) must complete before T011 (dispatcher references it) and T012 (bridge routes to it)
- T011 (dispatcher) should complete before T012 (bridge) to understand the full message flow
- T020 (wiring) depends on all Phase 2 tasks
- T030, T031 can run in parallel (different test files)
- T032 (integration) depends on T030, T031 (unit tests pass first)

**Parallel opportunities**: 4 tasks in Phase 1, 2 tasks in Phase 4
