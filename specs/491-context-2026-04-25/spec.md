# Feature Specification: Cluster-Local Credhelper Backend

Implement the cluster-local encrypted credential storage backend for the credhelper daemon.

**Branch**: `491-context-2026-04-25` | **Date**: 2026-04-28 | **Status**: Draft

## Summary

Create a sealed encrypted credential store backed by a local file, serving as the v1.5 default backend for the credhelper daemon. Credentials are encrypted with AES-256-GCM using a per-cluster master key.

## Context

The 2026-04-25 retarget of the credentials architecture moved storage from generacy-cloud to a per-cluster encrypted file. The cluster-local backend is the v1.5 default. Architecture: [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) — locked decision #1.

## Scope

Create `packages/credhelper-daemon/src/backends/cluster-local-backend.ts` implementing the credhelper backend interface against a sealed encrypted file at `/var/lib/generacy/credentials.dat`.

- AES-256-GCM with random per-credential IV; auth tag stored alongside.
- Master key: random 32-byte AES-256 key generated on first credhelper boot if `/var/lib/generacy/master.key` does not exist; the file is mode 0600, owned by the credhelper uid (1002), on a persistent named volume.
- Master key file is never logged; rotation is out of scope for v1.5 (destroy-and-reenter is the recovery model, documented in plan).
- File format: small JSON envelope `{ version, entries: { [key]: { ciphertext, iv, authTag } } }`. Atomic writes via temp-file-and-rename.
- Concurrency: fd-based advisory lock via Node.js built-in `fs` APIs (no external locking dependency).
- Interface: `ClusterLocalBackend` implements `WritableBackendClient` (extends `BackendClient` with `setSecret` and `deleteSecret`). The base `BackendClient` remains read-only.
- Callers: In v1.5, only the control-plane routes (`PUT /credentials/:id`, `DELETE /credentials/:id`) invoke write operations. The session manager is read-only (`fetchSecret` only).
- Error handling: Fail closed on corrupt JSON (throw error, refuse to start). For unknown version numbers, throw a distinct "migration needed" error with a specific error code.

Wire in `packages/credhelper-daemon/src/backends/factory.ts`:
- Add a `'cluster-local'` case constructing the backend.
- Default backend selection: config loader fills in `type: 'cluster-local'` when config omits an explicit backend type (normalization happens in the loader, not the factory).

Tests:
- Crypto roundtrip (set/get/delete).
- Master-key file is created exactly once and reused on subsequent boots.
- Volume-snapshot scenario: copying the credentials file without the master key yields ciphertext that cannot be decrypted.
- Atomic-write crash safety: simulated crash mid-write does not corrupt the existing file.
- Corrupt file handling: corrupt JSON → error; unknown version → "migration needed" error.

## Acceptance criteria

- All listed tests pass.
- `WritableBackendClient` interface added to `packages/credhelper` extending `BackendClient` with `setSecret(key, value)` and `deleteSecret(key)`.
- `ClusterLocalBackend` implements `WritableBackendClient`.
- Factory selects `cluster-local` as default for credentials without an explicit backend (via config loader defaulting).
- No plaintext secrets in logs.
- File and master-key permissions verified by integration test.
- fd-based advisory locking used (no `proper-lockfile` dependency).
- Corrupt file: fail closed with distinct error codes for corruption vs. unknown version.
- Documented in package README with a short security note.

## User Stories

### US1: Cluster Operator Stores Credentials Locally

**As a** cluster operator,
**I want** credentials stored in an encrypted local file,
**So that** secrets remain on-cluster without depending on an external cloud service.

**Acceptance Criteria**:
- [ ] Credentials are encrypted at rest with AES-256-GCM
- [ ] Master key is generated automatically on first boot
- [ ] Master key file has restrictive permissions (mode 0600)

### US2: Bootstrap UI Writes Credentials

**As a** cluster operator using the bootstrap UI,
**I want** to add, update, and remove credentials via the control-plane,
**So that** I can manage secrets through a web interface.

**Acceptance Criteria**:
- [ ] Control-plane can call `setSecret` and `deleteSecret` on the backend
- [ ] Session manager reads credentials via `fetchSecret` (read-only)

### US3: Resilient to File Corruption

**As a** cluster operator,
**I want** the backend to fail safely when the credential file is corrupt,
**So that** I don't silently lose credentials or operate on bad data.

**Acceptance Criteria**:
- [ ] Corrupt JSON causes the backend to refuse to start with a clear error
- [ ] Unknown version number produces a distinct "migration needed" error
- [ ] Atomic writes prevent corruption during normal operation

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | AES-256-GCM encryption with per-credential random IV | P1 | |
| FR-002 | Master key auto-generation on first boot | P1 | 32-byte random key at `/var/lib/generacy/master.key` |
| FR-003 | Master key file permissions 0600, uid 1002 | P1 | |
| FR-004 | JSON envelope file format with version field | P1 | `{ version, entries }` |
| FR-005 | Atomic writes via temp-file-and-rename | P1 | |
| FR-006 | fd-based advisory locking | P1 | Node.js built-in `fs`, no external deps |
| FR-007 | `WritableBackendClient` interface with `setSecret`/`deleteSecret` | P1 | Extends `BackendClient` |
| FR-008 | Config loader defaults to `cluster-local` backend type | P1 | Normalization in loader, not factory |
| FR-009 | Fail closed on corrupt JSON | P1 | Distinct error for unknown version |
| FR-010 | Control-plane is the sole writer in v1.5 | P1 | Session manager read-only |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | All unit/integration tests pass | 100% | CI pipeline |
| SC-002 | No plaintext secrets in logs | Zero occurrences | Log audit |
| SC-003 | Master key created once, reused | Verified | Integration test |

## Assumptions

- Single credhelper daemon process per cluster (no cross-process locking needed)
- Persistent named volume available at `/var/lib/generacy/`
- credhelper uid is 1002
- `BackendClient` interface change (`WritableBackendClient`) is additive, not breaking

## Out of Scope

- Master key rotation (destroy-and-reenter is the v1.5 recovery model)
- Cross-process file locking
- Cloud-side credential storage (`generacy-cloud` backend removed in #488)
- Automatic migration from unknown file format versions

---

*Generated by speckit*
