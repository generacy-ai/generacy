# Implementation Plan: Dynamic /state Endpoint for Control-Plane

**Feature**: Replace hardcoded `GET /state` response with real deployment config and lifecycle status
**Branch**: `516-context-identified-during-pre`
**Status**: Complete

## Summary

The control-plane's `GET /state` endpoint currently returns hardcoded `{ status: 'ready', deploymentMode: 'local', variant: 'cluster-base' }`. Cloud-deployed clusters appear as local, breaking the cloud UI's Claude Max banner and "Stop cluster" button. This feature:

1. Reads `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars at startup for static config
2. Adds a `POST /internal/status` endpoint so the orchestrator can push lifecycle state transitions
3. Extends `ClusterState` schema with optional `statusReason` field
4. Starts with `status: 'bootstrapping'`; orchestrator pushes `ready` after relay handshake

## Technical Context

- **Language**: TypeScript (ESM, Node >= 20)
- **Framework**: Native `node:http` (no Express)
- **Validation**: Zod schemas
- **Testing**: Vitest
- **Packages modified**: `packages/control-plane`, `packages/orchestrator`
- **Pattern to follow**: `POST /internal/audit-batch` (module-level setter + Zod-validated internal endpoint)

## Project Structure

```
packages/control-plane/
  src/
    schemas.ts              # MODIFY — add statusReason to ClusterStateSchema, add StatusUpdateSchema
    types.ts                # MODIFY — add ClusterStateStore interface
    routes/
      state.ts              # MODIFY — read from state store instead of hardcoded values
      status.ts             # CREATE — POST /internal/status handler
    router.ts               # MODIFY — register POST /internal/status route
    server.ts               # MODIFY — read env vars, initialize state store
    index.ts                # MODIFY — re-export new types/functions
  bin/
    control-plane.ts        # MODIFY — read env vars, call state initialization
  __tests__/
    routes/
      state.test.ts         # MODIFY — test dynamic state values
      status.test.ts        # CREATE — test POST /internal/status
    integration/
      all-routes.test.ts    # MODIFY — add status endpoint integration test

packages/orchestrator/
  src/
    services/
      relay-bridge.ts       # MODIFY — push status on connect/disconnect
      status-reporter.ts    # CREATE — HTTP client for POST /internal/status
    server.ts               # MODIFY — push status after activation, wire reporter
```

## Implementation Phases

### Phase 1: Control-Plane Schema & State Store

**Goal**: Define the data model and in-memory state management.

1. **Update `schemas.ts`** — Add `statusReason` to `ClusterStateSchema`, create `StatusUpdateSchema`
2. **Update `types.ts`** — Add `ClusterStateStore` type with `getState()` and `updateStatus()` methods
3. **Create state store** — Module-level state with setter/getter following the `setRelayPushEvent` pattern

### Phase 2: Control-Plane Endpoints

**Goal**: Wire up the dynamic `GET /state` and new `POST /internal/status`.

4. **Modify `routes/state.ts`** — Read from state store; include `statusReason` when present
5. **Create `routes/status.ts`** — `POST /internal/status` handler: validate body with `StatusUpdateSchema`, update state store, return `{ ok: true }`
6. **Update `router.ts`** — Register `POST /internal/status` route
7. **Update `bin/control-plane.ts`** — Read `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars, pass to state initialization

### Phase 3: Orchestrator Status Reporter

**Goal**: Create client to push status transitions to the control-plane.

8. **Create `services/status-reporter.ts`** — HTTP-over-Unix-socket client for `POST /internal/status` (same pattern as credhelper HTTP client)
9. **Wire into `server.ts`** — Create reporter at startup, push `ready` after relay handshake
10. **Wire into `relay-bridge.ts`** — Push `degraded` on disconnect, `ready` on reconnect

### Phase 4: Tests

**Goal**: Integration tests for all env var combinations and status transitions.

11. **Update `state.test.ts`** — Test with various env var combos, test statusReason inclusion
12. **Create `status.test.ts`** — Test valid/invalid status updates, state machine transitions
13. **Update `all-routes.test.ts`** — Add POST /internal/status to integration suite

## State Machine

```
                    ┌─────────────┐
     startup ──────►│bootstrapping│
                    └──────┬──────┘
                           │ orchestrator pushes after relay handshake
                    ┌──────▼──────┐
              ┌─────│    ready    │◄────┐
              │     └──────┬──────┘     │
              │            │ relay      │ relay
              │            │ disconnect │ reconnect
              │     ┌──────▼──────┐     │
              │     │  degraded   │─────┘
              │     └──────┬──────┘
              │            │ unrecoverable failure
              │     ┌──────▼──────┐
              └────►│    error    │  (terminal — requires restart)
                    └─────────────┘
```

## Key Design Decisions

1. **Module-level state store** (not constructor injection) — Follows existing `setRelayPushEvent()` pattern; keeps `ControlPlaneServer` constructor simple
2. **`POST /internal/status` endpoint** (not shared state object) — Decouples packages, consistent with audit-batch pattern
3. **`error` is terminal** — Only restart recovers; `degraded` handles all recoverable conditions
4. **Always start `bootstrapping`** — Orchestrator is source of truth; avoids filesystem-inferred state disagreements
5. **Env var defaults** — `DEPLOYMENT_MODE` defaults to `'local'`, `CLUSTER_VARIANT` defaults to `'cluster-base'`

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Orchestrator doesn't push `ready` (bug/crash) | Cluster stuck in `bootstrapping` | Cloud UI should handle `bootstrapping` gracefully; health checks unaffected |
| Race: `GET /state` before first status push | Returns `bootstrapping` (correct) | By design — Q4 clarification |
| Invalid status value in POST body | State corruption | Zod validation rejects; returns 400 |

## Constitution Check

No `constitution.md` found — no governance constraints to verify.
