# Feature Specification: Credential Persistence in Control-Plane

**Branch**: `558-summary-control-plane-s` | **Date**: 2026-05-10 | **Status**: Draft

## Summary

The control-plane's `PUT /credentials/:credentialId` handler at `packages/control-plane/src/routes/credentials.ts` is a stub that accepts and acknowledges credential writes but discards the payload. Credentials sent from the cloud wizard arrive at the cluster but are not persisted.

Per spec #490: "stub; will delegate to credhelper Unix socket in phase 3."

## Current Behavior

```typescript
export async function handlePutCredential(req, res, actor, _params) {
  requireActor(actor);
  await readBody(req);  // reads but discards body
  res.writeHead(200);
  res.end(JSON.stringify({ ok: true }));
}
```

## Expected Behavior

1. Persist received credentials to the encrypted credential file store via `ClusterLocalBackend` (extracted to `@generacy-ai/credhelper`)
2. Write credential metadata to `.agency/credentials.yaml`
3. Emit a credential-arrival event via `getRelayPushEvent()` on the `cluster.credentials` channel
4. Support at minimum: `github-main-org` (GitHub App) and `anthropic/api-key` (Anthropic API key) credential types

## Architecture Decisions

### AD-1: Storage Access — Extract to Shared Package
Extract `ClusterLocalBackend`, `CredentialFileStore`, and AES-256-GCM crypto helpers from `packages/credhelper-daemon/src/backends/` to the shared `@generacy-ai/credhelper` package (~250 LOC). Both credhelper-daemon and control-plane import from this single source of truth.

### AD-2: Cache Coherence — Daemon Restart on Bootstrap-Complete
Credhelper-daemon is restarted when the bootstrap-complete signal arrives (generacy-cloud#532). On restart, `init()` reloads the credential cache from disk with the now-populated credentials. Follow-up issue needed for cache-reload-on-write mechanism to handle post-bootstrap credential edits.

### AD-3: Partial Write Failure — Fail Forward
On partial failure (secret written but metadata write fails), return 500 with a `failedAt` field identifying which step failed. Orphaned encrypted secrets are harmless (still encrypted, no readers, not advertised) and retryable per idempotency contract. No rollback logic.

## Context

- Investigation: generacy-ai/generacy-cloud#528 (outcome: **B — partial**)
- Cloud-side delivery is fully wired and working
- Lifecycle handlers (`set-default-role`, `clone-peer-repos`) are fully implemented — credential handler is the outlier
- `relay-events.ts` has `getRelayPushEvent()` ready for credential-arrival events but it's never called from the credentials route

## Related

- generacy-ai/cluster-base#20 — post-activation hook (needs credentials persisted)
- generacy-ai/generacy-cloud#528 — investigation that identified this gap
- generacy-ai/generacy-cloud#532 — bootstrap-complete lifecycle action

## User Stories

### US1: Cloud Wizard Credential Delivery

**As a** developer bootstrapping a Generacy cluster via the cloud wizard,
**I want** credentials I enter in the wizard to be persisted in the cluster,
**So that** agent sessions can authenticate with GitHub and Anthropic APIs.

**Acceptance Criteria**:
- [ ] `PUT /credentials/:credentialId` persists credential value to encrypted file store
- [ ] Credential metadata is written to `.agency/credentials.yaml`
- [ ] A `cluster.credentials` event is emitted via relay on successful write
- [ ] Subsequent `GET /credentials/:credentialId` returns the persisted metadata
- [ ] Idempotent: repeated PUTs with the same credentialId overwrite cleanly

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Parse and validate credential payload from request body | P1 | Use existing Zod schemas from `@generacy-ai/credhelper` |
| FR-002 | Persist secret value via `ClusterLocalBackend.setSecret()` | P1 | Extracted to shared package per AD-1 |
| FR-003 | Write credential metadata to `.agency/credentials.yaml` | P1 | Atomic write (temp+rename) |
| FR-004 | Emit `cluster.credentials` event via `getRelayPushEvent()` | P1 | Channel: `cluster.credentials`, payload: `{ credentialId, type, status: 'written' }` |
| FR-005 | Return 200 with `{ ok: true }` on success | P1 | |
| FR-006 | Idempotent writes — repeated PUT overwrites cleanly | P1 | |
| FR-007 | Return 500 with `{ error, failedAt }` on partial failure | P2 | Per AD-3 |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Credential round-trip | PUT then GET returns metadata | Integration test |
| SC-002 | Encrypted persistence | Credential value encrypted at rest (AES-256-GCM) | File inspection |
| SC-003 | Event emission | `cluster.credentials` event fired on successful PUT | Relay event listener test |

## Assumptions

- `ClusterLocalBackend`, `CredentialFileStore`, and crypto helpers can be cleanly extracted to `@generacy-ai/credhelper` without breaking credhelper-daemon
- The master key at `/var/lib/generacy/master.key` is available when control-plane starts
- `.agency/credentials.yaml` path is accessible from control-plane process
- Credhelper-daemon restart on bootstrap-complete is handled by the orchestrator (out of scope for this issue)

## Out of Scope

- Post-bootstrap credential edit cache coherence (follow-up issue)
- New HTTP endpoint on credhelper-daemon
- Credential deletion from the cloud UI
- Role assignment for persisted credentials
- Credhelper-daemon restart mechanism (orchestrator concern, generacy-cloud#532)

---

*Generated by speckit*
