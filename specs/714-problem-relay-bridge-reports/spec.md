# Feature Specification: ## Problem

The relay-bridge reports \`metadata

**Branch**: `714-problem-relay-bridge-reports` | **Date**: 2026-05-24 | **Status**: Draft

## Summary

## Problem

The relay-bridge reports \`metadata.workers\` based on the **declared** value in \`cluster.yaml\` / \`cluster.local.yaml\` rather than the **actual** running worker container count. This makes the cloud UI's \"Workers: N (X busy, Y idle)\" tile inaccurate any time the two values diverge.

Confirmed on a fresh project created via cloud UI → \`npx generacy launch\` (Flow B):

\`\`\`
$ docker ps --filter "label=com.docker.compose.project=microservices-test-1" \\
            --filter "label=com.docker.compose.service=worker" --format '{{.Names}}'
microservices-test-1-worker-1
# 1 worker actually running

$ cat /workspaces/microservices-test-1/.generacy/cluster.yaml
workers: 3
# template default; not what's actually running

# Cloud UI displays: "3 workers (0 busy, 3 idle)"   ❌ should be 1
\`\`\`

Why the divergence:

- Template's \`cluster.yaml\` ships with \`workers: 3\` (cluster-{base,microservices} default).
- The CLI's \`npx generacy launch\` host-side scaffolder writes its own \`.env\` with \`WORKER_COUNT=1\` (a different default — see \`packages/generacy/src/cli/commands/launch/scaffolder.ts:75\`).
- Host's compose uses host's \`.env\` → 1 worker actually runs.
- Orchestrator's relay-bridge reads \`cluster.yaml\` (declared: 3) and reports that as \`metadata.workers\`.

Even ignoring the template-default mismatch (filed separately at [generacy-cloud#694](https://github.com/generacy-ai/generacy-cloud/issues/694)), this divergence will happen any time:

- A worker container crashes (declared still says N, actual is N−1).
- The user manually \`docker stop\`s a worker.
- Future cloud-deployed scaling lands and the orchestrator-managed actual count drifts from the YAML.

The UI is supposed to show the user the *state* of their cluster, not its declared *intent*.

## Root cause

[\`relay-bridge.ts:608-620\`](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/services/relay-bridge.ts#L608-L620):

\`\`\`ts
private async readClusterYaml() {
  const { merged } = await readMergedClusterConfig(generacyDir);
  return {
    workers: typeof merged.workers === 'number' ? merged.workers : undefined,
    ...
  };
}
\`\`\`

The result of this is passed into the metadata payload's \`workers\` field. The cloud's relay-server then writes \`regUpdate.workers = { total: m.workers, busy: 0, idle: m.workers }\` to Firestore.

So the \`total\` displayed in the UI is the declared YAML value all the way through.

## Fix

Enumerate worker containers via the Engine API (the same DockerEngineClient added by [#706](https://github.com/generacy-ai/generacy/issues/706) for worker-scale) and report the actual count. The orchestrator already has Docker socket access on every variant (cluster-base via host socket DooD, cluster-microservices DinD also has the socket).

\`\`\`ts
// In relay-bridge.ts collectMetadata():
const project = await computeProjectName(this.engineClient);  // already exists
const replicas = await enumerateWorkers(this.engineClient, project);  // already exists

const runningCount = replicas.filter(r => r.state === 'running').length;
const exitedCount  = replicas.length - runningCount;

metadata.workers = runningCount;  // truth, not declaration
// Optional: also expose exited for observability
\`\`\`

\`computeProjectName\` and \`enumerateWorkers\` are already exported from \`packages/control-plane/src/services/worker-scaler.ts\` — they can move into the engine-client package or be re-exported. Either way, no new dependencies.

For the cloud-side payload shape, the existing field is \`metadata.workers: number\`, and the relay-server maps it to \`{ total, busy, idle }\`. After the fix:

- \`total\` = actual running container count.
- \`busy\` / \`idle\` — still \`0\` / \`total\` until real per-worker liveness tracking lands (separate concern, not regressed by this issue).

### What about the declared value?

The Cluster Config tab's YAML view shows the declared value already (via \`getClusterConfig\` reading \`.generacy/cluster.yaml\` through the relay). That's the right place for it. The Cluster Metadata tile at the top of the page is for **state**, not **declaration**, and should show actual.

If product wants both surfaced together, the metadata payload could carry \`workers: number\` (actual) plus \`declaredWorkers: number\` (from YAML) — but that's a UI-design call and out of scope for this fix. The immediate bug is \"the tile lies\"; reporting actual is the minimum fix.

## Acceptance

- On a cluster with N running worker containers, \`metadata.workers\` equals N regardless of what \`cluster.yaml\` says.
- Manually stopping a worker (\`docker stop <name>\`) updates the metadata payload on the next refresh; the UI tile drops to N−1 within ~10s.
- After a successful worker-scale operation, the new count matches the new running container count (already the case via the existing \`refresh-metadata\` trigger; this fix just makes the source value honest).

## Related

- [generacy-cloud#694](https://github.com/generacy-ai/generacy-cloud/issues/694) — fixes the template-defaults side (cluster.yaml ships with the user's tier-appropriate value). Both are needed for new Free-tier projects to land in a sensible \"Using 1 of 1 workers\" state out of the box.
- [#706](https://github.com/generacy-ai/generacy/issues/706) — added the Engine API client and \`enumerateWorkers\` helper this fix reuses.

## Clarifications (resolved 2026-05-24)

These decisions are resolved and binding on the implementation. See `clarifications.md` for the full reasoning.

- **C1 — Engine client provisioning**: `RelayBridge` receives a `DockerEngineClient` via `RelayBridgeOptions`. The orchestrator constructs one client at boot in `server.ts` and injects it; `RelayBridge` reuses it across calls.
- **C2 — Helper location**: Move `enumerateWorkers`, `computeProjectName`, and `WorkerReplica` from `packages/control-plane/src/services/worker-scaler.ts` into a new `packages/control-plane/src/services/worker-enumeration.ts`. Keep `worker-scaler.ts` importing from there. Export the helpers from `packages/control-plane/src/index.ts` so orchestrator can import them from `@generacy-ai/control-plane`.
- **C3 — Responsiveness target (~10s)**: Subscribe to Docker Engine events at boot — `GET /events?filters={"label":["com.docker.compose.project=<name>","com.docker.compose.service=worker"],"type":["container"]}` — and call `RelayBridge.sendMetadata()` on `die` / `start` / `destroy` / `create` events. Keep the 60s heartbeat interval (`metadataIntervalMs`) unchanged for the rest of the metadata payload. The event stream must reconnect on close/error (reuse RelayBridge's WebSocket reconnect pattern).
- **C4 — Failure behavior**: If `computeProjectName()` or `enumerateWorkers()` fails (Engine unreachable, `ORCHESTRATOR_NOT_COMPOSE_MANAGED`, transient errors, etc.), **omit** `metadata.workers` from the payload. Do NOT fall back to the YAML-declared value. The cloud UI already handles the absent-field case.

### Implied scope additions

- A new `packages/control-plane/src/services/worker-enumeration.ts` module (extraction; no behavioral change in control-plane).
- A new long-lived Docker Engine event subscription in `RelayBridge` (or a small helper it owns), with reconnect/backoff. Subscribed filter scoped to the current compose project + `service=worker` label.
- `RelayBridgeOptions.engineClient: DockerEngineClient` field added; orchestrator's `server.ts` constructs the client and passes it in.

### Out of scope (deferred)

- Per-worker liveness / `busy` / `idle` tracking — the cloud's `{ total, busy, idle }` mapping continues to set `busy = 0`, `idle = total` until a separate per-worker liveness mechanism lands.
- Surfacing both actual and declared counts side-by-side in the UI — a product/UI decision tracked elsewhere.
- Lowering `metadataIntervalMs` below 60s.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
