# Feature Specification: Deploy SSH — Registry Credential Authentication

**Branch**: `643-context-generacy-deploy-ssh` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

Add registry credential handling to `generacy deploy ssh://...` so that private custom images can be pulled on remote VMs. Credentials are written as a scoped Docker config via SSH, used for `docker compose pull`, cleaned up immediately after pull (regardless of outcome), and forwarded to the cluster's credhelper after handshake.

## Context

The `generacy deploy ssh://...` command provisions a cluster on a user-supplied VM. With v1.6 supporting private custom images, the deploy needs to set up authentication on the remote VM so its docker can pull the image. As with local launch, credentials are scoped to the project's directory on the remote and cleaned up after pull; permanent storage moves to the cluster's credhelper after handshake.

Part of [docs/cluster-variants-and-custom-images-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-variants-and-custom-images-plan.md) — Phase 3.

## Scope

- **In `generacy deploy ssh://...`** (`packages/generacy/src/cli/commands/deploy/` — find or add):
  - If LaunchConfig includes `registryCredentials`, write all entries to the remote via SSH (`scp` or `cat | ssh ... > file`) at `<remoteProjectDir>/.docker/config.json`.
  - Set `DOCKER_CONFIG=<remoteProjectDir>/.docker` for the remote `docker compose pull` invocation.
  - After pull completes (success or failure), always delete the remote scoped config (try/finally pattern).
- **Post-handshake forward**: After `pollClusterStatus()` confirms `connected`, forward credentials to credhelper inline (blocking) via direct SSH to the control-plane Unix socket (`docker compose exec orchestrator curl --unix-socket ...`). CLI waits for forward to succeed before printing deploy result.
- **Forward failure**: Soft fail (warn + exit 0) — cluster is already running. Print remediation message suggesting `generacy registry-login --remote <host>` or re-entering credentials in generacy.ai.
- **Error handling**: Same surface as local launch (auth failure clarifies the credential path).

## Acceptance criteria

- `generacy deploy` to a VM with default image works as today.
- Deploy with private custom image + creds succeeds; remote pull authenticates.
- Remote scoped config is cleaned up regardless of pull outcome (try/finally).
- After handshake, credhelper has the entry and the remote scoped config is gone.
- If credential forward fails, CLI warns with remediation steps and exits 0.
- Tests cover: default-image deploy (mocked SSH), private-custom deploy with creds, cleanup on pull failure, forward failure soft-fail.

## Depends on

- generacy-ai/generacy-cloud#594 (LaunchConfig has `registryCredentials`).
- Sibling: Phase 2 "Forward registry credentials to credhelper after first launch" — shares the post-handshake forward logic.

## User Stories

### US1: Deploy with Private Custom Image

**As a** developer deploying a custom cluster variant,
**I want** `generacy deploy ssh://...` to authenticate Docker pulls using cloud-provided registry credentials,
**So that** my private custom image is pulled without manual Docker login on the remote VM.

**Acceptance Criteria**:
- [ ] Deploy with `registryCredentials` in LaunchConfig authenticates the remote pull
- [ ] Remote `.docker/config.json` is deleted after pull regardless of outcome
- [ ] Credentials are forwarded to credhelper after cluster handshake

### US2: Default Image Deploy Unchanged

**As a** developer deploying with the default public image,
**I want** `generacy deploy ssh://...` to work exactly as before when no `registryCredentials` are present,
**So that** existing workflows are not affected.

**Acceptance Criteria**:
- [ ] Deploy without `registryCredentials` skips credential setup entirely
- [ ] No `.docker/config.json` is created on the remote

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Write all `registryCredentials` entries to remote `<remoteProjectDir>/.docker/config.json` via SSH | P1 | Docker `auths` object supports multiple registries natively; write all entries |
| FR-002 | Set `DOCKER_CONFIG=<remoteProjectDir>/.docker` env for remote `docker compose pull` | P1 | Scopes auth to project dir |
| FR-003 | Delete remote `.docker/config.json` after pull regardless of outcome (try/finally) | P1 | Sole cleanup point; idempotent |
| FR-004 | Forward credentials to credhelper via SSH to control-plane Unix socket after handshake | P1 | Inline/blocking; `docker compose exec orchestrator curl --unix-socket ...` pattern |
| FR-005 | Defensive re-check that remote scoped config is gone after credential forward | P2 | Tolerates file-not-found; belt-and-suspenders |
| FR-006 | Soft fail on credential forward failure — warn with remediation, exit 0 | P1 | Cluster is running; don't hard-fail |
| FR-007 | Skip credential setup entirely when `registryCredentials` is absent/empty | P1 | Backward compatible |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Private image deploy success rate | 100% with valid creds | Integration test with mocked SSH |
| SC-002 | Credential cleanup reliability | Always cleaned up (success + failure paths) | Test: verify remote file deleted after pull failure |
| SC-003 | Default deploy regression | Zero behavioral change | Existing deploy tests pass unchanged |

## Assumptions

- LaunchConfig from cloud includes `registryCredentials` array (generacy-cloud#594)
- SSH connection to remote VM is already established and verified by the deploy flow
- Control-plane Unix socket is reachable via `docker compose exec` on the remote
- Docker config.json `auths` format is stable across supported Docker versions

## Out of Scope

- Multi-registry authentication UI (single registry per deploy for now; CLI writes all entries if provided)
- Credential rotation/refresh after initial deploy
- Non-Docker registry authentication (e.g., containerd-only)
- Cloud-delegated credential forwarding (CLI handles forward directly via SSH)

---

*Generated by speckit*
