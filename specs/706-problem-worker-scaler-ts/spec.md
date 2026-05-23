# Feature Specification: Worker Scaling via Docker Engine API

**Branch**: `706-problem-worker-scaler-ts` | **Date**: 2026-05-23 | **Status**: Draft
**Issue**: [#706](https://github.com/generacy-ai/generacy/issues/706)
**Workflow**: speckit-bugfix

## Summary

Replace `worker-scaler.ts`'s `docker compose -f … --scale worker=N` shell-out with direct Docker Engine API calls (via `dockerode`). The current implementation requires the host compose file to be reachable from inside the orchestrator container at `<workspace>/.generacy/docker-compose.yml` — but for clusters launched via `npx generacy launch` (Flow B), that file lives on the user's host machine (e.g. `C:\Users\<user>\Generacy\<project>\.generacy\docker-compose.yml`) and is not bind-mounted into the orchestrator. As a result, every scale request fails with ENOENT before `docker compose` is ever invoked.

The fix uses the Engine API socket (`/var/run/docker-host.sock`, already mounted via Docker-outside-of-Docker) to enumerate worker containers by their `com.docker.compose.*` labels, then create/destroy replicas directly. This removes the compose-file dependency entirely and works uniformly across all cluster launch flows (Flow B `launch`, Flow C devcontainer, future BYO-VM/cloud).

## Clarifications

Resolved 2026-05-23 (see [clarifications.md](./clarifications.md) for full Q&A):

- **Multi-network workers (Q1 → A)**: Cloned replicas attach to **all** networks the source replica is on. Create with the first network in `NetworkingConfig.EndpointsConfig`, then `POST /networks/<id>/connect` for the rest before `start`. Source network set comes from the daemon's `NetworkSettings.Networks` on the source container, not from any `com.docker.compose.*` network labels.
- **Partial scale-up failure (Q2 → B)**: **Commit what succeeded**. Leave successfully created replicas running, write the achieved count to `cluster.yaml`, return a structured error with `requested` and `actual` fields. Strict rollback is rejected because the rollback itself can fail and produce a worse state.
- **Counting semantics (Q3 → A)**: Enumerate workers with `?all=true`. Stopped/exited replicas count toward the current total (they hold a container-name + container-number). On scale-down, retire exited replicas first.
- **Concurrent scale calls (Q4 → A)**: In-process async mutex serializes `scaleWorkers()` calls; second caller waits, then operates on the post-first state. No 409 surfaced to the cloud UI in normal operation.
- **Gap-fill name collision (Q5 → A)**: If a target slot's container name is held by a stopped container, `DELETE /containers/<id>?force=true` then create. Workers are stateless, so force-remove is safe. With Q3=A in place, this path is an edge case (manual `docker rm` of a running worker) rather than normal operation.

## Problem

`worker-scaler.ts` ([packages/control-plane/src/services/worker-scaler.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/control-plane/src/services/worker-scaler.ts)) scales by shelling out to `docker compose -f <workspace>/.generacy/docker-compose.yml up -d --scale worker=N`. This assumes the compose file is reachable from inside the orchestrator container. For real local clusters launched via `npx generacy launch`, the compose file is written by the CLI scaffolder on the host (`~/Generacy/<project>/.generacy/docker-compose.yml`), and that host directory is not bind-mounted into the orchestrator.

Verified on a live cluster:

```
$ docker inspect microservices-test-1-orchestrator-1 \
    --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
C:\Users\<user>\Generacy\microservices-test-1\.generacy\docker-compose.yml

$ docker exec microservices-test-1-orchestrator-1 ls /workspaces/microservices-test-1/.generacy/
README.md  cluster-base.json  cluster.yaml  config.yaml
setup.ps1  setup.sh  switch-channel.ps1  switch-channel.sh
# no docker-compose.yml, no .env
```

Every scale request via the cloud UI fails with ENOENT before `docker compose` is invoked. The PR test plan for [#696](https://github.com/generacy-ai/generacy/issues/696) had an unchecked item — "worker-scale action successfully spawns/removes worker replicas against a real cluster" — and this is what would have surfaced it.

### Why the simple fixes don't work

- **Bind-mount the host compose dir into the container**: requires CLI scaffolder changes to emit a self-referential mount; non-portable across host paths; doesn't help cluster-microservices' DooD flow either.
- **Copy the compose file into the user's cloned repo**: that repo is git-tracked and shouldn't contain cluster-runtime config the user didn't write.
- **Have the orchestrator regenerate the compose YAML from the CLI's template**: drifts every time the CLI scaffolder changes; duplicates source of truth.

## User Stories

### US1: Scale workers from the cloud UI on a launched cluster

**As a** developer running a local cluster via `npx generacy launch`,
**I want** the "scale workers" control in the cloud UI to actually add and remove worker replicas,
**So that** I can size the cluster to the workload without rebuilding from the CLI.

**Acceptance Criteria**:
- [ ] `PATCH /orgs/{orgId}/clusters/{clusterId}/workers` with `count: N` succeeds on a cluster launched via `npx generacy launch` (where no compose file exists inside the orchestrator container).
- [ ] After a scale-up, `docker compose ps` on the host shows the new replicas with the expected `com.docker.compose.container-number` labels.
- [ ] After a scale-down, the highest-numbered replicas are removed and `docker compose ps` reflects the reduced count.
- [ ] `cluster.yaml`'s `workers` field reflects the requested count after the operation.

### US2: Operator inspects scaled cluster state via standard tooling

**As an** operator debugging a cluster,
**I want** `docker compose ps` on the host to show a coherent state after orchestrator-driven scaling,
**So that** I can use existing compose tooling without seeing inconsistencies (gaps, duplicates, missing labels).

**Acceptance Criteria**:
- [ ] Container-number labels remain monotonically increasing with no gaps after any sequence of scale-up/down operations.
- [ ] Container names follow compose's naming convention (`<project>-worker-<n>`).
- [ ] `com.docker.compose.project`, `com.docker.compose.service`, `com.docker.compose.container-number`, and `com.docker.compose.config-hash` labels are present on all replicas created by the orchestrator.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Replace `execDockerScale` in `worker-scaler.ts` with Engine API calls via `dockerode` (or equivalent typed client). | P1 | Remove `spawn('docker', …)` and stderr parsing. |
| FR-002 | Enumerate existing worker containers via `GET /containers/json?all=true` filtered by `com.docker.compose.project=<name>` and `com.docker.compose.service=worker`. Include stopped/exited replicas in the current count — they occupy a `container-number` slot and hold their container name. | P1 | `all=true` is required (clarification Q3). Project name discovered from orchestrator's own container labels. |
| FR-003 | On scale-up (`requested > current`): inspect an existing worker for full config (image, env, volumes, networks, command, healthcheck, restart policy). For each new replica: `POST /containers/create` with the first network attached via `NetworkingConfig.EndpointsConfig`, then `POST /networks/<id>/connect` for every additional network the source replica is on, then `POST /containers/<id>/start`. | P1 | Clone config; mutate only `container-number` label and container name. Multi-network attachment via post-create `connect` matches compose's behaviour (clarification Q1). Source network set comes from the daemon's actual `NetworkSettings.Networks` on the source, not from `com.docker.compose.*` labels. |
| FR-004 | On scale-down (`requested < current`): `POST /containers/<id>/stop` + `DELETE /containers/<id>` on the replicas to retire. Selection order: **exited/stopped replicas first** (highest-numbered among them), then healthy running replicas (highest-numbered). | P1 | Crashed workers are a stronger signal to retire than arbitrary live ones (clarification Q3). |
| FR-005 | No-op when `requested == current`. | P1 | |
| FR-006 | Container-number assignment: fill gaps first (ascending), then append. New replicas are numbered to keep the set contiguous from 1. Because exited replicas are counted (FR-002), gap-fill in normal operation has no collisions. | P1 | Pure helper, unit-tested. |
| FR-007 | Reuse the existing `com.docker.compose.config-hash` label value when cloning a replica. | P2 | Pure scale ops don't change service config; reuse is acceptable and matches compose semantics. |
| FR-008 | Preserve atomic `cluster.yaml` `workers` field update on success. | P1 | Existing logic — keep. |
| FR-009 | Preserve metadata refresh trigger (`/internal/refresh-metadata`) on success. | P1 | Existing logic — keep. |
| FR-010 | Remove `.env` `WORKER_COUNT` writes from the scale path. | P2 | Dead state post-first-boot. `cluster.yaml` is the on-disk source of truth. |
| FR-011 | Use the Engine API socket at `/var/run/docker-host.sock` (already mounted via DooD). | P1 | No new mounts or capabilities. |
| FR-012 | On partial scale failure (e.g. some `POST /containers/create` calls succeed but a subsequent call fails, daemon hiccups mid-operation): **commit what succeeded**. Leave any successfully created/started replicas running, write the actual achieved count to `cluster.yaml`, fire metadata refresh, and return a structured error including both `requested` and `actual` counts. Do not roll back successful creates. On full failure (zero replicas created), do not update `cluster.yaml`. | P1 | Best-effort semantics — strict rollback trades one daemon-failure mode for two (clarification Q2). The error payload lets the cloud UI render "requested 5, scaled to 3" instead of a generic failure; the next `scaleWorkers()` call simply creates the remainder. |
| FR-013 | Document the "stale clone" drift case in a code comment: if the user edits the host compose file and rebuilds without `docker compose up -d`, scale-up clones a stale replica — same behaviour as compose itself. | P2 | Comment only; not a code change beyond documentation. |
| FR-014 | Serialize concurrent `scaleWorkers()` calls behind an in-process async mutex. Second concurrent caller waits for the first to complete and then operates on the post-first state. | P1 | Orchestrator is a single process per cluster; in-process lock is correct and sufficient (clarification Q4). Handles two-tab UI, stale retries, and network-blip duplicate requests without surfacing 409s in normal operation. |
| FR-015 | If gap-fill targets a `container-number` slot whose container name is held by a stopped/exited container (edge case after manual `docker rm` of a running replica), `DELETE /containers/<id>?force=true` on the stale container before creating the new replica in that slot. | P2 | Workers are stateless (workspace volume bind-mounted; container state ephemeral) so force-remove is safe (clarification Q5). `?force=true` also handles the "thought-it-was-exited-but-actually-running" race. In normal operation this path doesn't fire because FR-002 counts exited replicas. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Scale-up succeeds on a `npx generacy launch` cluster | 100% | Manual test: launch a cluster, send `PATCH /workers count: 3` from cloud UI, verify 3 worker containers running via `docker compose ps`. |
| SC-002 | Scale-down succeeds on a launched cluster | 100% | Manual test: from 3 workers, send `PATCH /workers count: 1`, verify only worker-1 remains via `docker compose ps`. |
| SC-003 | Container-number labels remain contiguous | No gaps after any operation | Inspect labels on all worker containers after scale up/down sequences. |
| SC-004 | No compose file dependency inside the container | Zero file-system reads of `<workspace>/.generacy/docker-compose.yml` from the scale path | Code audit + integration test against a cluster where the file does not exist inside the container. |
| SC-005 | `cluster.yaml` reflects requested count after success | Match `workers: N` in YAML | Read `cluster.yaml` post-scale, assert `workers === requested`. |
| SC-006 | Metadata refresh fires after scale | Single `/internal/refresh-metadata` call per successful scale | Log inspection or test fixture assertion. |
| SC-007 | No `docker compose` shell-out in `worker-scaler.ts` | Zero `spawn`/`exec` calls to `docker` in the file | Code audit / grep. |
| SC-008 | Multi-network replicas remain reachable on all source networks | Cloned replica is attached to every network the source was on | Inspect `NetworkSettings.Networks` on a new replica after scale-up against a worker on ≥2 networks. |
| SC-009 | Partial-failure path commits what succeeded | `cluster.yaml.workers` equals achieved count; error payload includes `requested` and `actual` | Fault-injection test (stub `POST /containers/create` to fail on Nth call), assert `cluster.yaml` and returned error shape. |
| SC-010 | Concurrent scale calls are serialized | Two simultaneous `scaleWorkers()` invocations produce a final state matching the second call (operates on post-first state), no duplicate `container-number` labels | Concurrency test: fire two `PATCH /workers` requests in parallel, inspect final container set. |
| SC-011 | Exited replicas counted in current state | A worker in `exited` state is counted toward `current`; scale-up does not collide on its slot, scale-down retires it before healthy replicas | Test fixture with one exited + N running replicas; assert behaviour on both scale-up and scale-down. |

## Assumptions

- The orchestrator container already has access to `/var/run/docker-host.sock` (Docker-outside-of-Docker is the architectural intent for cluster-base — see [cluster-base#45](https://github.com/generacy-ai/cluster-base/issues/45)).
- The orchestrator container is itself a compose-managed container and carries `com.docker.compose.project` on its own labels (used to derive the project name for filtering workers).
- At least one worker replica exists before any scale-up operation (workers are created by the initial `docker compose up` from the host). Scale-up from zero is out of scope for this issue — covered separately if needed.
- The `com.docker.compose.config-hash` label can be safely reused when cloning, because pure scale operations do not change service config. Compose itself uses hash comparison to decide when to recreate replicas; we are not changing the service definition.
- `dockerode` is acceptable as a new dependency for the control-plane package. If we prefer to avoid it, a thin hand-rolled HTTP-over-Unix-socket client (same pattern as credhelper-daemon) is an acceptable alternative.

## Out of Scope

- Scale-up from zero workers (no existing replica to clone). Filed separately if needed.
- Per-worker lifecycle operations (pause, drain, individual restart, per-worker health probes) — these become possible building blocks but are not implemented here.
- Cloud-deployed scaling (DigitalOcean App Platform API, etc.) — symmetric interface is a side benefit but actual implementation is gated on [generacy-cloud spec #554](https://github.com/generacy-ai/generacy-cloud/blob/develop/specs/554-context-onboarding-v1-5/spec.md).
- Fixing the orchestrator's working directory so `cluster.yaml` and other workspace-relative reads resolve correctly. Filed as a separate companion issue against `cluster-base`. Both are required for end-to-end scale to work, but the order doesn't matter.
- Rewriting other compose shell-outs in the codebase (this is a targeted fix for `worker-scaler.ts` only).
- Changes to the cloud-side `PATCH /workers` contract — the request/response shape stays the same.

## Side Benefits (informational)

- **Compose-file location stops mattering**: works for `npx generacy launch` (Flow B), devcontainer mode (Flow C), and future BYO-VM/cloud variants without per-flow plumbing.
- **Symmetric interface for future cloud-deployed scaling**: the same `scaleWorkers()` interface can dispatch to a cloud-provider API when that becomes supported.
- **Building block for richer worker lifecycle**: pause/drain, per-worker restart, individual health probes — none of which compose models cleanly.

---

*Generated by speckit*
