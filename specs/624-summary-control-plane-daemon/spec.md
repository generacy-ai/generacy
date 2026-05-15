# Feature Specification: Control-Plane Daemon Crash Resilience

**Branch**: `624-summary-control-plane-daemon` | **Date**: 2026-05-15 | **Status**: Draft

## Summary

The control-plane daemon's `AppConfigEnvStore.init()` calls `fs.mkdir('/var/lib/generacy-app-config', { recursive: true })`. When the running uid (`node`, 1000) doesn't have write permission on `/var/lib/` and the directory hasn't been pre-created, this throws `EACCES` and the **entire daemon crashes during init**. The orchestrator's bootstrap script logs a warning that the socket isn't ready after 10s and then **continues startup anyway**, leaving the cluster in a zombie state: relay connected, control-plane dead, every `api_request` to `/control-plane/*` returns 502.

## Repro

This was hit on staging when onboarding a new project (cluster-base preview image). Bootstrap wizard's GitHub App step fails with "Cluster disconnected. Please try again." (the 502 is mapped to that message in the web UI — see companion generacy-cloud issue).

Orchestrator log:
```
[orchestrator] Starting control-plane daemon (socket: /run/generacy-control-plane/control.sock, log: /tmp/control-plane.log)
[orchestrator] WARNING: control-plane socket not ready after 10s (see /tmp/control-plane.log)
[orchestrator] Starting orchestrator on port 3100
... orchestrator continues, relay connects, cluster reports healthy ...
```

`/tmp/control-plane.log` inside the container:
```
[control-plane] Relay event IPC wired
[control-plane] Credential backend initialized
[control-plane] Failed to start: Error: EACCES: permission denied, mkdir '/var/lib/generacy-app-config'
    at async AppConfigEnvStore.init (.../app-config-env-store.js:17:9)
```

The missing-directory bug itself will be fixed in the cluster images (cluster-base + cluster-microservices). This issue is about the **resilience gap** that made it hard to diagnose and that lets a similar mis-permissioning regress silently in the future.

## Two problems, both in this repo

### Problem 1 — One store's init failure crashes the whole daemon

`AppConfigEnvStore` is one of many things the control-plane initializes. If its directory isn't writable, the entire daemon dies and credentials writes, app-config reads, lifecycle endpoints — everything routed through the control-plane socket — fails. That's a wide blast radius for what's effectively "this new feature's storage backend isn't ready."

**Fix**: Make store-init errors structured. Non-critical stores (AppConfigEnvStore, AppConfigFileStore) fall back to `/tmp/generacy-app-config/` on EACCES. If the fallback also fails, the store enters disabled/no-op mode (Q3: B):
- GET endpoints return normal empty shape (`{ env: [], files: [] }`)
- PUT/POST endpoints return `503 Service Unavailable` with `{ error: 'app-config-store-disabled', reason: '...' }`
- Disabled state prominently surfaced via init-result structure and relay metadata

Files of interest:
- `packages/control-plane/src/services/app-config-env-store.ts:20-21` — current `mkdir` that throws.
- `packages/control-plane/bin/control-plane.ts` — daemon entrypoint, runs the init sequence.

### Problem 2 — Orchestrator treats control-plane unavailability as a warning

In `tetrad-development/.devcontainer/generacy/scripts/entrypoint-orchestrator.sh` (and the equivalent baked into the cluster-base image), the orchestrator spawns the control-plane daemon, waits up to 10s for `/run/generacy-control-plane/control.sock` to appear, then **logs a WARNING and continues** if it never shows. The result is a healthy-looking cluster that fails every relay-forwarded control-plane request.

**Fix** (Q1: C, Q2: C): Both socket-wait with exit in `server.ts` AND ongoing health/metadata reflection:
- Add `probeControlPlaneSocket()` health-check helper (mirrors existing `probeCodeServerSocket()` pattern)
- Surface control-plane unavailability through `/health` endpoint and relay metadata
- On startup, if control-plane socket doesn't appear within timeout, stay running for ~30s to push `error` status (with reason `'control-plane socket did not bind within Xs'`) via relay, then `process.exit(1)`
- Cloud UI displays cluster as `error` (not `offline`), preserving diagnostic visibility before container exits

Files of interest:
- `packages/orchestrator/src/server.ts` — add socket-wait + time-bounded exit logic
- `packages/orchestrator/src/services/code-server-probe.ts` — pattern to follow for `probeControlPlaneSocket()`
- `packages/orchestrator/src/routes/health.ts` — surface `controlPlaneReady` field
- `packages/orchestrator/src/services/relay-bridge.ts` — surface in relay metadata

