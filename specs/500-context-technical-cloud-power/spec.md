# Feature Specification: CLI deploy ssh://host command (BYO-VM cluster deployment)

[v1.5][phase-10] Technical cloud power-user path

**Branch**: `500-context-technical-cloud-power` | **Date**: 2026-04-30 | **Status**: Draft
**Issue**: [#500](https://github.com/generacy-ai/generacy/issues/500)

## Summary

`generacy deploy ssh://user@host` provisions a Generacy cluster on any VM the user can SSH into, closing the gap for users whose preferred cloud provider isn't the v1 anchor (DigitalOcean App Platform). This is "Onboarding flow D: technical, cloud, bring-your-own-VM" from the [dev-cluster architecture](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md).

## Context

Phase 10 of v1.5. The CLI already supports local cluster lifecycle (`up`, `stop`, `down`, `destroy`, `status`, `update` from #494) and cloud-flow onboarding via `generacy launch --claim=<code>` (#495). This feature extends the CLI with a `deploy` command that targets remote VMs over SSH, enabling power users to run Generacy on their own infrastructure (Hetzner, EC2, GCP Compute, bare metal, etc.) without going through a managed platform.

The deploy command reuses the existing activation flow (#492), cluster registry (#494), and scaffolding patterns (#495) but executes them against a remote host via SSH/SCP.

## Scope

Implement `packages/generacy/src/cli/commands/deploy/` (in the `@generacy-ai/generacy` CLI package):

- **Target parsing**: `ssh://[user@]host[:port][/path]` URI scheme. Future provider-specific shapes (e.g., `do://`, `hetzner://`) are out of scope but the parser should be extensible.
- **SSH target flow**:
  1. Verify SSH connectivity and Docker presence on the remote host (`ssh ... 'command -v docker'`). Fail clearly if Docker is missing with a one-liner installation hint.
  2. Initiate the device-flow activation locally; auto-open the activation URL in the user's browser pre-approved with the calling user's session (or, if not signed-in locally, prompt and open the browser to sign in first).
  3. Generate a remote project directory (`~/generacy-clusters/<project-id>` on the remote by default; configurable via `--remote-dir`).
  4. SCP a small bootstrap bundle: `.generacy/cluster.yaml`, `docker-compose.yml`, the pre-approved activation `user_code` in env.
  5. SSH-execute `docker compose pull && docker compose up -d`.
  6. Stream remote logs to the local terminal until the cluster registers with the cloud.
  7. Add the cluster to the local registry (`~/.generacy/clusters.json`) with the SSH target as the management endpoint.
- **Remote lifecycle forwarding**: Subsequent `generacy stop`, `up`, `down`, etc. for an SSH-deployed cluster forward `docker compose` commands over SSH using the registry's stored target.

## Acceptance Criteria

- Deploys to a Hetzner / EC2-style VM with Docker pre-installed.
- Cluster registers with the cloud and reaches "connected" within the activation timeout.
- Subsequent `generacy stop --cluster=<id>` works against the remote.
- Failure paths produce clear errors: Docker missing, SSH auth failed, image pull failed.
- Integration test against a docker-in-docker test container as the SSH target.
- Documentation in the CLI package README covers the SSH target form and provider-extensibility.

## User Stories

### US1: Power user deploys to own VM

**As a** technical user with cloud infrastructure,
**I want** to deploy a Generacy cluster to my own VM with a single command,
**So that** I can run Generacy on my preferred cloud provider without being locked into a specific platform.

**Acceptance Criteria**:
- [ ] `generacy deploy ssh://ubuntu@my-server.example.com` provisions and starts a cluster
- [ ] Cluster appears in `generacy status` output after deployment
- [ ] The activation flow opens my browser for authentication

### US2: Remote cluster lifecycle management

**As a** user who deployed a cluster to a remote VM,
**I want** to manage that cluster's lifecycle with the same CLI commands I use locally,
**So that** I have a consistent experience regardless of where my cluster runs.

**Acceptance Criteria**:
- [ ] `generacy stop --cluster=<id>` stops the remote cluster via SSH
- [ ] `generacy up --cluster=<id>` restarts it
- [ ] `generacy down --cluster=<id>` tears it down
- [ ] `generacy update --cluster=<id>` pulls new images and recreates containers

### US3: Clear failure diagnostics

**As a** user attempting to deploy to a remote VM,
**I want** clear error messages when something goes wrong,
**So that** I can quickly diagnose and fix issues without guessing.

**Acceptance Criteria**:
- [ ] Missing Docker on remote produces an error with an installation hint
- [ ] SSH auth failure produces a clear message referencing SSH key configuration
- [ ] Image pull failure shows the failing image and suggests checking connectivity

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Parse `ssh://[user@]host[:port][/path]` target URI | P1 | Extensible for future provider URIs |
| FR-002 | Verify SSH connectivity before proceeding | P1 | `ssh -o ConnectTimeout=10 ... true` |
| FR-003 | Verify Docker availability on remote host | P1 | `command -v docker` + version check |
| FR-004 | Run device-flow activation locally | P1 | Reuse `packages/orchestrator/src/activation/` |
| FR-005 | Scaffold `.generacy/` config files locally before SCP | P1 | Reuse scaffolder patterns from #495 |
| FR-006 | SCP bootstrap bundle to remote host | P1 | Atomic: create dir + copy files |
| FR-007 | Execute `docker compose pull && up -d` on remote | P1 | Via SSH exec |
| FR-008 | Stream remote container logs to local terminal | P1 | `ssh ... docker compose logs -f` |
| FR-009 | Detect cluster registration and exit log stream | P2 | Watch for relay "connected" signal |
| FR-010 | Register cluster in `~/.generacy/clusters.json` with SSH target | P1 | New `managementEndpoint` field |
| FR-011 | Forward lifecycle commands to remote via SSH | P1 | `stop`, `up`, `down`, `update`, `destroy` |
| FR-012 | `--remote-dir` flag for custom remote path | P2 | Default: `~/generacy-clusters/<project-id>` |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Deploy-to-connected time | < 3 minutes (excluding image pull) | Time from command start to cluster "connected" |
| SC-002 | Remote lifecycle command latency | < 5 seconds overhead vs local | Compare SSH-forwarded vs local compose |
| SC-003 | Error clarity | All failure modes produce actionable messages | Manual review of each failure path |
| SC-004 | Integration test coverage | SSH deploy + lifecycle commands | DinD-based test suite passes in CI |

## Assumptions

- The remote host has Docker and Docker Compose v2 installed and the SSH user has permission to run `docker compose` (either root or in the `docker` group).
- The user's local SSH agent or key-based auth is configured; the CLI does not manage SSH keys.
- The remote host has outbound internet access for pulling container images and connecting to the Generacy cloud relay.
- The `@generacy-ai/generacy` CLI package from #493-#496 is the deployment target (not `@generacy-ai/cli`).

## Out of Scope

- Provider-specific deployment targets (e.g., `do://`, `hetzner://`, `aws://`) — extensibility hook only.
- SSH key provisioning or management.
- Remote Docker installation (hint only, no auto-install).
- Multi-node cluster deployment.
- Firewall/security group configuration on the remote host.
- TLS certificate management for the remote cluster.

---

*Generated by speckit*
