# Feature Specification: Fetch Registry Credentials from Credhelper for `generacy update`

**Branch**: `641-context-generacy-update-pulls` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

Wire the `generacy update` command to fetch private-registry credentials from the cluster's credhelper daemon before pulling images. Materialize a scoped `DOCKER_CONFIG` for the duration of the pull, then clean up. Fall back gracefully when the cluster is offline or no credentials exist.

## Context

`generacy update` pulls the latest image and restarts the cluster. For projects using a private custom image, the pull needs registry credentials that now live in the cluster's credhelper (after the post-launch forward in the sibling issue). This issue wires the update path to fetch creds from credhelper, materialize a scoped DOCKER_CONFIG for the duration of the pull, and clean up afterward.

Part of [docs/cluster-variants-and-custom-images-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-variants-and-custom-images-plan.md) — Phase 2 Track B.

## User Stories

### US1: Private-image update with stored credentials

**As a** developer using a private custom cluster image,
**I want** `generacy update` to automatically use registry credentials stored in the cluster's credhelper,
**So that** I can pull updated private images without manually running `docker login` or re-entering credentials.

**Acceptance Criteria**:
- [ ] `generacy update` fetches `registry-<host>` credential from credhelper Unix socket
- [ ] Pull succeeds for private-registry images without user interaction
- [ ] Scoped docker config is created before pull and deleted after (success or failure)

### US2: Graceful offline fallback

**As a** developer whose cluster is currently stopped,
**I want** `generacy update` to warn me and proceed with ambient Docker credentials,
**So that** I can still update public images or images I have ambient login for without first starting the cluster.

**Acceptance Criteria**:
- [ ] Warning message printed when cluster is offline
- [ ] Pull proceeds using ambient `~/.docker/config.json`
- [ ] No error thrown for unreachable credhelper socket

### US3: Default-variant backward compatibility

**As a** developer using the default cluster variant (public GHCR image),
**I want** `generacy update` to work exactly as it does today,
**So that** this change doesn't break existing workflows.

**Acceptance Criteria**:
- [ ] No behavioral change when no `registry-*` credential exists
- [ ] No scoped config created when credential lookup returns empty

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extract image registry host from cluster's docker-compose.yml `image:` field | P1 | Parse `image:` to get hostname (default: `ghcr.io`) |
| FR-002 | Query credhelper Unix socket for `registry-<host>` credential | P1 | `GET /credentials/registry-<host>` on control-plane socket |
| FR-003 | Materialize scoped `<projectDir>/.docker/config.json` with fetched auth | P1 | Shares helper with sibling "pull with scoped creds" issue |
| FR-004 | Pass `DOCKER_CONFIG=<projectDir>/.docker` env to `docker compose pull` | P1 | Scoped, not global |
| FR-005 | Delete scoped config after pull completes (success or failure) | P1 | try/finally pattern |
| FR-006 | Detect cluster-offline (socket unreachable) and print warning | P2 | Proceed with ambient creds |
| FR-007 | No-op when credential not found (fall through to ambient) | P2 | Silent, debug-level log only |

## Technical Design

### Flow

```
generacy update
  ├─ ensureDocker()
  ├─ getClusterContext()
  ├─ extractImageHost(ctx.composePath) → host | null
  ├─ if host:
  │    ├─ probeCredhelperSocket(ctx) → reachable?
  │    │    ├─ yes → fetchRegistryCred(socket, host) → cred | null
  │    │    │         ├─ cred found → materializeScopedDockerConfig(ctx.projectRoot, cred)
  │    │    │         └─ not found → debug log, proceed
  │    │    └─ no → print offline warning, proceed
  │    └─ runCompose(ctx, ['pull'], { env: { DOCKER_CONFIG } })
  │    └─ finally: cleanupScopedDockerConfig(ctx.projectRoot)
  ├─ else: runCompose(ctx, ['pull'])  ← default path (no private registry)
  ├─ runCompose(ctx, ['up', '-d'])
  ├─ upsertRegistryEntry(ctx)
  └─ done
```

### Key implementation details

- **Socket path**: `/run/generacy-control-plane/control.sock` (reuse existing `CONTROL_PLANE_SOCKET_PATH` env var)
- **Credential key**: `registry-<host>` (e.g., `registry-ghcr.io`, `registry-us-docker.pkg.dev`)
- **Scoped config helper**: Shared with sibling issue — likely at `packages/generacy/src/cli/commands/cluster/scoped-docker-config.ts`
- **runCompose extension**: `runCompose` needs to accept optional env overrides for the `DOCKER_CONFIG` variable
- **SSH-forwarding path**: For remote clusters (`ssh://`), credentials cannot be fetched locally; skip credhelper query, log debug message

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Private-image pull succeeds | 100% when creds exist and cluster is running | Integration test |
| SC-002 | No regression for public-image clusters | Zero behavioral change | Existing update tests pass |
| SC-003 | Scoped config never left on disk | Cleaned in all code paths | Unit test asserting cleanup |
| SC-004 | Offline warning displayed | Correct message on stderr | Unit test |

## Assumptions

- The credhelper daemon exposes credential read via the control-plane socket (`GET /credentials/<id>`)
- The sibling issue ("Pull cluster image with scoped private-registry credentials") provides or shares a `materializeScopedDockerConfig()` helper
- The `docker compose pull` command respects `DOCKER_CONFIG` env var for registry auth
- Credential value format is a Docker auth JSON (base64-encoded `user:pass` in `auth` field)

## Out of Scope

- Credential rotation/refresh during update (handled by credhelper lifecycle)
- SSH-forwarded remote cluster credential fetch (remote cluster has its own credhelper)
- Multi-registry support (only one image per compose service currently)
- Storing or caching credentials on the host machine

## Depends on

- Sibling: "Forward registry credentials to credhelper after first launch"
- Sibling: "Pull cluster image with scoped private-registry credentials" (shares the scoped-config helper)

---

*Generated by speckit*
