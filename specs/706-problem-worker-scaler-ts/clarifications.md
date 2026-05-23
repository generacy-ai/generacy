# Clarifications: Worker Scaling via Docker Engine API

**Issue**: [#706](https://github.com/generacy-ai/generacy/issues/706)
**Branch**: `706-problem-worker-scaler-ts`

---

## Batch 1 — 2026-05-23

### Q1: Multi-network attachment
**Context**: The Engine API's `POST /containers/create` only accepts a *single* network in `NetworkingConfig.EndpointsConfig`. If an existing worker is attached to multiple networks (e.g. an app network plus a redis network), the cloned replica must be created on one network and then connected to the others via `POST /networks/<id>/connect` after creation but before `start`. The spec (FR-003) says "clone config" but does not address this.
**Question**: When cloning a worker that is attached to multiple networks, what should the replica be attached to?
**Options**:
- A: Attach to *all* networks the source replica is on, using `POST /networks/<id>/connect` for any beyond the first. Match compose's behaviour.
- B: Attach only to the project's default network (`<project>_default`). Acceptable if workers in practice are single-network.
- C: Inspect the original compose-managed worker's `com.docker.compose.*` network labels (if any) and attach to exactly the set listed there.

**Answer**: *Pending*

---

### Q2: Partial scale-up failure
**Context**: FR-012 says "do not partially scale and leave `cluster.yaml` inconsistent" and "Update `cluster.yaml` only after Engine API operations succeed." But a scale-up of N new replicas can partially succeed (e.g. 3 of 5 created, then `POST /containers/create` returns 409 or the daemon hiccups). The spec does not say whether we should roll back the successful creates or commit the partial result.
**Question**: On partial scale-up failure, what is the desired behaviour?
**Options**:
- A: **Rollback** — destroy (`stop` + `delete`) any replicas successfully created during this call, leave `cluster.yaml` at the previous count, return a structured error. Strictly atomic.
- B: **Commit what succeeded** — leave the created replicas running, write the actual count (e.g. 3 if 3 of 5 succeeded) to `cluster.yaml`, return a structured error indicating the requested vs actual delta. Best-effort.
- C: **Fail-fast, no cleanup** — leave created replicas in place, do not update `cluster.yaml`, return an error. Caller can retry or manually reconcile.

**Answer**: *Pending*

---

### Q3: Counting semantics — include exited replicas?
**Context**: FR-002 enumerates worker containers via `GET /containers/json` filtered by the compose labels. By default this only returns *running* containers; passing `all=true` includes stopped/exited ones. The "current count" used by the gap-fill logic (FR-006) and the scale-up/down comparison (FR-003/FR-004) depends on this choice. A worker that crashed and is in `exited` state still occupies a `container-number` and would collide on name reuse if treated as absent.
**Question**: Should the current-count enumeration include stopped/exited worker containers that carry the project labels?
**Options**:
- A: **Yes, include them** (`all=true`). They occupy a container-number slot; gap-fill must skip those slots; scale-down should arguably remove them first.
- B: **No, running only**. Stopped containers are treated as gaps; gap-fill will reuse their names, requiring `force-remove` before create.
- C: Include them but require an explicit `cleanup` action (out of scope of pure scale) to remove them; warn/log if found.

**Answer**: *Pending*

---

### Q4: Concurrent scale requests
**Context**: `PATCH /orgs/{orgId}/clusters/{clusterId}/workers` can be invoked concurrently (two UI tabs, a stale retry, etc.). Two simultaneous scale operations against the Engine API could each enumerate workers, compute a delta, and create overlapping/duplicate replicas — or both write `cluster.yaml` and lose one update. The current implementation does not lock; the spec is silent on whether the new implementation should.
**Question**: Should concurrent scale requests be serialized within `scaleWorkers()`?
**Options**:
- A: **In-process mutex** — single async lock around the whole scale operation. Second concurrent caller waits. Simple, correct for the single-orchestrator topology.
- B: **Reject second caller** — return 409 Conflict (or equivalent structured error) if a scale is already in flight. Surfaces concurrency to the cloud UI.
- C: **No serialization** — accept the race. Argument: cloud UI single-flights from the user's side and the bug is unlikely in practice.

**Answer**: *Pending*

---

### Q5: Container-name collision on gap fill
**Context**: FR-006 says "fill gaps first (ascending), then append." If the gap exists because a previous worker was stopped (not deleted) — e.g. `<project>-worker-2` is in `exited` state — `POST /containers/create?name=<project>-worker-2` will return 409 Conflict. The spec does not say whether to force-remove the dead container or skip that slot.
**Question**: When filling a gap whose container-name is still occupied by a stopped/exited container, what should happen?
**Options**:
- A: **Force-remove then create** — `DELETE /containers/<id>?force=true` on the stopped container, then create the new replica in that slot. Compose-like behaviour.
- B: **Skip the slot, append instead** — leave the stopped container alone, give the new replica the next unused number. Violates "contiguous from 1" (FR-006/SC-003) but preserves user-visible state.
- C: **Fail with a structured error** — return an error telling the caller to clean up the stopped container manually. Conservative; protects against destroying user data.

**Answer**: *Pending*
