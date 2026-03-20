# Implementation Plan: Orchestrator Job Lifecycle Events via Relay WebSocket

**Feature**: Add job lifecycle event emission to the orchestrator's workflow engine so the dashboard can display active workflows, workflow history, and real-time activity.
**Branch**: `398-description-orchestrator-s`
**Status**: Complete

## Summary

The orchestrator's workflow engine processes issues through a phase loop (specify → clarify → plan → tasks → implement → validate) but never emits job lifecycle events through the relay WebSocket to the cloud API. The cloud API already handles these events (generacy-cloud#228) — we just need to send them from the orchestrator side.

This plan adds a `JobEventEmitter` callback pattern to the worker pipeline. A relay client is created in worker mode, connected to the cloud, and its `send()` method is wrapped as a callback injected into `ClaudeCliWorker`. The worker emits `job:created`, `job:phase_changed`, `job:paused`, `job:completed`, and `job:failed` events at the appropriate lifecycle points.

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Framework**: Fastify (HTTP server), custom worker pipeline
- **Key packages**: `@generacy-ai/cluster-relay` (WebSocket client), `@generacy-ai/workflow-engine`
- **Runtime**: Node.js with native `crypto.randomUUID()` for UUID generation
- **Architecture**: Multi-process — "full mode" (orchestrator + relay bridge) and "worker mode" (job processor) are separate containers. Workers connect to orchestrator via Redis queue. The relay bridge in full mode connects to the cloud. Workers currently have NO relay connection.

## Architecture Decision

**Problem**: Worker mode and relay bridge mode are mutually exclusive (`server.ts` lines 197 vs 260). The `ClaudeCliWorker` (worker mode) cannot access the `RelayBridge` (full mode) to emit events.

**Decision**: Create a `ClusterRelayClient` in worker mode specifically for event emission. Each worker container gets its own lightweight WebSocket connection to the cloud. This is the simplest approach — no Redis pub/sub infrastructure, no internal API proxy, just a direct connection.

**Alternative considered**: Redis pub/sub (worker publishes → orchestrator subscribes → relay forwards). Rejected because it adds complexity, latency, and a new message format layer with no clear benefit. Workers already require Redis for queue coordination, but adding pub/sub is a separate concern.

**Alternative considered**: Worker → orchestrator internal API → relay. Rejected because it couples the worker to the orchestrator's HTTP server availability and adds a round-trip.

## Message Format

The cloud API's `MessageHandler.handleEvent()` expects:
```typescript
{ type: 'event', event: string, data: Record<string, unknown>, timestamp: string }
```

Add a new `RelayJobEvent` type to the relay message union. This uses `type: 'event'` like `RelayEvent` but carries a flat event name string + data payload instead of a channel + SSEEvent. Discriminate by the presence of `event` (string) vs `channel` (SSEChannel) at the relay server level.

```typescript
interface RelayJobEvent {
  type: 'event';
  event: string;       // 'job:created', 'job:phase_changed', etc.
  data: Record<string, unknown>;
  timestamp: string;
}
```

## Project Structure

```
packages/orchestrator/src/
├── types/
│   └── relay.ts                    # ADD RelayJobEvent to RelayMessage union
├── worker/
│   ├── types.ts                    # ADD jobId to WorkerContext, ADD JobEventEmitter type
│   ├── claude-cli-worker.ts        # MODIFY: generate UUID, emit job:created/completed/failed
│   ├── phase-loop.ts               # MODIFY: emit job:phase_changed at phase start, job:paused at gate
│   └── output-capture.ts           # NO CHANGE (existing SSE events are independent)
├── services/
│   ├── relay-bridge.ts             # ADD emitJobEvent() public method
│   └── worker-dispatcher.ts        # NO CHANGE
└── server.ts                       # MODIFY: create relay client in worker mode, wire to worker

packages/cluster-relay/src/
└── relay.ts                        # NO CHANGE (send() already accepts RelayMessage)
```

## Implementation Steps

### Step 1: Add types (relay message + worker context)

**File**: `packages/orchestrator/src/types/relay.ts`
- Add `RelayJobEvent` interface with `type: 'event'`, `event: string`, `data: Record<string, unknown>`, `timestamp: string`
- Add `RelayJobEvent` to the `RelayMessage` discriminated union

