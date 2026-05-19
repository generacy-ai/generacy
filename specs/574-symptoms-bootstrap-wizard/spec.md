# Bugfix: Cloud-to-cluster /control-plane/* requests return 404

**Branch**: `574-symptoms-bootstrap-wizard` | **Date**: 2026-05-11 | **Status**: Draft

## Summary

Bootstrap wizard "Install GitHub App" step (Step 1 of 5) fails with `Failed to write credential (404)` after the relay connects to the cloud. The cloud forwards `PUT /control-plane/credentials/${credentialId}` through the relay, but the cluster-side relay falls back to HTTP-proxying to the orchestrator on `http://127.0.0.1:3100`, where Fastify returns 404 because no route handles `/control-plane/*`.

Three independent bugs prevent the control-plane from receiving requests:
1. The control-plane process is never started in the cluster-base entrypoint.
2. `ClusterRelayClientOptions` doesn't expose `routes`, so the orchestrator can't configure path-prefix routing.
3. The orchestrator's `initializeRelayBridge` doesn't register the `/control-plane → unix-socket` route.

## User Stories

### US1: Cluster operator completes bootstrap wizard

**As a** cluster operator running first-time setup,
**I want** the "Install GitHub App" wizard step to successfully write credentials to the cluster,
**So that** I can complete onboarding without manual intervention.

**Acceptance Criteria**:
- [ ] `PUT /control-plane/credentials/<id>` relayed from cloud reaches the control-plane process and returns 200
- [ ] Bootstrap wizard Step 1 completes successfully in the UI

### US2: Relay routes API requests to correct unix socket

**As a** developer integrating new in-cluster services,
**I want** the relay client to accept a `routes` configuration for path-prefix-based dispatching,
**So that** API requests can be routed to services on unix sockets without proxying through the orchestrator.

**Acceptance Criteria**:
- [ ] `ClusterRelayClientOptions` accepts `routes?: RouteEntry[]`
- [ ] Relay dispatches `/control-plane/*` requests to the configured unix socket

## Root Cause Analysis

### Bug 1: Control-plane process never launched

`@generacy-ai/control-plane` listens on `/run/generacy-control-plane/control.sock` and serves `/credentials/:id`, `/roles/:id`, etc. The cluster-base `entrypoint-orchestrator.sh` installs only `@generacy-ai/{generacy,agency,agency-plugin-spec-kit,cluster-relay}` — not `@generacy-ai/control-plane`. No background process is spawned. The tmpfs mount exists in compose but nothing writes a socket there.

**Scope**: cluster-base repo (out of scope for this generacy PR, but documented for coordination).

### Bug 2: Relay client API doesn't expose `routes`

`ClusterRelayClientOptions` accepts `apiKey`, `cloudUrl`, `orchestratorUrl`, `orchestratorApiKey` — but not `routes`. The underlying `RelayConfig` supports `routes: RouteEntry[]`, and the dispatcher already handles unix sockets. There's just no way for the orchestrator to pass routes through.

**Scope**: `packages/cluster-relay/src/relay.ts`

### Bug 3: Orchestrator doesn't register the route

`initializeRelayBridge` in `packages/orchestrator/src/server.ts` constructs the relay client with no route table. Even after fixing the API surface, the orchestrator must pass the `/control-plane → unix` route.

**Scope**: `packages/orchestrator/src/server.ts`

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `routes?: RouteEntry[]` to `ClusterRelayClientOptions` and thread to `RelayConfigSchema.parse` | P1 | `packages/cluster-relay/src/relay.ts` |
| FR-002 | Pass `/control-plane` route to relay client in `initializeRelayBridge` | P1 | `packages/orchestrator/src/server.ts` |
| FR-003 | Install `@generacy-ai/control-plane` in cluster-base entrypoint | P1 | cluster-base repo, companion PR |
| FR-004 | Spawn control-plane daemon before orchestrator in entrypoint | P1 | cluster-base repo, companion PR |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Relay routes `/control-plane/*` to unix socket | 100% of requests dispatched correctly | Unit test: relay client forwards routes to config |
| SC-002 | Orchestrator registers control-plane route | Route present in relay config | Unit test: `initializeRelayBridge` passes route |
| SC-003 | Credential write succeeds end-to-end | 200 response from `PUT /control-plane/credentials/:id` | Integration test with control-plane running |

## Test Plan

- [ ] Unit: `ClusterRelayClientOptions` accepts and forwards `routes`
- [ ] Unit: orchestrator passes `/control-plane → unix:///run/generacy-control-plane/control.sock` to relay client
- [ ] Integration: cluster-base image with control-plane running responds to relay-proxied `PUT /control-plane/credentials/test-id`
- [ ] E2E: `npx generacy launch --claim=<code>` followed by "Install GitHub App" wizard step succeeds

## Assumptions

- The control-plane unix socket path is `/run/generacy-control-plane/control.sock` (already configured in compose tmpfs mount)
- `RelayConfig` and the dispatcher in `proxy.ts` already handle unix socket targets correctly (existing code)
- The cluster-base companion PR (#573 shared-packages mount) is merged

## Out of Scope

- Control-plane process lifecycle changes (cluster-base repo — separate companion PR)
- New control-plane routes or credential logic (already implemented in `packages/control-plane`)
- Relay reconnection or heartbeat changes

## Related

- #572 (consolidation umbrella for cluster-to-cloud contract)
- PR #573 (shared-packages mount fix — prerequisite)

---

*Generated by speckit*
