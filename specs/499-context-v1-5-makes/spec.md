# Feature Specification: Credential Audit Log

v1

**Branch**: `499-context-v1-5-makes` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Add structured audit logging to credhelper-daemon for security investigation of credential operations.

## Context

v1.5 makes credential operations queryable for security investigation. The credhelper writes structured audit entries for every mint/resolve/render/session-lifecycle and emits them on the relay's `cluster.audit` event channel for cloud ingestion. Architecture: [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — Open question #4 (locks the schema fields).

## Scope

New module `packages/credhelper-daemon/src/audit/audit-log.ts`:

- API: `auditLog.record({action, credentialId?, sessionId?, role?, pluginId?, success, errorCode?})`. Each entry stamped with `{timestamp, actor: {workerId, sessionId?}, cluster_id}` from the running daemon's context.
- **Actor identity**: `cluster_id` and `workerId` are injected via environment variables `GENERACY_CLUSTER_ID` (from `/var/lib/generacy/cluster.json`, passed by orchestrator at spawn) and `GENERACY_WORKER_ID` (set to `$HOSTNAME` per `AGENT_ID` convention). `DaemonConfig` schema gains optional fields for both.
- **Bounded ring buffer in memory** (default capacity 5000). Oldest entries are dropped if cloud ingestion is offline so the daemon can never OOM from audit pressure.
- **Dropped count**: Each emitted batch carries a `droppedSinceLastBatch: number` field (always present, 0 if no drops). Counter resets per-batch. Cloud-side ingester can sum across batches for total drop visibility.
- **Relay transport**: The daemon pushes audit batches to the control-plane via HTTP POST to `POST /control-plane/internal/audit-batch` (Unix-socket-only, accessible from uid 1002). The control-plane emits each entry on the relay's `cluster.audit` event channel. The daemon flushes its ring buffer at configured interval (1s) or when batch hits 50 entries. If control-plane is unavailable, the ring buffer drops oldest as designed.
- Never includes credential values or any field sourced from a secret. A dev-mode assertion fails the daemon test if any field longer than 256 chars is added to an audit entry (defense against accidental secret leakage).

Hook points (call `auditLog.record` from):
- `SessionManager.beginSession`, `endSession`.
- `ExposureRenderer` (per exposure rendered).
- Each plugin's `mint` / `resolve` (success and failure).
- Docker proxy (per allowed/denied request — sampled at 1/100 to control volume; `audit.recordAllProxy` flag in role config overrides to 100%).
- Localhost proxy (in-process in `packages/credhelper-daemon/src/exposure/localhost-proxy.ts` per #498; same sampling, hooks fire at allowlist matching point).

**Role config schema extension**: `RoleConfig` gains `audit?: { recordAllProxy?: boolean }` in `packages/credhelper/src/schemas/roles.ts`. When `true`, both docker-proxy and localhost-proxy audit fire at 100%; when `false` or absent, both sample at 1/100.

## Acceptance criteria

- Each lifecycle/operation produces one audit entry.
- No entry contains credential values; dev-mode assertion enforces.
- Ring buffer drops oldest under sustained load; `droppedSinceLastBatch` is included in every batch payload.
- Daemon pushes batches to control-plane via `POST /control-plane/internal/audit-batch`; control-plane emits on relay `cluster.audit` channel.
- Integration test: 10000 rapid mints with cloud "offline" produce a non-zero `droppedSinceLastBatch` and bounded memory.
- Sampling configuration for docker/localhost proxies works as specified (`audit.recordAllProxy` on RoleConfig).
- `GENERACY_CLUSTER_ID` and `GENERACY_WORKER_ID` env vars are stamped on every audit entry.

## User Stories

### US1: Security Investigator

**As a** security engineer,
**I want** a structured audit trail of all credential operations in the cluster,
**So that** I can investigate suspicious activity and verify compliance.

**Acceptance Criteria**:
- [ ] Every credential mint/resolve/render/session operation produces an audit entry
- [ ] Audit entries are queryable in the cloud dashboard via the `cluster.audit` event channel

### US2: Platform Operator

**As a** platform operator,
**I want** bounded audit log memory usage even when the cloud is offline,
**So that** the daemon never OOMs from audit pressure.

**Acceptance Criteria**:
- [ ] Ring buffer drops oldest entries when capacity (5000) is exceeded
- [ ] `droppedSinceLastBatch` counter in batch payloads provides visibility into drops

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `auditLog.record()` API with action, credentialId, sessionId, role, pluginId, success, errorCode fields | P1 | |
| FR-002 | Bounded ring buffer (capacity 5000) | P1 | |
| FR-003 | HTTP POST flush to control-plane (`POST /control-plane/internal/audit-batch`) | P1 | Max 50 entries or 1s interval |
| FR-004 | Control-plane endpoint emits entries on relay `cluster.audit` channel | P1 | |
| FR-005 | Actor identity stamping via `GENERACY_CLUSTER_ID` and `GENERACY_WORKER_ID` env vars | P1 | |
| FR-006 | `droppedSinceLastBatch` field on every batch payload | P1 | Resets per batch |
| FR-007 | Dev-mode assertion: no audit field > 256 chars | P1 | Defense against secret leakage |
| FR-008 | `RoleConfig.audit.recordAllProxy` schema extension | P2 | Overrides 1/100 sampling to 100% |
| FR-009 | Localhost proxy in-process audit hooks at allowlist matching point | P1 | Per #498 implementation |
| FR-010 | Docker proxy audit hooks with 1/100 default sampling | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Audit entry coverage | 100% of credential operations | Integration test verifying entry count matches operation count |
| SC-002 | Memory bound under load | No OOM with 10000 rapid mints offline | Integration test with bounded memory assertion |
| SC-003 | No secret leakage | 0 entries with secret values | Dev-mode assertion + test suite |

## Assumptions

- The control-plane HTTP service (#490) is available in-cluster on Unix socket
- The localhost proxy lives in-process in credhelper-daemon per #498
- Worker containers have unique hostnames (for `GENERACY_WORKER_ID`)

## Out of Scope

- Cloud-side audit ingestion and dashboard (handled by #448)
- Granular per-proxy sampling rates (simple boolean is sufficient for v1.5)
- Per-credential audit flags on `RoleCredentialRef`
- Daemon-owned outbound WebSocket relay connection

---

*Generated by speckit*
