# Tasks: Control-Plane Daemon Crash Resilience

**Input**: Design documents from `/specs/624-summary-control-plane-daemon/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Foundation

- [X] T001 [US1] Create `packages/control-plane/src/types/init-result.ts` — Define `StoreStatus` type (`'ok' | 'fallback' | 'disabled'`), `StoreInitResult` interface (`{ status, path?, reason? }`), `InitResult` interface (`{ stores: Record<string, StoreInitResult>, warnings: string[] }`), and `StoreDisabledError` class (with `code` and `reason` fields). ~40 lines.

- [X] T002 [P] [US1] Extend `ClusterMetadataPayload` in `packages/orchestrator/src/types/relay.ts` — Add optional `controlPlaneReady?: boolean` and `initResult?: { stores: Record<string, StoreStatus>; warnings: string[] }` fields to the interface. Import `StoreStatus` type or inline it. ~5 lines changed.

## Phase 2: Store Resilience (control-plane)

- [X] T003 [US2] Modify `AppConfigEnvStore.init()` in `packages/control-plane/src/services/app-config-env-store.ts` — Wrap `fs.mkdir()` (line ~20) in try/catch for EACCES/EPERM/EROFS. On catch: attempt fallback to `/tmp/generacy-app-config/env`. On second failure: set `this.disabled = true` with reason. Add private fields (`status: StoreStatus`, `disabledReason?: string`). Add `getStatus()` and `getInitResult()` accessors. Guard `set()`: throw `StoreDisabledError` when disabled. Guard `getAll()`: return `[]` when disabled. ~40 lines changed.

- [X] T004 [P] [US2] Modify `AppConfigFileStore.init()` in `packages/control-plane/src/services/app-config-file-store.ts` — Same fallback + disabled pattern as T003. Wrap `fs.mkdir()` (line ~38) in try/catch for EACCES/EPERM/EROFS. Fallback to `/tmp/generacy-app-config/files`. Disabled mode: `set()` throws `StoreDisabledError`, `getAll()` returns `[]`. Add `getStatus()` and `getInitResult()` accessors. ~30 lines changed.

- [X] T005 [US1] Modify daemon entrypoint `packages/control-plane/bin/control-plane.ts` — Restructure init sequence (lines ~69-93): call each store's `init()` individually with try/catch (not chained). Collect `StoreInitResult` from each store via `getInitResult()`. Emit structured JSON log line per store (`{ event: 'store-init', store, status, path?, reason? }`). Aggregate into `InitResult`. Write to `/run/generacy-control-plane/init-result.json` atomically (temp+rename). Daemon continues running regardless of store status. ~30 lines changed.

## Phase 3: Orchestrator Detection

- [X] T006 [US1] Create `probeControlPlaneSocket()` in `packages/orchestrator/src/services/control-plane-probe.ts` — Mirror `probeCodeServerSocket()` pattern from `code-server-probe.ts`. Export `probeControlPlaneSocket(socketPath?, timeoutMs?): Promise<boolean>`. Default socket: `/run/generacy-control-plane/control.sock`. Env var: `CONTROL_PLANE_SOCKET_PATH`. Default timeout: 500ms. Uses `net.connect()` with timeout. ~35 lines.

- [X] T007 [US1] Extend `/health` endpoint in `packages/orchestrator/src/routes/health.ts` — Import `probeControlPlaneSocket`. Call it alongside existing `probeCodeServerSocket()` (near line ~87). Add `controlPlaneReady: boolean` to the response object. ~5 lines added.

- [X] T008 [US1] Extend relay metadata in `packages/orchestrator/src/services/relay-bridge.ts` — In `collectMetadata()` (near line ~505): import and call `probeControlPlaneSocket()`, add result as `controlPlaneReady` field. Read `/run/generacy-control-plane/init-result.json` (try/catch, graceful if missing), add as `initResult` field. ~15 lines added.

- [X] T009 [US1] Extend cluster-relay metadata in `packages/cluster-relay/src/metadata.ts` — Read `controlPlaneReady` from orchestrator `/health` response. Pass through to metadata object returned for handshake/heartbeat. ~5 lines added.

- [X] T010 [US1] Add startup socket-wait + grace exit in `packages/orchestrator/src/server.ts` — After `server.listen()`: poll `probeControlPlaneSocket()` every 1s for `CONTROL_PLANE_WAIT_TIMEOUT` (default 15s, from env). On success: proceed normally. On timeout: push `error` status via relay with reason `'control-plane socket did not bind within Xs'`, wait ~30s grace window, then `process.exit(1)`. Must handle wizard mode (no relay client yet) gracefully. ~30 lines added.

## Phase 4: Route Error Handling

- [X] T011 [US2] Update control-plane app-config route handlers to map `StoreDisabledError` to 503 — In the route files that call `appConfigEnvStore.set()` or `appConfigFileStore.set()`, catch `StoreDisabledError` and return `503 { error: 'app-config-store-disabled', reason }`. GETs already return empty from disabled stores. ~10 lines changed per affected route file.

## Phase 5: Tests

- [X] T012 [US2] Unit test: `AppConfigEnvStore` fallback and disabled mode — Test `init()` with mocked `fs.mkdir` throwing EACCES on preferred path: verify fallback path used, `getStatus()` returns `'fallback'`. Test both paths failing: verify `getStatus()` returns `'disabled'`, `getAll()` returns `[]`, `set()` throws `StoreDisabledError`. Test normal init returns `'ok'`.

- [X] T013 [P] [US2] Unit test: `AppConfigFileStore` fallback and disabled mode — Same pattern as T012 for the file store variant.

- [X] T014 [P] [US1] Unit test: `probeControlPlaneSocket()` — Test returns `true` when a temp Unix socket exists and is listening. Test returns `false` when socket path doesn't exist. Test returns `false` on timeout.

- [X] T015 [US1] Unit test: daemon entrypoint structured init — Verify that when a store init fails, the daemon still calls `server.start()`. Verify structured JSON log lines emitted per store. Verify `init-result.json` written with correct shape.

- [X] T016 [US1] Integration test: orchestrator startup socket-wait — Mock control-plane socket never appearing. Verify orchestrator pushes error status with reason string. Verify `process.exit(1)` called after grace window. Verify `/health` returns `controlPlaneReady: false`.

## Dependencies & Execution Order

```
T001 ──────────────────────┬──→ T003 ──→ T005 ──→ T011 ──→ T012
                           │          ↗              ↘       T015
T002 (parallel with T001) ─┤   T004 ─┘                T013 (parallel with T012)
                           │
                           └──→ T006 ──→ T007 ──→ T010 ──→ T016
                                  ↓         ↓
                                T008 ──→ T009      T014 (parallel with T012)
```

**Phase boundaries**:
- Phase 1 (T001, T002): Type definitions — no runtime deps, can parallelize
- Phase 2 (T003-T005): Store resilience — T003/T004 parallel, T005 depends on both
- Phase 3 (T006-T010): Orchestrator detection — T006 first, then T007-T009 parallel-ish, T010 last
- Phase 4 (T011): Route error handling — depends on T003/T004 store changes
- Phase 5 (T012-T016): Tests — T012/T013/T014 parallelizable, T015/T016 depend on implementation

**Parallel opportunities**: T001+T002, T003+T004, T007+T008+T009, T012+T013+T014
