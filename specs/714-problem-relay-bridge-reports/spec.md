# Feature Specification: Report Actual Running Worker Count in Relay Metadata

**Branch**: `714-problem-relay-bridge-reports` | **Date**: 2026-05-24 | **Status**: Draft
**Issue**: [#714](https://github.com/generacy-ai/generacy/issues/714)

## Summary

The orchestrator's relay-bridge currently reports `metadata.workers` based on the **declared** value in `cluster.yaml` / `cluster.local.yaml` rather than the **actual** running worker container count. The cloud UI's "Workers: N (X busy, Y idle)" tile therefore lies whenever the declared and actual counts diverge — which happens on every Flow B launch (template ships `workers: 3`, CLI scaffolder writes `WORKER_COUNT=1`), on any worker crash, and on any manual `docker stop`.

Fix: enumerate worker containers via the Engine API (reusing `computeProjectName` and `enumerateWorkers` from `worker-scaler.ts`, added in [#706](https://github.com/generacy-ai/generacy/issues/706)) inside `relay-bridge.ts`'s `collectMetadata()` and report the count of `state === 'running'` replicas as `metadata.workers`.

## Problem

[`packages/orchestrator/src/services/relay-bridge.ts:608-620`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/services/relay-bridge.ts#L608-L620) reads `merged.workers` from `readMergedClusterConfig(generacyDir)` and forwards it as `metadata.workers`. The cloud's relay-server maps it to `regUpdate.workers = { total: m.workers, busy: 0, idle: m.workers }` in Firestore, so the UI tile's `total` is the declared YAML value all the way through.

**Reproduction** (Flow B project):

```
$ docker ps --filter "label=com.docker.compose.project=microservices-test-1" \
            --filter "label=com.docker.compose.service=worker" --format '{{.Names}}'
microservices-test-1-worker-1
# 1 worker actually running

$ cat /workspaces/microservices-test-1/.generacy/cluster.yaml
workers: 3

# Cloud UI displays: "3 workers (0 busy, 3 idle)"   ❌ should be 1
```

**Divergence sources**:
- Template default: `cluster.yaml` ships with `workers: 3` (cluster-{base,microservices}).
- CLI scaffolder default: `packages/generacy/src/cli/commands/launch/scaffolder.ts:75` writes `WORKER_COUNT=1` in `.env`.
- Crash: worker container exits, declared still says N.
- Manual ops: `docker stop` on a worker.
- Future cloud-deployed scaling drift.

The Cluster Metadata tile is meant to show cluster **state**, not declared **intent**. The Cluster Config tab already surfaces the declared YAML value via `getClusterConfig`.

## User Stories

### US1: Accurate Worker Count in Cloud UI

**As a** Generacy user viewing the Cluster Metadata tile in the cloud UI,
**I want** the "Workers" count to reflect how many worker containers are actually running,
**So that** I can tell at a glance whether my cluster is healthy and how much capacity it actually has.

**Acceptance Criteria**:
- [ ] On a cluster with N running worker containers, the tile shows N regardless of what `cluster.yaml` declares.
- [ ] After `docker stop`ing a worker, the tile reflects the lower count within ~10s (next metadata refresh).
- [ ] After a successful worker-scale operation, the count matches the new running container count.

### US2: Honest Telemetry for Debugging

**As a** developer or operator debugging a cluster,
**I want** `metadata.workers` in relay messages to mean "actual" not "declared",
**So that** I can correlate the UI state with what the host's Docker engine actually reports without having to know which value lies.

**Acceptance Criteria**:
- [ ] `metadata.workers` field in relay handshake/heartbeat payloads matches `docker ps --filter "label=com.docker.compose.service=worker" --filter "status=running"` count.
- [ ] When the Engine API call fails, the field is `undefined` (omitted) rather than a stale or fabricated number.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `collectMetadata()` in `relay-bridge.ts` enumerates worker containers via `enumerateWorkers(engineClient, project)` and reports the count of replicas with `state === 'running'` as `metadata.workers`. | P0 | Replaces current `readClusterYaml().workers` source for this field. |
| FR-002 | `metadata.workers` reflects actual running count on every metadata emission path (initial handshake, periodic heartbeat, `refresh-metadata` trigger, post code-server status change). | P0 | All callers of `collectMetadata()` / `sendMetadata()` benefit transparently. |
| FR-003 | On Engine API failure (Docker unreachable, network error, etc.), `metadata.workers` is omitted from the payload rather than set to a stale or zero value. | P1 | Match existing `controlPlaneReady` / `codeServerReady` failure semantics: graceful undefined. |
| FR-004 | `computeProjectName` and `enumerateWorkers` are accessible to `relay-bridge.ts` without circular dependency from `@generacy-ai/orchestrator` → `@generacy-ai/control-plane`. | P0 | Either move helpers into the engine-client package or re-export from a shared location. |
| FR-005 | The relay-bridge's existing `engineClient` instance (already used by other metadata paths) is reused for the worker enumeration — no new Docker socket connection. | P1 | Avoid resource churn. |
| FR-006 | The declared YAML `workers` value remains available to the cloud UI through the existing `getClusterConfig` relay endpoint reading `.generacy/cluster.yaml`. | P0 | No regression in Cluster Config tab. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Tile accuracy on fresh Flow B project (`workers: 3` declared, `WORKER_COUNT=1` in `.env`) | Tile shows `1`, not `3` | Manual verification in cloud UI after `npx generacy launch` |
| SC-002 | Tile responsiveness to manual stop | Tile drops from N to N−1 within 10s of `docker stop <worker>` | Manual verification; relay metadata heartbeat interval |
| SC-003 | Post-scale accuracy | After scaling 1→3 via worker-scaler, tile shows `3` | Existing `refresh-metadata` trigger after scale; verify in UI |
| SC-004 | No regression in declared-value surface | Cluster Config tab still shows `workers: 3` when YAML says so | Manual verification |
| SC-005 | Engine API failure handling | When Docker socket unreachable, payload contains no `workers` field rather than a wrong number | Inject failure (e.g. wrong socket path); inspect emitted payload |

## Assumptions

- The orchestrator process has Docker socket access on all supported variants (confirmed: cluster-base uses host-socket DooD, cluster-microservices DinD also exposes the socket).
- The compose project name resolution via `computeProjectName(engineClient)` returns the correct project for both Flow A and Flow B clusters (already battle-tested by #706's worker-scaler).
- The `worker` service label (`com.docker.compose.service=worker`) is stable across cluster-base and cluster-microservices variants.
- Cloud-side payload shape `metadata.workers: number` is unchanged — only the source of the value changes. Cloud relay-server's `regUpdate.workers = { total: m.workers, busy: 0, idle: m.workers }` mapping stays intact.

## Out of Scope

- **Per-worker liveness tracking** (real `busy` / `idle` split). Cloud still receives `busy: 0, idle: total` until a separate effort lands.
- **Exposing both declared and actual values** in the same metadata payload (e.g. `workers` + `declaredWorkers`). UI-design call deferred; this fix is the minimum truthful payload.
- **Template default mismatch** (`cluster.yaml` ships with `workers: 3` vs CLI's `WORKER_COUNT=1`). Tracked at [generacy-cloud#694](https://github.com/generacy-ai/generacy-cloud/issues/694).
- **Exited / failed worker count as a separate field** (`exitedWorkers`). The fix snippet mentions this as optional observability; not in scope unless cloud UI asks for it.

## Related

- [#706](https://github.com/generacy-ai/generacy/issues/706) — added the `DockerEngineClient`, `computeProjectName`, and `enumerateWorkers` helpers this fix reuses.
- [generacy-cloud#694](https://github.com/generacy-ai/generacy-cloud/issues/694) — fixes the template-defaults side so new Free-tier projects ship with `workers: 1`.

---

*Generated by speckit*
