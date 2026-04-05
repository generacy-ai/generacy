# Quickstart: Per-User Execution Lease Protocol (#418)

## Prerequisites

- Node.js 20+
- pnpm
- Redis running locally (for queue)
- Cloud lease service deployed (`generacy-cloud#391`) — or operate in fallback mode

## Setup

```bash
# Install dependencies
pnpm install

# Start dev stack (Redis, Firebase emulators)
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh

# Start orchestrator in full mode
cd packages/orchestrator
pnpm dev
```

## Configuration

New lease config options in orchestrator config (environment or config file):

| Option | Default | Description |
|--------|---------|-------------|
| `dispatch.lease.requestTimeoutMs` | `30000` | Timeout waiting for lease response |
| `dispatch.lease.heartbeatIntervalMs` | `30000` | Lease heartbeat send interval |
| `dispatch.lease.maxHeartbeatFailures` | `3` | Failures before local lease expiry |

## How It Works

### Happy Path
1. Queue item claimed by worker dispatcher
2. `LeaseManager.requestLease()` sends `lease_request` via relay
3. Cloud responds with `lease_granted` (leaseId)
4. Worker dispatched, heartbeat loop starts (30s interval)
5. Workflow completes → `lease_release` sent, heartbeat stopped

### Denied (at capacity)
1. Cloud responds with `lease_denied` (reason: `at_capacity`)
2. Queue item re-enqueued (stays in queue)
3. Dispatcher waits for `slot_available` message
4. On `slot_available` → dequeue next item, request lease again

### Heartbeat Failure
1. WebSocket send fails for heartbeat
2. After 3 consecutive failures (90s): lease treated as expired locally
3. Worker cancelled, item re-enqueued with resume priority (0)

### Fallback Mode
If the relay is disconnected or `tier_info` has not been received, the orchestrator operates without lease gating — dispatches immediately as before.

## Running Tests

```bash
# Unit tests for lease manager
pnpm vitest run tests/unit/lease-manager.test.ts

# Unit tests for dispatcher integration
pnpm vitest run tests/unit/worker-dispatcher-lease.test.ts

# Integration tests with mock relay
pnpm vitest run tests/integration/lease-relay.test.ts

# All tests
pnpm test
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Active cluster limit reached for your plan" | `cluster_rejected` from cloud | Upgrade tier or disconnect another cluster |
| Workflows stuck in queue | Lease requests timing out | Check relay connection, verify cloud lease service is running |
| Frequent re-enqueues | Heartbeat failures | Check WebSocket stability, verify Redis connectivity |
| No lease gating active | `tier_info` not received | Verify cloud has shipped `tier_info` support; orchestrator falls back to uncapped |
| Duplicate items in queue | Both orchestrator and cloud sweep re-enqueued | Non-fatal — dedup guard should prevent, but check logs for warnings |

## Key Files

| File | Purpose |
|------|---------|
| `src/services/lease-manager.ts` | Lease lifecycle (request, heartbeat, release, expiry) |
| `src/services/worker-dispatcher.ts` | Dispatch gating and slot_available handling |
| `src/services/relay-bridge.ts` | Message routing for lease protocol |
| `src/types/lease.ts` | Lease types and interfaces |
| `src/types/relay.ts` | Extended relay message types |
| `src/config/schema.ts` | Lease configuration schema |
