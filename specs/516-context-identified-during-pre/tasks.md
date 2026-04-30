# Tasks: Dynamic /state Endpoint for Control-Plane

**Input**: Design documents from `/specs/516-context-identified-during-pre/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & State Store

- [ ] T001 Update `packages/control-plane/src/schemas.ts` — add `statusReason` field to `ClusterStateSchema`, create `StatusUpdateSchema` with `status` + optional `statusReason`
- [ ] T002 Update `packages/control-plane/src/types.ts` — add `ClusterStateStore` interface with `getState()` and `updateStatus()` signatures
- [ ] T003 Create state store module — module-level `let state: ClusterState` initialized to `{ status: 'bootstrapping', deploymentMode: 'local', variant: 'cluster-base', lastSeen: now }`. Export `initClusterState(config)`, `updateClusterStatus(status, statusReason?)`, `getClusterState()`. Enforce state machine transitions (reject invalid from→to; `error` is terminal). Location: `packages/control-plane/src/state.ts` or inline in `server.ts` following existing `setRelayPushEvent()` pattern

## Phase 2: Control-Plane Endpoints

- [ ] T004 Modify `packages/control-plane/src/routes/state.ts` — replace hardcoded response with call to `getClusterState()`; include `statusReason` only when present; update `lastSeen` to current time on each request
- [ ] T005 Create `packages/control-plane/src/routes/status.ts` — `POST /internal/status` handler: parse+validate body with `StatusUpdateSchema`, call `updateClusterStatus()`, return `{ ok: true }` on success, return 400 with `{ error, code: 'INVALID_REQUEST', details }` on validation failure
- [ ] T006 Update `packages/control-plane/src/router.ts` — register `POST /internal/status` route pointing to new handler
- [ ] T007 Update `packages/control-plane/src/server.ts` or `bin/control-plane.ts` — read `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars at startup, call `initClusterState({ deploymentMode, variant })` with defaults (`'local'`, `'cluster-base'`)
- [ ] T008 Update `packages/control-plane/src/index.ts` — re-export `StatusUpdateSchema`, `StatusUpdate` type, and state store functions as needed

## Phase 3: Orchestrator Status Reporter

- [ ] T009 Create `packages/orchestrator/src/services/status-reporter.ts` — HTTP-over-Unix-socket client class `StatusReporter` with `pushStatus(status, statusReason?)` method. Fire-and-forget with error logging. Socket path from `CONTROL_PLANE_SOCKET_PATH` env or default `/run/generacy-control-plane/control.sock`
- [ ] T010 Modify `packages/orchestrator/src/server.ts` — instantiate `StatusReporter` at startup; push `ready` after successful relay handshake / activation
- [ ] T011 Modify `packages/orchestrator/src/services/relay-bridge.ts` — push `degraded` with reason on relay disconnect; push `ready` on reconnect

## Phase 4: Tests

- [ ] T012 [P] Update `packages/control-plane/__tests__/routes/state.test.ts` — test `GET /state` returns dynamic values: default env vars, custom `DEPLOYMENT_MODE=cloud`, custom `CLUSTER_VARIANT=cluster-microservices`, `statusReason` included when set, `statusReason` omitted when absent
- [ ] T013 [P] Create `packages/control-plane/__tests__/routes/status.test.ts` — test `POST /internal/status`: valid transition bootstrapping→ready, valid transition ready→degraded, degraded→ready recovery, reject invalid status value (400), reject transition from terminal `error` state, `statusReason` stored and reflected in subsequent `GET /state`
- [ ] T014 Update `packages/control-plane/__tests__/integration/all-routes.test.ts` — add `POST /internal/status` to the integration suite, verify round-trip: POST status then GET state reflects update

## Dependencies & Execution Order

```
T001 ──┐
T002 ──┼──► T003 ──► T004 ──► T007
       │           ► T005 ──► T006 ──► T008
       │
T003 ──────► T009 ──► T010
                    ► T011
T004-T008 ──► T012 (parallel)
T005-T008 ──► T013 (parallel)
T012,T013 ──► T014
```

- **Phase 1** (T001–T003): Sequential — schemas before types before state store
- **Phase 2** (T004–T008): T004 and T005 can run in parallel after T003; T006 depends on T005; T007 depends on T003; T008 after all routes wired
- **Phase 3** (T009–T011): T009 first, then T010 and T011 in parallel; can start after T003 (needs schema types)
- **Phase 4** (T012–T014): T012 and T013 in parallel; T014 after both complete
