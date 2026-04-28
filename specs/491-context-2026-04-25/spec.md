# Feature Specification: Cluster-Local Credhelper Backend with Sealed Encrypted Store

**Issue**: [#491](https://github.com/generacy-ai/generacy/issues/491) | **Branch**: `491-context-2026-04-25` | **Date**: 2026-04-28 | **Status**: Draft

## Summary

Implement a `cluster-local` backend for the credhelper daemon that stores credentials in an AES-256-GCM encrypted file on a persistent named volume. This replaces the removed `generacy-cloud` backend as the v1.5 default, keeping all secrets within the cluster boundary.

## Context

The 2026-04-25 retarget of the credentials architecture moved storage from generacy-cloud to a per-cluster encrypted file. The cluster-local backend is the v1.5 default. Architecture: [docs/credentials-architecture-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/credentials-architecture-plan.md) -- locked decision #1.

## Scope

Create `packages/credhelper-daemon/src/backends/cluster-local-backend.ts` implementing the `BackendClient` interface (`fetchSecret(key): Promise<string>`) against a sealed encrypted file at `/var/lib/generacy/credentials.dat`.

### Encryption

- AES-256-GCM with random per-credential IV; auth tag stored alongside ciphertext.
- Master key: random 32-byte AES-256 key generated on first credhelper boot if `/var/lib/generacy/master.key` does not exist.
- Master key file: mode `0600`, owned by credhelper uid (1002), on a persistent named volume.
- Master key is never logged; rotation is out of scope for v1.5 (destroy-and-reenter is the recovery model).

### File Format

Small JSON envelope with atomic writes via temp-file-and-rename:

```json
{
  "version": 1,
  "entries": {
    "<key>": {
      "ciphertext": "<base64>",
      "iv": "<base64>",
      "authTag": "<base64>"
    }
  }
}
```

### Concurrency

Single-process write lock via file mutex (e.g., `proper-lockfile` or `fd`-based advisory lock).

### Factory Wiring

Wire into `packages/credhelper-daemon/src/backends/factory.ts`:
- Add a `'cluster-local'` case constructing `ClusterLocalBackend`.
- Make `cluster-local` the default when a config omits an explicit backend type.

## User Stories

### US1: Cluster Operator Stores Credentials Locally

**As a** cluster operator,
**I want** credentials stored in an encrypted file on the cluster's persistent volume,
**So that** secrets never leave the cluster boundary and I don't depend on an external cloud service.

**Acceptance Criteria**:
- [ ] Credentials are encrypted at rest using AES-256-GCM
- [ ] Master key is auto-generated on first boot and persisted with mode 0600
- [ ] Backend is selected automatically when no explicit backend is configured

### US2: Security Auditor Verifies Credential Isolation

**As a** security auditor,
**I want** to verify that copying the credentials file without the master key yields undecryptable ciphertext,
**So that** volume snapshots alone cannot compromise secrets.

**Acceptance Criteria**:
- [ ] Decryption fails with a wrong or missing master key
- [ ] No plaintext secrets appear in logs or error messages
- [ ] File permissions are enforced and verified

### US3: Developer Manages Credentials via Backend Interface

**As a** developer using the credhelper daemon,
**I want** the cluster-local backend to conform to the existing `BackendClient` interface,
**So that** I can use it interchangeably with other backends (e.g., `env`).

**Acceptance Criteria**:
- [ ] `fetchSecret(key)` returns decrypted secret values
- [ ] Backend supports set and delete operations for credential lifecycle
- [ ] Factory dispatches to cluster-local backend for `type: 'cluster-local'`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Implement `ClusterLocalBackend` conforming to `BackendClient` interface | P1 | `fetchSecret(key): Promise<string>` |
| FR-002 | AES-256-GCM encryption with random per-credential IV and auth tag | P1 | Use Node.js `crypto` module |
| FR-003 | Auto-generate 32-byte master key on first boot at `/var/lib/generacy/master.key` | P1 | Mode 0600, uid 1002 |
| FR-004 | Persist credentials in JSON envelope at `/var/lib/generacy/credentials.dat` | P1 | Version field for future migration |
| FR-005 | Atomic writes via temp-file-and-rename | P1 | Prevents corruption on crash |
| FR-006 | Single-process write lock via file mutex | P2 | Prevents concurrent write corruption |
| FR-007 | Wire `cluster-local` case into `DefaultBackendClientFactory` | P1 | In `factory.ts` |
| FR-008 | Make `cluster-local` the default backend type when config omits backend | P1 | Matches architecture decision #1 |
| FR-009 | Support set/delete operations for credential management | P1 | Extends interface or internal methods |
| FR-010 | Never log plaintext secrets or master key material | P1 | Security requirement |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Crypto roundtrip test | Pass | set/get/delete cycle with verification |
| SC-002 | Master key idempotency | Pass | Key created once, reused on subsequent boots |
| SC-003 | Volume-snapshot isolation | Pass | Ciphertext undecryptable without master key |
| SC-004 | Crash safety | Pass | Simulated mid-write crash preserves existing file |
| SC-005 | File permissions | Pass | Integration test verifies 0600 on master key |
| SC-006 | No plaintext leaks | Pass | Log output audit shows no secret material |

## Assumptions

- The credhelper daemon runs as a single process (no multi-process write contention beyond advisory locks).
- The persistent volume at `/var/lib/generacy/` is available and writable by uid 1002.
- Node.js `crypto` module provides adequate AES-256-GCM primitives (no external crypto library needed).
- The `BackendClient` interface may need extension (e.g., `setSecret`, `deleteSecret`) or the backend exposes these as internal methods called by the session manager.

## Out of Scope

- Master key rotation (v1.5 recovery model is destroy-and-reenter).
- Multi-node cluster key distribution.
- Hardware security module (HSM) integration.
- Backup/restore automation for the encrypted store.
- `cluster-local` backend for the `generacy-cloud` backend type (removed in #488).

---

*Generated by speckit*
