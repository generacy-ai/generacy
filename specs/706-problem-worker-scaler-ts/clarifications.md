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

**Answer**: **A** — Attach to all networks the source replica is on. Inspect via `NetworkSettings.Networks`; create with the first network, `POST /networks/<id>/connect` for the rest before `start`. Compose-label networks aren't part of compose's documented stable contract; the daemon's actual attachment state is the authoritative source. ([source](https://github.com/generacy-ai/generacy/issues/706#issuecomment-4526309027))

---

### Q2: Partial scale-up failure
**Context**: FR-012 says "do not partially scale and leave `cluster.yaml` inconsistent" and "Update `cluster.yaml` only after Engine API operations succeed." But a scale-up of N new replicas can partially succeed (e.g. 3 of 5 created, then `POST /containers/create` returns 409 or the daemon hiccups). The spec does not say whether we should roll back the successful creates or commit the partial result.
**Question**: On partial scale-up failure, what is the desired behaviour?
**Options**:
- A: **Rollback** — destroy (`stop` + `delete`) any replicas successfully created during this call, leave `cluster.yaml` at the previous count, return a structured error. Strictly atomic.
- B: **Commit what succeeded** — leave the created replicas running, write the actual count (e.g. 3 if 3 of 5 succeeded) to `cluster.yaml`, return a structured error indicating the requested vs actual delta. Best-effort.
- C: **Fail-fast, no cleanup** — leave created replicas in place, do not update `cluster.yaml`, return an error. Caller can retry or manually reconcile.

**Answer**: **B** — Commit what succeeded; write the actual count to `cluster.yaml`; return a structured error including both `requested` and `actual`. Strict rollback (A) trades one daemon-failure mode for two — the cleanup itself can fail and leave a worse state. C is the worst of both — running replicas exist but `cluster.yaml` says they don't. With B, the next `scaleWorkers(5)` call against a cluster with 3 simply creates the remaining 2. ([source](https://github.com/generacy-ai/generacy/issues/706#issuecomment-4526309027))

---

### Q3: Counting semantics — include exited replicas?
**Context**: FR-002 enumerates worker containers via `GET /containers/json` filtered by the compose labels. By default this only returns *running* containers; passing `all=true` includes stopped/exited ones. The "current count" used by the gap-fill logic (FR-006) and the scale-up/down comparison (FR-003/FR-004) depends on this choice. A worker that crashed and is in `exited` state still occupies a `container-number` and would collide on name reuse if treated as absent.
**Question**: Should the current-count enumeration include stopped/exited worker containers that carry the project labels?
**Options**:
- A: **Yes, include them** (`all=true`). They occupy a container-number slot; gap-fill must skip those slots; scale-down should arguably remove them first.
- B: **No, running only**. Stopped containers are treated as gaps; gap-fill will reuse their names, requiring `force-remove` before create.
- C: Include them but require an explicit `cleanup` action (out of scope of pure scale) to remove them; warn/log if found.

**Answer**: **A** — Include stopped/exited replicas (`all=true`). Exited workers occupy a container-number slot AND hold the name; treating them as absent (B) guarantees the Q5 name-collision case. Including them gives an honest count and makes gap-fill collision-free in normal operation. **Sub-decision**: on scale-down, prefer to retire exited replicas before stopping healthy running ones — a crashed worker is a stronger signal to retire than an arbitrary high-numbered live one. ([source](https://github.com/generacy-ai/generacy/issues/706#issuecomment-4526309027))

---

### Q4: Concurrent scale requests
**Context**: `PATCH /orgs/{orgId}/clusters/{clusterId}/workers` can be invoked concurrently (two UI tabs, a stale retry, etc.). Two simultaneous scale operations against the Engine API could each enumerate workers, compute a delta, and create overlapping/duplicate replicas — or both write `cluster.yaml` and lose one update. The current implementation does not lock; the spec is silent on whether the new implementation should.
**Question**: Should concurrent scale requests be serialized within `scaleWorkers()`?
**Options**:
- A: **In-process mutex** — single async lock around the whole scale operation. Second concurrent caller waits. Simple, correct for the single-orchestrator topology.
- B: **Reject second caller** — return 409 Conflict (or equivalent structured error) if a scale is already in flight. Surfaces concurrency to the cloud UI.
- C: **No serialization** — accept the race. Argument: cloud UI single-flights from the user's side and the bug is unlikely in practice.

**Answer**: **A** — In-process async mutex around `scaleWorkers()`. Orchestrator is single-process per cluster, so an in-process lock is correct and sufficient. Mutex handles the pathological cases (two tabs, stale retries, network-blip duplicates) gracefully — second caller waits and operates on the post-first state. B (409) is hostile in normal operation; C is unsafe — two simultaneous enumerate-create cycles can produce duplicate `container-number` labels. ([source](https://github.com/generacy-ai/generacy/issues/706#issuecomment-4526309027))

---

### Q5: Container-name collision on gap fill
**Context**: FR-006 says "fill gaps first (ascending), then append." If the gap exists because a previous worker was stopped (not deleted) — e.g. `<project>-worker-2` is in `exited` state — `POST /containers/create?name=<project>-worker-2` will return 409 Conflict. The spec does not say whether to force-remove the dead container or skip that slot.
**Question**: When filling a gap whose container-name is still occupied by a stopped/exited container, what should happen?
**Options**:
- A: **Force-remove then create** — `DELETE /containers/<id>?force=true` on the stopped container, then create the new replica in that slot. Compose-like behaviour.
- B: **Skip the slot, append instead** — leave the stopped container alone, give the new replica the next unused number. Violates "contiguous from 1" (FR-006/SC-003) but preserves user-visible state.
- C: **Fail with a structured error** — return an error telling the caller to clean up the stopped container manually. Conservative; protects against destroying user data.

**Answer**: **A** — Force-remove the stale container (`?force=true`), then create. Given Q3=A, this case effectively never fires in normal operation: exited containers are counted, so gap-fill won't try to claim their names. But if it does (manual user docker ops, edge races), the orchestrator owns these worker containers — removing a stale one to claim its name is the right call. Workers are stateless (workspace volume bind-mounted; container state ephemeral) so there's no user data to destroy. `?force=true` also handles the "actually still running but we thought it was exited" race for free. ([source](https://github.com/generacy-ai/generacy/issues/706#issuecomment-4526309027))
