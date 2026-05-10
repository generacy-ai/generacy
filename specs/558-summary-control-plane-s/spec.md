# Feature Specification: Credential Persistence in Control-Plane

**Branch**: `558-summary-control-plane-s` | **Date**: 2026-05-10 | **Status**: Draft

## Summary

The control-plane's `PUT /credentials/:credentialId` handler (`packages/control-plane/src/routes/credentials.ts`) is a stub that accepts credential writes but discards the payload. Credentials sent from the cloud bootstrap wizard arrive at the cluster but are never persisted.

This feature wires the handler to persist credentials via the `cluster-local` backend (AES-256-GCM encrypted file store at `/var/lib/generacy/credentials.dat`) and emit relay events so downstream systems (e.g., the cloud UI, post-activation hooks) know credentials have arrived.

## User Stories

### US1: Cloud Bootstrap Credential Delivery

**As a** cluster operator using the cloud bootstrap wizard,
**I want** credentials I configure in the wizard to be persisted on the cluster,
**So that** agents can use them for GitHub access and API calls immediately after bootstrap completes.

**Acceptance Criteria**:
- [ ] `PUT /credentials/:credentialId` with a valid payload persists the secret value via `ClusterLocalBackend.setSecret()`
- [ ] The credential metadata (id, type, backend, backendKey) is written to the `.agency/credentials.yaml` config file
- [ ] A `cluster.credential` relay event is emitted with `{ credentialId, status: 'stored' }`
- [ ] Subsequent `GET /credentials/:credentialId` returns the persisted metadata (not hardcoded stub data)

### US2: Post-Activation Hook Dependency

**As a** cluster-base post-activation hook (cluster-base#20),
**I want** credentials to be available on disk before the hook runs,
**So that** I can configure GitHub App authentication and clone repositories.

**Acceptance Criteria**:
- [ ] `github-main-org` (GitHub App) credentials are persistable
- [ ] `anthropic/api-key` (API key) credentials are persistable
- [ ] Credentials survive container restart (persisted to encrypted file store, not memory)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `PUT /credentials/:credentialId` validates body against `CredentialEntrySchema` + a `value` field | P1 | Zod validation, 400 on invalid |
| FR-002 | Persist secret value to `ClusterLocalBackend.setSecret(backendKey, value)` | P1 | Uses existing AES-256-GCM encrypted file store |
| FR-003 | Write credential metadata entry to `.agency/credentials.yaml` | P1 | Append if new, update if exists |
| FR-004 | Emit `cluster.credential` event via `getRelayPushEvent()` | P2 | `{ credentialId, status: 'stored' }` |
| FR-005 | `GET /credentials/:credentialId` reads metadata from config (not hardcoded stub) | P2 | Never returns secret value |
| FR-006 | `PUT` is idempotent — re-sending the same credential overwrites cleanly | P1 | Same key = update in both file store and config |
| FR-007 | Actor context required (existing `requireActor` call) | P1 | Already in place |

## Architecture

### Data Flow

```
Cloud wizard → relay → control-plane PUT /credentials/:id
                              │
                              ├─ validate body (Zod)
                              ├─ ClusterLocalBackend.setSecret(backendKey, value)
                              ├─ write metadata to .agency/credentials.yaml
                              ├─ emit relay event (cluster.credential)
                              └─ respond 200 { ok: true, credentialId }
```

### Key Integration Points

1. **`ClusterLocalBackend`** (`packages/credhelper-daemon/src/backends/cluster-local-backend.ts`): Already has `setSecret(key, value)` — encrypts with AES-256-GCM, atomic write to `/var/lib/generacy/credentials.dat`.
2. **`relay-events.ts`** (`packages/control-plane/src/relay-events.ts`): `getRelayPushEvent()` already wired — used by audit and peer-repo-cloner.
3. **`.agency/credentials.yaml`**: Config file read by credhelper-daemon at session begin. Follows `CredentialsConfigSchema` (`schemaVersion: '1', credentials: [...]`).
4. **Control-plane does not import credhelper-daemon directly** — it either: (a) instantiates `ClusterLocalBackend` independently (same file paths), or (b) uses HTTP to the credhelper daemon socket. Option (a) is simpler since both run in the same container.

### Request Body Schema

```typescript
const PutCredentialBodySchema = z.object({
  type: z.string(),           // e.g., 'github-app', 'api-key'
  backend: z.string(),        // e.g., 'cluster-local'
  backendKey: z.string(),     // e.g., 'github-main-org/private-key'
  value: z.string(),          // the secret value to persist
  mint: MintConfigSchema.optional(),
});
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Credential round-trip | `PUT` then credhelper `fetchSecret()` returns the value | Integration test |
| SC-002 | Relay event emitted | `cluster.credential` event observed on relay channel | Unit test with mock `pushEventFn` |
| SC-003 | Idempotency | Two identical `PUT` calls result in one credential entry, no errors | Unit test |
| SC-004 | Encrypted at rest | Secret value not present in plaintext in any file | Inspect `credentials.dat` contents |

## Assumptions

- Control-plane and credhelper-daemon run in the same container and share `/var/lib/generacy/` filesystem
- The `cluster-local` backend's master key is already initialized by the time credentials arrive (credhelper-daemon boots first)
- Cloud sends credentials one at a time via individual `PUT` calls (not batch)
- The `backendKey` is unique per credential and provided by the cloud

## Out of Scope

- Credential deletion (`DELETE /credentials/:id`) — follow-up
- Credential rotation / refresh — handled by credhelper-daemon session layer
- Cloud-side `generacy-cloud` backend type — removed in #488
- Secret value retrieval via control-plane API (secrets are never exposed over the relay)
- Batch credential write endpoint

---

*Generated by speckit*
