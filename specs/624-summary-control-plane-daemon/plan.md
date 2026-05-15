# Implementation Plan: Control-Plane Daemon Crash Resilience

**Feature**: Make control-plane daemon resilient to non-critical store init failures and surface control-plane unavailability through orchestrator health/metadata
**Branch**: `624-summary-control-plane-daemon`
**Status**: Complete

## Summary

Two changes prevent a zombie cluster state caused by `AppConfigEnvStore.init()` EACCES crashes:

1. **Store-level resilience** (control-plane package): `AppConfigEnvStore` and `AppConfigFileStore` catch EACCES on their preferred path (`/var/lib/generacy-app-config/`), fall back to `/tmp/generacy-app-config/`, and enter disabled/no-op mode if both fail. The daemon entrypoint emits structured init results and continues running.

2. **Orchestrator detection** (orchestrator package): A new `probeControlPlaneSocket()` helper (mirroring `probeCodeServerSocket()`) checks the control-plane Unix socket. The `/health` endpoint and relay metadata gain `controlPlaneReady` and `initResult` fields. On startup, the orchestrator waits for the socket with a timeout, pushes `error` status via relay if missing, then exits after a ~30s grace window.

## Technical Context

**Language/Version**: TypeScript, ESM, Node >= 22
**Primary Dependencies**: `node:fs/promises`, `node:net`, `node:http`, `zod`, `fastify`
**Storage**: Unix domain sockets, filesystem (atomic temp+rename)
**Testing**: Vitest (unit + integration)
**Target Platform**: Linux containers (cluster-base / cluster-microservices images)
**Project Type**: Monorepo (pnpm workspaces)

## Constitution Check

No constitution file found at `.specify/memory/constitution.md`. Proceeding without governance gates.

## Project Structure

### Documentation (this feature)

```text
specs/624-summary-control-plane-daemon/
  spec.md              # Feature specification (read-only)
  clarifications.md    # Q&A from clarify phase
  plan.md              # This file
  research.md          # Implementation patterns and decisions
  data-model.md        # Types, interfaces, Zod schemas
  quickstart.md        # Testing and verification guide
```

### Source Code Changes

```text
packages/control-plane/
  bin/control-plane.ts                          # MODIFY: structured init sequence, emit init results
  src/services/app-config-env-store.ts          # MODIFY: fallback path + disabled mode
  src/services/app-config-file-store.ts         # MODIFY: fallback path + disabled mode
  src/types/init-result.ts                      # NEW: StoreStatus, InitResult types

packages/orchestrator/
  src/services/control-plane-probe.ts           # NEW: probeControlPlaneSocket() helper
  src/routes/health.ts                          # MODIFY: add controlPlaneReady field
  src/services/relay-bridge.ts                  # MODIFY: add controlPlaneReady + initResult to metadata
  src/server.ts                                 # MODIFY: startup socket-wait + error push + grace exit
  src/types/relay.ts                            # MODIFY: extend ClusterMetadataPayload

packages/cluster-relay/
  src/metadata.ts                               # MODIFY: read controlPlaneReady from /health
```

## Implementation Phases

### Phase A: Store Resilience (control-plane package)

**Goal**: `AppConfigEnvStore` and `AppConfigFileStore` never crash the daemon.

1. **Create `InitResult` types** (`packages/control-plane/src/types/init-result.ts`)
   - `StoreStatus = 'ok' | 'fallback' | 'disabled'`
   - `StoreInitResult = { status: StoreStatus; path?: string; reason?: string }`
   - `InitResult = { stores: Record<string, StoreInitResult>; warnings: string[] }`

2. **Modify `AppConfigEnvStore.init()`** (`app-config-env-store.ts`)
   - Wrap `fs.mkdir()` in try/catch for EACCES
   - On EACCES: attempt `fs.mkdir('/tmp/generacy-app-config/env', { recursive: true })`
   - On second failure: set `this.status = 'disabled'`, `this.disabledReason = <message>`
   - Add `getStatus()` and `getInitResult()` accessors
   - Guard `set()` method: if disabled, throw structured error (routes map to 503)
   - Guard `getAll()`: if disabled, return empty `{ env: [] }` shape

