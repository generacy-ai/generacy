# Feature Specification: Worker Scale Lifecycle Action

`generacy-cloud` ships a UI for scaling worker replicas ("Worker Replicas" with +/- in the Cluster Config tab), wired to `PATCH /orgs/{orgId}/clusters/{clusterId}/workers`

**Branch**: `696-problem-generacy-cloud-ships` | **Date**: 2026-05-22 | **Status**: Draft

## Summary

Implement the `worker-scale` lifecycle action in the control-plane so the cloud UI's worker replica scaling actually works. Currently the action doesn't exist, causing a 400 error. Also fix the relay-bridge metadata to read the `workers` field name the scaffolder writes.

## Problem

`generacy-cloud` ships a UI for scaling worker replicas ("Worker Replicas" with +/- in the Cluster Config tab), wired to `PATCH /orgs/{orgId}/clusters/{clusterId}/workers`. That endpoint relays to `POST /control-plane/lifecycle/worker-scale` on the orchestrator. **That lifecycle action does not exist here.**

`LifecycleActionSchema` at [packages/control-plane/src/schemas.ts:39-48](https://github.com/generacy-ai/generacy/blob/develop/packages/control-plane/src/schemas.ts#L39-L48) currently allows: `bootstrap-complete`, `clone-peer-repos`, `code-server-start`, `code-server-stop`, `prepare-workspace`, `stop`, `vscode-tunnel-start`, `vscode-tunnel-stop`. No `worker-scale`. The control-plane returns `UNKNOWN_ACTION` → the user sees "Failed to scale workers (400)" in the Cluster Config UI.

This was acknowledged when the cloud side shipped — see [generacy-cloud spec 554](https://github.com/generacy-ai/generacy-cloud/blob/develop/specs/554-context-onboarding-v1-5/spec.md): *"This needs a companion issue on `generacy-ai/generacy` for the control-plane action (`worker-scale` or similar — to be specified there)."* The companion issue was never landed. This is that issue.

## What needs to happen

Add `worker-scale` to `LifecycleActionSchema` and implement the handler in [packages/control-plane/src/routes/lifecycle.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/control-plane/src/routes/lifecycle.ts) so it actually moves the replica count. The orchestrator container has the host docker socket mounted at `/var/run/docker-host.sock` (see scaffolder output) so `docker compose` calls from inside the orchestrator work.

The handler should:

1. Validate `body.count` is an integer ≥ 1. Upper bound is a tier limit and is already enforced by `generacy-cloud` before the request hits the cluster — the cluster shouldn't second-guess it.
2. Resolve the project directory (the dir containing `.generacy/cluster.yaml`) via the existing `project-dir-resolver`.
3. Update `WORKER_COUNT=<n>` in that project's `.env` (the variable docker-compose actually substitutes — see `replicas: ${WORKER_COUNT:-1}` in the compose file the scaffolder writes).
4. Update the `workers` field in `.generacy/cluster.yaml` (see related schema-cleanup work in the cloud companion issue — pick the flat `workers: <number>` shape that the scaffolder already writes).
5. Exec `docker compose -f <projectDir>/docker-compose.yml up -d --scale worker=<n>` from inside the orchestrator container. The compose file's top-level `name:` field ensures the correct project name is used without needing `-p` or `COMPOSE_PROJECT_NAME`.
6. Return `{ accepted: true, action: 'worker-scale', previousCount, requestedCount }` so the cloud-side audit-log entry has the data it expects (see `WorkerScaleResponse` shape in `services/api/src/services/worker-scale.ts` in generacy-cloud).
7. After scale completes, trigger an immediate metadata push via `POST /internal/refresh-metadata` on the orchestrator (gated by `ORCHESTRATOR_INTERNAL_API_KEY`). The relay-bridge already sends metadata via WebSocket (`client.send({type: 'metadata', data})`), and the cloud maps `metadata.workers` into the Firestore project doc. This avoids the 60s periodic refresh latency without requiring a new relay channel or cloud-side listener.

### Prerequisites

- **Companion PR to `generacy-ai/cluster-base`**: Add `docker-ce-cli` and `docker-compose-plugin` to the cluster-base Dockerfile. Currently only `cluster-microservices` installs these (lines 75-91). This is a blocker — without Docker CLI + Compose V2 in the container, the handler cannot execute `docker compose` commands. Adds ~70MB to the image.

## Drive-by: fix the cluster.yaml field name in the metadata reader

While in the relay-bridge, `readClusterYaml` at [packages/orchestrator/src/services/relay-bridge.ts:608-623](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/services/relay-bridge.ts#L608-L623) looks for `parsed?.workerCount` (camelCase). The scaffolder writes `workers: <n>` (flat field name). The cloud-side cluster-config service uses yet another shape (`workers: { count, enabled }`). Standardise on **`workers: <number>` flat** — it's what the scaffolder already writes and the simplest representation of "how many replica dev-containers." Rename the field the relay-bridge reads from `workerCount` → `workers`, and update the relay metadata type so the cloud receives `workers` not `workerCount`.

## Out of scope

- Cloud-deployed (DigitalOcean App Platform) clusters: scaling there needs a provider-side API call, not docker compose. The cloud UI already shows "Worker scaling not yet supported for cloud-deployed clusters" for `deploymentMode === 'cloud'`. Leave it that way for now.
- "Workers Enabled" pause/resume — that's a different concept and isn't wired to anything today. Will be removed in the companion cloud issue.
- Adding Docker CLI to cluster-base — tracked as a separate companion PR to `generacy-ai/cluster-base`.

## Acceptance

- `POST /lifecycle/worker-scale` with `{count: N}` scales the `worker` compose service to N replicas, persists N to both `.env` and `cluster.yaml`, and reports the new count back via an immediate metadata push.
- `LifecycleActionSchema` includes `worker-scale`; existing happy-path lifecycle tests still pass; new test covers the scale action end-to-end with a stubbed docker exec.
- Relay-bridge metadata payload exposes the cluster.yaml worker count as `workers` (flat number), matching the scaffolder's output.
- New `POST /internal/refresh-metadata` endpoint on orchestrator triggers immediate metadata push (gated by `ORCHESTRATOR_INTERNAL_API_KEY`).

## User Stories

### US1: Scale Worker Replicas via Cloud UI

**As a** team lead,
**I want** to adjust the number of worker replicas from the cloud dashboard,
**So that** I can scale development capacity up or down without SSH access to the cluster.

**Acceptance Criteria**:
- [ ] Clicking +/- in the Cluster Config "Worker Replicas" UI successfully scales the worker service
- [ ] The new count is reflected in the cloud UI within ~10 seconds

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `worker-scale` to `LifecycleActionSchema` | P1 | |
| FR-002 | Validate `body.count` is integer ≥ 1 | P1 | Upper bound enforced by cloud |
| FR-003 | Resolve project directory via `project-dir-resolver` | P1 | |
| FR-004 | Update `WORKER_COUNT` in `.env` file | P1 | |
| FR-005 | Update `workers` field in `cluster.yaml` | P1 | Flat `workers: <number>` shape |
| FR-006 | Execute `docker compose up -d --scale worker=<n>` | P1 | Compose file `name:` field provides project name |
| FR-007 | Return `{ accepted, action, previousCount, requestedCount }` | P1 | Matches cloud `WorkerScaleResponse` shape |
| FR-008 | Trigger immediate metadata push via `POST /internal/refresh-metadata` | P1 | Avoids 60s periodic refresh latency |
| FR-009 | Fix relay-bridge `readClusterYaml` to read `workers` not `workerCount` | P1 | Drive-by fix |
| FR-010 | Update relay metadata type from `workerCount` to `workers` | P1 | Matches scaffolder output |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Worker scale action succeeds | 100% for valid requests | Integration test with stubbed docker exec |
| SC-002 | UI reflects new count | < 10 seconds | Immediate metadata push after scale |
| SC-003 | Existing lifecycle tests pass | No regressions | CI pipeline |

## Assumptions

- Docker CLI + Compose V2 plugin will be installed in cluster-base via companion PR (blocker)
- The compose file's top-level `name:` field correctly resolves the project name for compose operations
- `DOCKER_HOST` env var or `/var/run/docker-host.sock` socket is available inside the orchestrator container

---

*Generated by speckit*
