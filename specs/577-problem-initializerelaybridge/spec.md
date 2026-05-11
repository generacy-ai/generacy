# Feature Specification: Register /control-plane Unix-Socket Route on Relay Client

**Branch**: `577-problem-initializerelaybridge` | **Date**: 2026-05-11 | **Status**: Draft

## Summary

The orchestrator's `initializeRelayBridge` constructs a `ClusterRelayClient` with no `routes` configured. Cloud-forwarded requests to `/control-plane/*` (e.g. `PUT /control-plane/credentials/${id}`) fall back to the orchestrator's Fastify server, which has no handler for that path and returns 404. The fix is to register a route entry that forwards `/control-plane/*` to the control-plane's Unix socket.

## Problem

[`initializeRelayBridge`](packages/orchestrator/src/server.ts#L613-L671) constructs a `ClusterRelayClient` with no `routes` configured. Cloud-forwarded `PUT /control-plane/credentials/${id}` reaches the cluster's relay client, finds no matching prefix route, falls back to HTTP-proxying the request to the orchestrator's Fastify on `http://127.0.0.1:3100`, where it 404s (no Fastify route handler for `/control-plane/*`).

The cluster's control-plane is a separate process listening on a unix socket at `/run/generacy-control-plane/control.sock` ([`packages/control-plane/bin/control-plane.ts`](packages/control-plane/bin/control-plane.ts)). The relay client just needs to be told to forward `/control-plane/*` there.

## Fix

In [`packages/orchestrator/src/server.ts`](packages/orchestrator/src/server.ts#L635-L640) `initializeRelayBridge`, pass `routes` to the relay client:

```typescript
const relayClient = new RelayClientImpl({
  apiKey: config.relay.apiKey,
  cloudUrl: config.relay.cloudUrl,
  orchestratorUrl: `http://127.0.0.1:${config.server.port}`,
  orchestratorApiKey: relayInternalKey,
  routes: [
    {
      prefix: '/control-plane',
      target: `unix://${controlPlaneSocket}`,
    },
  ],
});
```

`controlPlaneSocket` is already resolved on line 618 (`process.env['CONTROL_PLANE_SOCKET_PATH'] ?? '/run/generacy-control-plane/control.sock'`).

The cluster-relay's dispatcher strips the matched prefix before forwarding, so a request to `/control-plane/credentials/github-main-org` becomes a unix-socket request for `/credentials/github-main-org` — which matches the control-plane router's existing pattern `/^\/credentials\/([^/]+)$/` ([`packages/control-plane/src/router.ts:33-37`](packages/control-plane/src/router.ts#L33-L37)).

## User Stories

### US1: Cloud credential writes reach the control-plane

**As a** cloud dashboard user configuring cluster credentials,
**I want** `PUT /control-plane/credentials/:id` requests relayed from the cloud to reach the in-cluster control-plane process,
**So that** credentials are persisted to the cluster's encrypted credential store.

**Acceptance Criteria**:
- [ ] Relay client is constructed with a `/control-plane` route pointing to `unix:///run/generacy-control-plane/control.sock`
- [ ] Cloud-forwarded requests to `/control-plane/credentials/:id` are dispatched to the control-plane (not Fastify)
- [ ] The relay dispatcher strips the `/control-plane` prefix before forwarding to the unix socket

### US2: Cloud lifecycle and state requests reach the control-plane

**As a** cloud service orchestrating cluster lifecycle,
**I want** all `/control-plane/*` API requests (state, lifecycle, credentials, roles) to route to the control-plane process,
**So that** the cloud can manage cluster state, trigger lifecycle actions, and read cluster status.

**Acceptance Criteria**:
- [ ] `GET /control-plane/state` reaches the control-plane's `/state` handler
- [ ] `POST /control-plane/lifecycle/:action` reaches the control-plane's `/lifecycle/:action` handler
- [ ] Requests not matching `/control-plane` prefix still fall back to orchestrator Fastify as before

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Pass `routes` array with `/control-plane` prefix to `RelayClientImpl` constructor | P1 | Single route entry targeting unix socket |
| FR-002 | Route target must use `unix://` scheme with `controlPlaneSocket` variable | P1 | Already resolved from env/default |
| FR-003 | Non-`/control-plane` requests must continue to fall back to orchestrator HTTP | P1 | Existing behavior preserved |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Relay client `routes` config | Contains `{ prefix: '/control-plane', target: 'unix:///run/generacy-control-plane/control.sock' }` | Unit test assertion on constructor args |
| SC-002 | Cloud credential PUT | Returns 200 from control-plane (not 404) | Integration test with relay + control-plane |

## Dependencies

Blocked by:
- #576 (`ClusterRelayClientOptions` must accept `routes` first)
- generacy-ai/cluster-base#24 (control-plane process must actually be running at the target socket)

## Test Plan

- [ ] Unit test in `packages/orchestrator/src/__tests__/`: assert the relay client is constructed with the `/control-plane` route
- [ ] Integration: with control-plane running on a unix socket and #576 merged, a relay-forwarded request to `/control-plane/credentials/test` reaches the control-plane handler (not Fastify)

## Assumptions

- `controlPlaneSocket` is already resolved in `initializeRelayBridge` (line 618)
- The cluster-relay dispatcher already supports `routes` and prefix stripping (from `packages/cluster-relay/src/dispatcher.ts`)
- The control-plane router already handles `/credentials/:id`, `/state`, `/lifecycle/:action` paths

## Out of Scope

- Adding new control-plane route handlers (already exist)
- Modifying the relay dispatcher logic (already supports prefix routes)
- Changes to `ClusterRelayClientOptions` type (handled by #576)

## Related

- #574 (umbrella)
- #576 (relay client options must accept routes)

---

*Generated by speckit*