## User Stories

### US1: Operator diagnosing cluster failures

**As a** platform operator,
**I want** the cluster to report a clear error status when the control-plane daemon fails to start,
**So that** I can quickly identify and fix the root cause instead of debugging a zombie cluster.

**Acceptance Criteria**:
- [ ] Control-plane init failure does not crash the entire daemon — only the affected store degrades
- [ ] Orchestrator detects missing control-plane socket and pushes `error` status via relay
- [ ] Cloud UI shows cluster as `error` with a reason, not `connected`/`healthy`
- [ ] Container exits non-zero after the grace window so docker-compose reflects the failure

### US2: Developer onboarding a new project

**As a** developer using the bootstrap wizard,
**I want** a clear error message when the cluster's control-plane is unavailable,
**So that** I don't see a generic "Cluster disconnected" message and waste time.

**Acceptance Criteria**:
- [ ] Non-critical store (app-config) EACCES falls back to tmpfs, daemon stays running
- [ ] If fallback also fails, store enters disabled mode with 503 responses on writes
- [ ] Init result visible via relay metadata without shell access

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | AppConfigEnvStore/AppConfigFileStore `init()` catches EACCES on preferred path and falls back to `/tmp/generacy-app-config/` | P1 | Preserves daemon for other services |
| FR-002 | If both preferred and fallback paths fail, store enters disabled/no-op mode: GETs return empty shape, PUTs return 503 | P1 | Q3 answer: never silently appear to succeed |
| FR-003 | Orchestrator adds `probeControlPlaneSocket()` helper (mirrors `probeCodeServerSocket()` pattern) | P1 | Used by health endpoint + relay metadata |
| FR-004 | `/health` endpoint includes `controlPlaneReady` boolean field | P1 | |
| FR-005 | Relay metadata includes `initResult` structure: `{ stores: { appConfigEnv: 'ok'\|'fallback'\|'disabled', ... }, warnings: string[] }` | P2 | Q4 answer: log + relay metadata |
| FR-006 | Orchestrator startup waits for control-plane socket; on timeout, pushes `error` status via relay, waits ~30s, then `process.exit(1)` | P1 | Q2 answer: time-bounded |
| FR-007 | Daemon entrypoint emits structured JSON log lines for each store init result | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | EACCES on app-config store does not crash daemon | 100% | Unit test: init with unwritable preferred path |
| SC-002 | Orchestrator pushes error status before exit on control-plane failure | Within 30s | Integration test |
| SC-003 | Zero zombie-state clusters from store init failures | 0 incidents | Staging + production monitoring |

## Assumptions

- The orchestrator entrypoint script (in cluster-base repo) is out of scope — only the Node.js orchestrator code in this repo is modified
- The cluster-base image fix (pre-creating `/var/lib/generacy-app-config/` with correct permissions) is tracked separately
- `probeCodeServerSocket()` in `packages/orchestrator/src/services/code-server-probe.ts` is the established pattern for socket probing
- Existing `ClusterMetadata` type can be extended with `initResult` field without breaking relay handshake

## Out of Scope

- Cluster-base / cluster-microservices image fixes (companion PRs in those repos)
- Cloud-side UI changes for displaying `initResult` metadata (generacy-cloud companion issue)
- Orchestrator entrypoint shell script changes (cluster-base repo)
- Retry/auto-recovery of disabled stores at runtime

## Test plan
- [ ] Unit: `AppConfigEnvStore.init` falls back to a writable path when preferred path is EACCES
- [ ] Unit: `AppConfigEnvStore.init` enters disabled mode when both paths fail; GETs return empty, PUTs return 503
- [ ] Unit: daemon entrypoint emits structured init result and continues when non-critical store falls back
- [ ] Unit: `probeControlPlaneSocket()` returns false when socket doesn't exist
- [ ] Integration: orchestrator pushes `error` status via relay when control-plane socket missing, then exits
- [ ] Regression: simulate EACCES on `/var/lib/generacy-app-config/` and verify the cluster reports error status rather than starting in a zombie state

## Related
- Companion cluster-image fixes in cluster-base / cluster-microservices (filed directly as PRs against those repos)
- generacy-ai/generacy-cloud#586 for distinguishing 502-from-control-plane vs. relay-disconnected in the UI
- Originally introduced as part of generacy-ai/generacy#622 (app-config control-plane endpoints)

---

*Generated by speckit*
