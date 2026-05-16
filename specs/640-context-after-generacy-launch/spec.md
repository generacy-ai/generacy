# Feature Specification: Forward Registry Credentials to Credhelper After First Launch

**Branch**: `640-context-after-generacy-launch` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

After `generacy launch` pulls the cluster image using credentials from the LaunchConfig (single-use, claim-code-bound), those credentials need to migrate to the cluster's credhelper so they're available for future `generacy update` re-pulls without re-prompting the user. The local copy gets deleted to keep credentials transit-only.

Part of [docs/cluster-variants-and-custom-images-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-variants-and-custom-images-plan.md) — Phase 2 Track B.

## Scope

- **New step in `launchAction`** (`packages/generacy/src/cli/commands/launch/index.ts`, after the cluster reports a successful handshake):
  - If the LaunchConfig included `registryCredentials`, PUT them to the cluster's control-plane (`PUT /credentials/registry-<host>`) via the local Unix socket.
  - On success, delete the scoped `<projectDir>/.docker/config.json` from the previous pullImage step.
  - On failure, log a warning but don't fail the launch — the user can re-enter creds via the cloud UI.
- **Credential ID convention**: `registry-<host>` (e.g. `registry-private.example.com`) so the credhelper can store multiple registry creds independently.

## User Stories

### US1: Secure Credential Migration on First Launch

**As a** developer using a private container registry,
**I want** my registry credentials to automatically migrate from local disk into the cluster's credhelper after first launch,
**So that** future `generacy update` pulls succeed without re-prompting, and no plaintext credentials remain on my local filesystem.

**Acceptance Criteria**:
- [ ] After successful handshake, registry creds are PUT to control-plane under `registry-<host>` ID
- [ ] Scoped `.docker/config.json` is deleted from local disk after successful forward
- [ ] No user interaction required for credential migration

### US2: Graceful Degradation on Forward Failure

**As a** developer launching a cluster in a degraded network environment,
**I want** credential forwarding failures to be non-fatal,
**So that** my launch completes successfully and I can re-enter credentials later via the cloud UI.

**Acceptance Criteria**:
- [ ] Launch proceeds to completion even if PUT to control-plane fails
- [ ] Warning is logged with actionable context (what failed, how to fix)
- [ ] Local `.docker/config.json` is preserved on failure (allows manual retry)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | After cluster handshake, if `LaunchConfig.registryCredentials` is present, PUT each credential to `PUT /credentials/registry-<host>` on the control-plane Unix socket | P1 | Uses existing control-plane credential route |
| FR-002 | Credential ID follows `registry-<host>` convention (e.g., `registry-ghcr.io`) | P1 | Allows multiple registries per cluster |
| FR-003 | On successful PUT, delete `<projectDir>/.docker/config.json` | P1 | Prevents plaintext creds from persisting on local disk |
| FR-004 | On PUT failure, log a warning and continue launch | P1 | Non-fatal — user can re-enter via cloud UI |
| FR-005 | Preserve `.docker/config.json` when forward fails | P2 | Enables manual retry |
| FR-006 | PUT body shape: `{ type: "registry", value: "<base64-encoded auth>" }` | P1 | Matches PutCredentialBodySchema |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | No plaintext registry creds on local disk after successful launch | 100% | Verify `<projectDir>/.docker/config.json` does not exist post-launch |
| SC-002 | Credential available in cluster credhelper | Verified | `GET /credentials/registry-<host>` returns entry |
| SC-003 | Launch completes on forward failure | Always | Unit test: mock control-plane returning 500 -> launch exits 0 |
| SC-004 | Test coverage | 3 paths | success, control-plane unreachable, credhelper rejection |

## Assumptions

- The cluster's control-plane is reachable via the local Docker network (Unix socket forwarding or port mapping) by the time the handshake succeeds.
- `LaunchConfig.registryCredentials` carries sufficient info to derive the registry host for the credential ID.
- The `PUT /credentials/:id` route on the control-plane is already functional (v1.5 #558).
- The sibling "pull with creds" issue has already created the scoped `.docker/config.json` that this feature deletes.

## Out of Scope

- `generacy update` consumption of credhelper creds (sibling issue).
- Initial pull with creds (sibling issue — creates the scoped `.docker/config.json`).
- Multi-registry support in a single LaunchConfig (future enhancement).
- Cloud UI credential re-entry flow.

## Dependencies

- Sibling: "Pull cluster image with scoped private-registry credentials" issue (creates `.docker/config.json`).
- generacy-ai/generacy-cloud#594 (cluster control-plane has `/credentials` route — already part of v1.5).

---

*Generated by speckit*
