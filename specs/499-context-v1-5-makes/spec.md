# Feature Specification: Audit Log Writer in credhelper-daemon

**Branch**: `499-context-v1-5-makes` | **Date**: 2026-04-29 | **Status**: Draft
**Issue**: [#499](https://github.com/generacy-ai/generacy/issues/499) | **Release**: v1.5 phase 9

## Summary

Add a structured audit log writer to the credhelper-daemon that records every credential operation (mint, resolve, render, session lifecycle) as a queryable audit entry. Entries are buffered in a bounded ring buffer, batched, and emitted on the relay's `cluster.audit` event channel for cloud ingestion. The system must never leak credential values and must be OOM-safe under sustained load.

## Context

v1.5 makes credential operations queryable for security investigation. The credhelper writes structured audit entries for every mint/resolve/render/session-lifecycle and emits them on the relay's `cluster.audit` event channel for cloud ingestion. Architecture: [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — Open question #4 (locks the schema fields).

## Scope

New module `packages/credhelper-daemon/src/audit/audit-log.ts`:

- API: `auditLog.record({action, credentialId?, sessionId?, role?, pluginId?, success, errorCode?})`. Each entry stamped with `{timestamp, actor: {workerId, sessionId?}, cluster_id}` from the running daemon's context.
- **Bounded ring buffer in memory** (default capacity 5000). Oldest entries are dropped if cloud ingestion is offline so the daemon can never OOM from audit pressure. A `dropped_count` counter is exposed and emitted as a special audit event when non-zero.
- Emits each entry as a relay `event` on channel `cluster.audit`. The cluster's relay client batches (max 50 entries / 1 second) before sending.
- Never includes credential values or any field sourced from a secret. A dev-mode assertion fails the daemon test if any field longer than 256 chars is added to an audit entry (defense against accidental secret leakage).

Hook points (call `auditLog.record` from):
- `SessionManager.beginSession`, `endSession`.
- `ExposureRenderer` (per exposure rendered).
- Each plugin's `mint` / `resolve` (success and failure).
- Docker proxy (per allowed/denied request — sampled at 1/100 to control volume; allow flag in role config to record all).
- Localhost proxy (same sampling).

## User Stories

### US1: Security Investigator Reviews Credential Usage

**As a** security engineer,
**I want** a queryable audit trail of all credential operations in the cluster,
**So that** I can investigate suspicious activity, trace credential usage to specific sessions/workers, and satisfy compliance requirements.

**Acceptance Criteria**:
- [ ] Every session begin/end, mint, resolve, and render produces an audit entry
- [ ] Each entry includes timestamp, action, actor identity, and outcome
- [ ] Entries are emitted to the cloud via the relay's `cluster.audit` channel
- [ ] No credential values or secrets appear in any audit entry

### US2: Platform Operator Trusts Daemon Stability Under Load

**As a** platform operator,
**I want** the audit system to be bounded in memory usage,
**So that** sustained credential operations or cloud ingestion downtime cannot cause the daemon to OOM.

**Acceptance Criteria**:
- [ ] Ring buffer drops oldest entries when capacity (default 5000) is exceeded
- [ ] A `dropped_count` counter tracks and reports dropped entries
- [ ] 10000 rapid operations with cloud offline produce bounded memory usage

### US3: Operator Controls Proxy Audit Volume

**As a** cluster administrator,
**I want** Docker and localhost proxy audit entries to be sampled,
**So that** high-frequency proxy traffic doesn't overwhelm the audit buffer or cloud ingestion.

**Acceptance Criteria**:
- [ ] Default sampling rate of 1/100 for proxy requests
- [ ] Role config flag to record all proxy requests when needed
- [ ] Sampling applies independently to Docker and localhost proxies

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `AuditLog` class with `record()` method accepting `{action, credentialId?, sessionId?, role?, pluginId?, success, errorCode?}` | P1 | Core API |
| FR-002 | Each entry auto-stamped with `{timestamp, actor: {workerId, sessionId?}, cluster_id}` from daemon context | P1 | |
| FR-003 | Bounded ring buffer (default capacity 5000) that drops oldest entries on overflow | P1 | OOM prevention |
| FR-004 | `dropped_count` counter exposed and emitted as special audit event when non-zero | P1 | Observability |
| FR-005 | Emit entries as relay `event` messages on `cluster.audit` channel | P1 | Cloud ingestion |
| FR-006 | Batch relay emissions: max 50 entries or 1 second, whichever comes first | P1 | Network efficiency |
| FR-007 | No credential values in any entry; dev-mode assertion fails if any field > 256 chars | P1 | Security invariant |
| FR-008 | Hook into `SessionManager.beginSession` and `endSession` | P1 | Session lifecycle |
| FR-009 | Hook into `ExposureRenderer` (per exposure rendered) | P1 | Render tracking |
| FR-010 | Hook into each plugin's `mint` / `resolve` (success and failure) | P1 | Operation tracking |
| FR-011 | Hook into Docker proxy (per allowed/denied request, sampled 1/100) | P2 | Proxy audit |
| FR-012 | Hook into Localhost proxy (same sampling as Docker proxy) | P2 | Proxy audit |
| FR-013 | Role config flag to override sampling and record all proxy requests | P2 | Full audit mode |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Audit coverage | 100% of credential lifecycle operations produce entries | Unit tests verify each hook point |
| SC-002 | Secret leak prevention | 0 entries contain credential values | Dev-mode assertion + test scanning all entry fields |
| SC-003 | Memory boundedness | Buffer never exceeds capacity under sustained load | Integration test: 10000 rapid mints with cloud offline, bounded memory |
| SC-004 | Batch efficiency | Relay emissions batched per spec (50 entries / 1s) | Unit test verifying batch sizes and timing |
| SC-005 | Drop tracking | `dropped_count` accurate under overflow conditions | Integration test verifying non-zero count after overflow |

## Assumptions

- The relay client (`cluster-relay` package) supports emitting `event` messages on named channels
- Daemon context (workerId, cluster_id) is available at audit log construction time
- Plugin `mint`/`resolve` methods have clear success/failure return paths for hooking
- Docker and localhost proxies have interceptable request handlers

## Out of Scope

- Persistent (on-disk) audit log storage — entries are memory-only with relay emission
- Cloud-side audit log ingestion, storage, or query API
- Audit log rotation or archival policies
- UI for viewing audit entries
- Retroactive audit of operations that occurred before this feature is deployed

---

*Generated by speckit*
