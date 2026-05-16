# Feature Specification: Fetch registry credentials from credhelper for `generacy update`

`generacy update` pulls the latest image and restarts the cluster

**Branch**: `641-context-generacy-update-pulls` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

Wire the `generacy update` command to fetch private registry credentials from the cluster's credhelper before pulling images. Materializes a scoped Docker config for the duration of the pull using credentials stored as `registry-<host>` in the credhelper, then cleans up afterward. Falls back to ambient Docker login when creds aren't found or the cluster is offline.

## Context

`generacy update` pulls the latest image and restarts the cluster. For projects using a private custom image, the pull needs registry credentials that now live in the cluster's credhelper (after the post-launch forward in the sibling issue). This issue wires the update path to fetch creds from credhelper, materialize a scoped DOCKER_CONFIG for the duration of the pull, and clean up afterward.

Part of [docs/cluster-variants-and-custom-images-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-variants-and-custom-images-plan.md) — Phase 2 Track B.

## Scope

- **In the `update` command** (`packages/generacy/src/cli/commands/update/`):
  - Before `docker compose pull`, query the cluster's control-plane via `GET /credentials/registry-<host>/value` (new endpoint) for credentials matching the image URL host.
  - If found, build Docker config JSON from discrete `{username, password}` fields and materialize a scoped config at `<projectDir>/.generacy/.docker/config.json` using the shared `materializeScopedDockerConfig()` helper from sibling #639.
  - Pass `DOCKER_CONFIG=<projectDir>/.generacy/.docker` to `docker compose pull`.
  - If not found (no `registry-<host>` credential), fall through to ambient `docker login` (no-creds path).
  - After pull (success or failure), delete the scoped config directory via `try/finally`.
- **New control-plane endpoint** (`GET /credentials/:id/value`):
  - Returns the decrypted secret value by calling `ClusterLocalBackend.fetchSecret()`.
  - Restricted to local Unix socket callers. Audit-logged separately from metadata reads.
  - Existing `GET /credentials/:id` metadata endpoint unchanged.
- **If the cluster is not running** (so control-plane is unreachable):
  - Print a message: "Cluster is offline; the update will use your machine's ambient docker login. If the image requires credentials stored on the cluster, start the cluster first with `generacy up`."
  - Proceed with pull anyway (the ambient case may work for public images or users with their own `docker login`).

## Acceptance Criteria

- `generacy update` for a default-variant project works as today (no behavioral change).
- `generacy update` for a private-image project with creds in credhelper succeeds without re-prompting.
- `generacy update` with cluster offline prints the warning and proceeds.
- Scoped config at `.generacy/.docker/` cleaned up in all paths (success, failure, signal).
- `GET /credentials/:id/value` endpoint returns decrypted secret for valid credential IDs.
- Tests cover: with-creds-running, without-creds, cluster-offline.

## Depends on

- Sibling: "Forward registry credentials to credhelper after first launch".
- Sibling #639: "Pull cluster image with scoped private-registry credentials" (provides `materializeScopedDockerConfig()` helper). If #639 hasn't landed, this issue implements the helper.

## User Stories

### US1: Private Image Update

**As a** developer using a custom private container image,
**I want** `generacy update` to automatically use my stored registry credentials,
**So that** I can pull updated images without manually re-authenticating.

**Acceptance Criteria**:
- [ ] `generacy update` fetches registry credentials from credhelper and authenticates the pull
- [ ] No interactive login prompt during update

### US2: Offline Cluster Update

**As a** developer whose cluster is stopped,
**I want** `generacy update` to warn me and fall back to ambient Docker login,
**So that** I can still pull public images or use my own `docker login` credentials.

**Acceptance Criteria**:
- [ ] Warning message printed when cluster is offline
- [ ] Pull proceeds using ambient Docker config

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Query control-plane `GET /credentials/registry-<host>/value` before pull | P1 | New endpoint needed |
| FR-002 | Build Docker config JSON from `{username, password}` credential value | P1 | Format: `{"auths":{"<host>":{"auth":"base64(user:pass)"}}}` |
| FR-003 | Materialize scoped config at `<projectDir>/.generacy/.docker/config.json` | P1 | Uses shared helper from #639 |
| FR-004 | Pass `DOCKER_CONFIG` env to `docker compose pull` | P1 | |
| FR-005 | Clean up scoped config in all exit paths | P1 | `try/finally` pattern |
| FR-006 | Fall through to ambient login when no credential found | P2 | Silent fallback |
| FR-007 | Print warning and proceed when cluster is offline | P2 | |
| FR-008 | New `GET /credentials/:id/value` control-plane endpoint | P1 | Audit-logged, socket-only |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Private image update success rate | 100% when creds present | Test: with-creds-running scenario |
| SC-002 | Scoped config cleanup | No leftover `.generacy/.docker/` after any exit path | Test: verify cleanup after success, failure, and signal |
| SC-003 | Backward compatibility | Default-variant projects unaffected | Test: without-creds scenario |

## Assumptions

- The sibling issue #639 lands first and provides `materializeScopedDockerConfig()`. If not, this issue implements the helper.
- Registry credential values are stored as `{"username": "...", "password": "..."}` JSON in credhelper.
- Credential ID convention is `registry-<host>` where `<host>` matches the image URL host.
- The control-plane Unix socket is accessible from the host CLI when the cluster is running.

## Out of Scope

- Credential rotation or refresh during update.
- Multi-registry support (single registry per cluster image).
- Modifying the existing `GET /credentials/:id` metadata endpoint.
- Cloud-side changes to credential storage format.

---

*Generated by speckit*