3. **Modify `AppConfigFileStore.init()`** (`app-config-file-store.ts`)
   - Same fallback + disabled pattern as AppConfigEnvStore
   - Guard `set()`: if disabled, throw structured error
   - Guard `getAll()`: if disabled, return empty `{ files: [] }` shape

4. **Modify daemon entrypoint** (`bin/control-plane.ts`)
   - Call store `init()` methods individually with try/catch (not chained)
   - Collect `StoreInitResult` from each store
   - Emit structured JSON log line per store: `{ event: 'store-init', store: 'appConfigEnv', status, path?, reason? }`
   - Expose aggregated `InitResult` via module-scoped getter for relay metadata IPC
   - Daemon continues running regardless of store status

### Phase B: Orchestrator Detection (orchestrator package)

**Goal**: Orchestrator detects, surfaces, and reacts to control-plane unavailability.

5. **Create `probeControlPlaneSocket()`** (`packages/orchestrator/src/services/control-plane-probe.ts`)
   - Mirror `probeCodeServerSocket()` exactly: `net.connect()` → Promise<boolean>
   - Default socket: `/run/generacy-control-plane/control.sock`
   - Env var: `CONTROL_PLANE_SOCKET_PATH` (same as control-plane package)
   - Default timeout: 500ms

6. **Extend `/health` endpoint** (`packages/orchestrator/src/routes/health.ts`)
   - Call `probeControlPlaneSocket()` alongside existing `probeCodeServerSocket()`
   - Add `controlPlaneReady: boolean` to response shape

7. **Extend relay metadata** (`packages/orchestrator/src/types/relay.ts` + `relay-bridge.ts`)
   - Add `controlPlaneReady?: boolean` to `ClusterMetadataPayload`
   - Add `initResult?: { stores: Record<string, string>; warnings: string[] }` to payload
   - In `collectMetadata()`: call `probeControlPlaneSocket()`, include result
   - `initResult` sourced from control-plane's `/health` or a dedicated internal endpoint

8. **Extend cluster-relay metadata** (`packages/cluster-relay/src/metadata.ts`)
   - Read `controlPlaneReady` from orchestrator `/health` response
   - Pass through to handshake/heartbeat metadata

9. **Startup socket-wait + grace exit** (`packages/orchestrator/src/server.ts`)
   - After `server.listen()`, before relay bridge init: poll `probeControlPlaneSocket()` every 1s for up to `CONTROL_PLANE_WAIT_TIMEOUT` (default 15s)
   - On success: proceed normally
   - On timeout: push `error` status via relay with reason `'control-plane socket did not bind within Xs'`
   - Wait ~30s grace window (lets cloud UI receive the error status)
   - Call `process.exit(1)`

### Phase C: Tests

10. **Unit tests for store fallback** (Vitest)
    - Mock `fs.mkdir` to throw EACCES on preferred path, verify fallback used
    - Mock both paths failing, verify disabled mode: `getAll()` returns empty, `set()` throws
    - Verify structured log output from entrypoint

11. **Unit test for `probeControlPlaneSocket()`**
    - Create a temp Unix socket, verify returns true
    - Verify returns false when socket doesn't exist

12. **Integration test for startup socket-wait**
    - Mock control-plane socket never appearing
    - Verify orchestrator pushes error status, then exits non-zero within grace window

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Fallback path | `/tmp/generacy-app-config/` | Tmpfs always writable in containers; matches spec |
| Disabled mode behavior | GETs return empty, PUTs return 503 | Never silently appear to succeed (Q3 answer) |
| Socket-wait location | `server.ts` (Node.js, not shell) | In-repo, testable, not dependent on cluster-base scripts |
| Grace window | ~30s | Matches typical Docker healthcheck `start_period`; enough for relay push |
| Init result surface | Relay metadata (not control-plane endpoint) | Control-plane may be dead; relay piggybacks existing heartbeat |

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Fallback to `/tmp/` survives container restart? | No — tmpfs is ephemeral. Acceptable: data is non-critical config that cloud can re-push |
| Grace exit blocks orchestrator for 30s on every restart loop? | Docker restart backoff (`restart: unless-stopped`) handles this; 30s is bounded |
| `initResult` breaks relay handshake schema? | Fields are optional (`?`); cloud ignores unknown fields |
| Disabled store races with credential writes | Disabled mode is set once at init; no race. Credential stores are separate (ClusterLocalBackend) |
