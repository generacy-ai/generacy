# Feature Specification: ## Problem

`generacy-cloud` ships a UI for scaling worker replicas ("Worker Replicas" with +/- in the Cluster Config tab), wired to `PATCH /orgs/{orgId}/clusters/{clusterId}/workers`

**Branch**: `696-problem-generacy-cloud-ships` | **Date**: 2026-05-22 | **Status**: Draft

## Summary

## Problem

`generacy-cloud` ships a UI for scaling worker replicas ("Worker Replicas" with +/- in the Cluster Config tab), wired to `PATCH /orgs/{orgId}/clusters/{clusterId}/workers`. That endpoint relays to `POST /control-plane/lifecycle/worker-scale` on the orchestrator. **That lifecycle action does not exist here.**

`LifecycleActionSchema` at [packages/control-plane/src/schemas.ts:39-48](https://github.com/generacy-ai/generacy/blob/develop/packages/control-plane/src/schemas.ts#L39-L48) currently allows: `bootstrap-complete`, `clone-peer-repos`, `code-server-start`, `code-server-stop`, `prepare-workspace`, `stop`, `vscode-tunnel-start`, `vscode-tunnel-stop`. No `worker-scale`. The control-plane returns `UNKNOWN_ACTION` → the user sees "Failed to scale workers (400)" in the Cluster Config UI.

This was acknowledged when the cloud side shipped — see [generacy-cloud spec 554](https://github.com/generacy-ai/generacy-cloud/blob/develop/specs/554-context-onboarding-v1-5/spec.md): *"This needs a companion issue on `generacy-ai/generacy` for the control-plane action (`worker-scale` or similar — to be specified there)."* The companion issue was never landed. This is that issue.

## What needs to happen

Add `worker-scale` to `LifecycleActionSchema` and implement the handler in [packages/control-plane/src/routes/lifecycle.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/control-plane/src/routes/lifecycle.ts) so it actually moves the replica count. The orchestrator container has the host docker socket mounted at `/var/run/docker-host.sock` (see scaffolder output) so `docker compose` calls from inside the orchestrator work.

The handler should:

1. Validate `body.count` is an integer ≥ 1. Upper bound is a tier limit and is already enforced by `generacy-cloud` before the request hits the cluster — the cluster shouldn't second-guess it.
2. Resolve the project directory (the dir containing `.generacy/cluster.yaml`) via the existing `project-dir-resolver`.
3. Update `WORKER_COUNT=<n>` in that project's `.env` (the variable docker-compose actually substitutes — see `replicas: \${WORKER_COUNT:-1}` in the compose file the scaffolder writes).
4. Update the `workers` field in `.generacy/cluster.yaml` (see related schema-cleanup work in the cloud companion issue — pick the flat `workers: <number>` shape that the scaffolder already writes).
5. Exec \`docker compose -f <projectDir>/docker-compose.yml up -d --scale worker=<n>\` from inside the orchestrator container.
6. Return `{ accepted: true, action: 'worker-scale', previousCount, requestedCount }` so the cloud-side audit-log entry has the data it expects (see `WorkerScaleResponse` shape in `services/api/src/services/worker-scale.ts` in generacy-cloud).
7. Push a `cluster.status` event via the relay so the new count is reflected in the cloud UI's worker-status panel within ~10 s (the existing SSE flow handles this once the metadata payload changes).

## Drive-by: fix the cluster.yaml field name in the metadata reader

While in the relay-bridge, `readClusterYaml` at [packages/orchestrator/src/services/relay-bridge.ts:608-623](https://github.com/generacy-ai/generacy/blob/develop/packages/orchestrator/src/services/relay-bridge.ts#L608-L623) looks for `parsed?.workerCount` (camelCase). The scaffolder writes `workers: <n>` (flat field name). The cloud-side cluster-config service uses yet another shape (`workers: { count, enabled }`). Standardise on **\`workers: <number>\` flat** — it's what the scaffolder already writes and the simplest representation of "how many replica dev-containers." Rename the field the relay-bridge reads from `workerCount` → `workers`, and update the relay metadata type so the cloud receives \`workers\` not \`workerCount\`.

## Out of scope

- Cloud-deployed (DigitalOcean App Platform) clusters: scaling there needs a provider-side API call, not docker compose. The cloud UI already shows "Worker scaling not yet supported for cloud-deployed clusters" for `deploymentMode === 'cloud'`. Leave it that way for now.
- "Workers Enabled" pause/resume — that's a different concept and isn't wired to anything today. Will be removed in the companion cloud issue.

## Acceptance

- `POST /lifecycle/worker-scale` with `{count: N}` scales the `worker` compose service to N replicas, persists N to both `.env` and `cluster.yaml`, and reports the new count back via the relay status push.
- `LifecycleActionSchema` includes `worker-scale`; existing happy-path lifecycle tests still pass; new test covers the scale action end-to-end with a stubbed docker exec.
- Relay-bridge metadata payload exposes the cluster.yaml worker count as `workers` (flat number), matching the scaffolder's output.

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
