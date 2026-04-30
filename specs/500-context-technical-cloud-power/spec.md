# Feature Specification: CLI deploy ssh://host command

BYO-VM cluster deployment for the technical-cloud-power-user path

**Branch**: `500-context-technical-cloud-power` | **Date**: 2026-04-30 | **Status**: Draft

## Summary

`generacy deploy ssh://user@host` provisions a Generacy cluster on any VM the user can SSH into, closing the gap for users whose preferred provider isn't the v1 anchor (DigitalOcean App Platform).

## Context

The technical-cloud-power-user path. Architecture: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "Onboarding flow D: technical, cloud, bring-your-own-VM".

## Scope

Implement `packages/generacy/src/cli/commands/deploy/` (in the `@generacy-ai/generacy` CLI package shipped in phase 5):

- Parse the target: `ssh://[user@]host[:port][/path]` and (future) provider-specific shapes.
- For SSH targets:
  1. Verify SSH connectivity and Docker presence on the remote host (`ssh ... 'command -v docker'`). Fail clearly if Docker is missing with a one-liner installation hint.
  2. Initiate the device-flow activation locally using the shared `@generacy-ai/activation-client` package; auto-open the `verification_uri` URL in the user's default browser. The user approves via their existing generacy.ai browser session (cookie-authenticated). Same UX as `npx generacy launch` (#495). No CLI-stored credentials needed.
  3. After device-flow completion, fetch compose config from the cloud's launch-config endpoint (`GET /api/clusters/launch-config?claim=<code>`) to obtain `imageTag` and compose template. Reuses #495's `LaunchConfig` shape.
  4. Generate a remote project directory (`~/generacy-clusters/<project-id>` on the remote by default; configurable).
  5. SCP a small bootstrap bundle: `.generacy/cluster.yaml`, `.generacy/cluster.json`, `docker-compose.yml` (templated from LaunchConfig), activation env vars.
  6. SSH-execute `docker compose pull && docker compose up -d`.
  7. Stream remote logs to the local terminal while polling the cloud's cluster status endpoint until `status === 'connected'`, with a 5-minute default timeout (configurable via `--timeout=<seconds>`). After timeout, show an error pointing to `generacy status --cluster=<id>` for diagnosis.
  8. Add the cluster to the local registry (`~/.generacy/clusters.json`) with the SSH target as the `managementEndpoint`.

Subsequent `generacy stop`, `up`, etc. for an SSH-deployed cluster transparently forward `docker compose` over SSH. The shared `getClusterContext()` helper reads the registry entry; if `managementEndpoint` starts with `ssh://`, lifecycle commands forward over SSH instead of running locally. Extend `commands/cluster/compose.ts` with an SSH-forwarding branch. Same UX whether local or remote.

### Activation Client Package

Extract the protocol-level device-flow client (init, poll-with-backoff, status decoding — ~200 LOC) from `packages/orchestrator/src/activation/` into a new shared package `@generacy-ai/activation-client`. The orchestrator wraps it with file-based key persistence; the CLI's deploy command wraps it with browser-open behavior.

## Acceptance criteria

- Deploys to a Hetzner / EC2-style VM with Docker pre-installed.
- Cluster registers with the cloud and reaches "connected" within the 5-minute default timeout.
- Subsequent `generacy stop --cluster=<id>` works against the remote (transparently forwarded over SSH).
- Failure paths produce clear errors: Docker missing, SSH auth failed, image pull failed.
- Integration test against a docker-in-docker test container as the SSH target.
- Documentation in the CLI package README covers the SSH target form and provider-extensibility.

## User Stories

### US1: Deploy to BYO VM

**As a** technical cloud user,
**I want** to run `generacy deploy ssh://user@host` to provision a cluster on my own VM,
**So that** I can use Generacy on any cloud provider or bare-metal server I have SSH access to.

**Acceptance Criteria**:
- [ ] CLI parses `ssh://[user@]host[:port][/path]` target format
- [ ] SSH connectivity and Docker presence verified before deployment
- [ ] Device-flow activation opens browser for approval
- [ ] Compose config fetched from cloud, files transferred via SCP
- [ ] Cluster starts and registers within timeout
- [ ] Cluster added to local registry with SSH management endpoint

### US2: Manage Remote Cluster

**As a** user with an SSH-deployed cluster,
**I want** to use the same `generacy stop/up/down` commands as local clusters,
**So that** I don't need to remember different commands for remote vs local clusters.

**Acceptance Criteria**:
- [ ] Lifecycle commands transparently detect SSH clusters from registry
- [ ] `docker compose` forwarded over SSH using stored `managementEndpoint`
- [ ] No extra flags needed for remote cluster management

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Parse SSH target URL `ssh://[user@]host[:port][/path]` | P1 | Future: provider-specific shapes |
| FR-002 | Verify SSH connectivity and Docker presence | P1 | Fail with installation hint if Docker missing |
| FR-003 | Run device-flow activation via `@generacy-ai/activation-client` | P1 | Shared package extracted from orchestrator |
| FR-004 | Fetch compose config from cloud launch-config endpoint | P1 | Reuses `LaunchConfig` from #495 |
| FR-005 | SCP bootstrap bundle to remote host | P1 | cluster.yaml, cluster.json, docker-compose.yml |
| FR-006 | SSH-execute `docker compose pull && up -d` | P1 | |
| FR-007 | Stream remote logs during deployment | P1 | Continues until registration or timeout |
| FR-008 | Poll cloud cluster status endpoint for registration | P1 | `status === 'connected'` |
| FR-009 | 5-minute default timeout, configurable via `--timeout` | P2 | Error points to `generacy status` |
| FR-010 | Add cluster to local registry with SSH management endpoint | P1 | |
| FR-011 | Lifecycle commands transparently forward over SSH | P1 | Extend `compose.ts` helper |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Deploy-to-connected time | < 5 minutes on typical VM | End-to-end timing from `deploy` to `connected` status |
| SC-002 | Error clarity | All failure modes produce actionable messages | Manual review of Docker-missing, SSH-auth-failed, pull-failed paths |
| SC-003 | Lifecycle parity | All lifecycle commands work identically for SSH and local clusters | Integration test coverage |

## Assumptions

- Target VM has Docker pre-installed and the SSH user has permission to run `docker compose`.
- User has SSH key-based authentication configured (no interactive password prompts).
- Target VM has outbound internet access for Docker image pulls and cloud relay connection.
- The cloud's launch-config endpoint is available and returns a valid `LaunchConfig` after device-flow completion.

## Out of Scope

- Provider-specific deployment targets (e.g., `aws://`, `hetzner://`) — future extensibility only.
- Automatic Docker installation on the remote host.
- SSH password authentication (key-based only for v1).
- Multi-node cluster deployment.
- Remote host OS detection or configuration management.

---

*Generated by speckit*