**File**: `packages/orchestrator/src/worker/types.ts`
- Add `jobId: string` to `WorkerContext` interface (UUID generated at dequeue time)
- Export `JobEventEmitter` type: `(event: string, data: Record<string, unknown>) => void`

### Step 2: Add emitJobEvent to RelayBridge

**File**: `packages/orchestrator/src/services/relay-bridge.ts`
- Add public `emitJobEvent(event: string, data: Record<string, unknown>): void` method
- Implementation: sends `{ type: 'event', event, data, timestamp: new Date().toISOString() }` via `this.client.send()`
- No-op when `!this.client.isConnected`
- Wrapped in try/catch with error logging (non-throwing — events are fire-and-forget)

### Step 3: Wire relay client into worker mode

**File**: `packages/orchestrator/src/server.ts`
- In the `isWorkerMode` block (line 197), check if `config.relay.apiKey` is set
- If set, dynamically import `@generacy-ai/cluster-relay` and create a `ClusterRelayClient`
- Create a `JobEventEmitter` callback that sends through this client
- Pass it to `ClaudeCliWorker` via a new `jobEventEmitter` dep
- Connect the client on server ready; disconnect on shutdown

### Step 4: Emit job:created and job:completed/failed in ClaudeCliWorker

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Add `jobEventEmitter?: JobEventEmitter` to `ClaudeCliWorkerDeps`
- In `handle()`, generate `jobId = crypto.randomUUID()` (separate from existing `workerId`)
- Add `jobId` to `WorkerContext`
- Emit `job:created` immediately after context creation with payload: `{ jobId, workflowName, owner, repo, issueNumber, status: 'active', currentStep: startPhase }`
- Emit `job:completed` at each completion point (standard, epic, PR feedback)
- Emit `job:failed` at each failure point
- Pass `jobEventEmitter` to `PhaseLoop` via a new field in `PhaseLoopDeps`

### Step 5: Emit job:phase_changed and job:paused in PhaseLoop

**File**: `packages/orchestrator/src/worker/phase-loop.ts`
- Add `jobEventEmitter?: JobEventEmitter` to `PhaseLoopDeps`
- Add `jobId: string` access via `context.jobId`
- At the TOP of each phase loop iteration (before `labelManager.onPhaseStart()`), emit `job:phase_changed` with `{ jobId, currentStep: phase, status: 'active', workflowName, owner, repo, issueNumber }`
- When a gate is hit and activates (before returning `gateHit: true`), emit `job:paused` with `{ jobId, currentStep: phase, status: 'paused', gateLabel, workflowName, owner, repo, issueNumber }`

### Step 6: Tests

- Update existing `ClaudeCliWorker` tests to verify `job:created`, `job:completed`, `job:failed` events
- Update `PhaseLoop` tests (if they exist) to verify `job:phase_changed` and `job:paused`
- Add unit test for `RelayBridge.emitJobEvent()`
- Test no-op behavior when relay is not connected

## Event Payload Reference

All events include these base fields:
```typescript
{
  jobId: string;          // UUID generated at dequeue time
  workflowName: string;   // 'speckit-feature', 'speckit-bugfix', 'speckit-epic'
  owner: string;          // GitHub repo owner
  repo: string;           // GitHub repo name
  issueNumber: number;    // GitHub issue number
  status: string;         // 'active', 'paused', 'completed', 'failed'
  currentStep: string;    // Current/last phase name
}
```

Additional fields per event:
- `job:failed`: `error: string` (error message)
- `job:paused`: `gateLabel: string` (e.g., 'waiting-for:clarification')

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Worker relay connection fails | Graceful degradation — `jobEventEmitter` is optional, no-op when missing. Worker continues processing normally. |
| Extra WebSocket per worker container | Lightweight — events-only, no message handling needed. Connection count scales with worker replicas (typically 1-3). |
| Cloud API doesn't handle flat event format | Clarification confirmed: cloud API's `handleEvent()` parses `{ type: 'event', event: string, data, timestamp }`. If relay server doesn't forward this format, the relay server needs a minor update (out of scope but low risk). |
| Duplicate `type: 'event'` in RelayMessage union | Relay server can discriminate by checking for `channel` (SSE events) vs `event` string (job events). Add a runtime type guard if needed. |

## Dependencies

- `@generacy-ai/cluster-relay` package (already a dependency, used in full mode)
- Cloud API event handler (generacy-cloud#228, already deployed)
- No new npm packages required (`crypto.randomUUID()` is native Node.js)
