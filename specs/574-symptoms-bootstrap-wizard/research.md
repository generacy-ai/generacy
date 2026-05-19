# Research: Fix cloud-to-cluster /control-plane/* 404s

**Branch**: `574-symptoms-bootstrap-wizard` | **Date**: 2026-05-11

## Request Flow (current vs fixed)

### Current (broken)

```
Cloud → WebSocket → Relay → resolveRoute("/control-plane/credentials/foo", [])
                          → no match → fallback to orchestratorUrl
                          → GET http://127.0.0.1:3100/control-plane/credentials/foo
                          → Fastify 404 (no route)
```

### Fixed

```
Cloud → WebSocket → Relay → resolveRoute("/control-plane/credentials/foo", routes)
                          → match: { prefix: "/control-plane", target: "unix:///run/..." }
                          → strippedPath: "/credentials/foo"
                          → forwardToUnixSocket("/run/generacy-control-plane/control.sock", "PUT", "/credentials/foo", ...)
                          → control-plane handles PUT /credentials/foo → 200
```

## Technology Decisions

### Decision 1: Extend `ClusterRelayClientOptions` vs use raw `RelayConfig`

**Chosen**: Extend `ClusterRelayClientOptions` with `routes?: RouteEntry[]`

**Alternatives considered**:
- **Raw `RelayConfig`**: The orchestrator could construct a full `RelayConfig` object instead of using the convenience `ClusterRelayClientOptions`. Rejected because it would require the orchestrator to know about all config defaults (timeouts, heartbeat intervals, etc.) and couples it to internal config shape.
- **Environment variable**: A `RELAY_ROUTES` env var parsed by the relay itself. Rejected because routes are orchestrator-specific knowledge and should be configured programmatically.

**Rationale**: Adding one optional field is the minimal change. It's additive (non-breaking), the constructor already handles both code paths, and `RelayConfigSchema` already validates and defaults `routes`.

### Decision 2: Route prefix `/control-plane` with prefix stripping

**Chosen**: Use `/control-plane` as the route prefix, relying on the dispatcher's existing prefix-stripping behavior.

**Rationale**: The control-plane process registers routes like `/credentials/:id`, `/roles/:id`, `/state`. The cloud sends requests as `/control-plane/credentials/:id`. The dispatcher strips the prefix, producing the exact paths the control-plane expects. No changes needed on either side.

### Decision 3: Socket target format

**Chosen**: `unix:///run/generacy-control-plane/control.sock`

**Rationale**: The dispatcher's `isUnixSocket()` checks for `unix://` prefix, and `parseUnixTarget()` extracts the path. The control-plane socket path is already resolved in `initializeRelayBridge` from `CONTROL_PLANE_SOCKET_PATH` env var with the same default.

## Existing Infrastructure

### Dispatcher (already works)

`packages/cluster-relay/src/dispatcher.ts` provides:
- `sortRoutes()` — sorts by prefix length descending (longest match wins)
- `resolveRoute()` — finds matching route, returns `{ route, strippedPath }`
- `isUnixSocket()` / `parseUnixTarget()` — unix socket detection and parsing

### Proxy (already works)

`packages/cluster-relay/src/proxy.ts` `handleApiRequest()`:
- Calls `resolveRoute()` on every incoming `api_request`
- Routes to unix socket via `forwardToUnixSocket()` when match is unix
- Falls back to `orchestratorUrl` when no match
- Propagates actor identity headers (`x-generacy-actor-user-id`, `x-generacy-actor-session-id`)

### Config schema (already works)

`RelayConfigSchema` in `config.ts`:
```typescript
routes: z.array(RouteEntrySchema).optional().default([])
```
Accepts undefined, defaults to empty array. No schema changes needed.

## Key Sources

| File | Role |
|------|------|
| `packages/cluster-relay/src/relay.ts:21-35` | `ClusterRelayClientOptions` interface (change target) |
| `packages/cluster-relay/src/relay.ts:75-92` | Constructor dual-path logic |
| `packages/cluster-relay/src/config.ts:3-6` | `RouteEntry` type |
| `packages/cluster-relay/src/dispatcher.ts` | Prefix dispatch + unix socket parsing |
| `packages/cluster-relay/src/proxy.ts:141-169` | Request routing logic |
| `packages/orchestrator/src/server.ts:613-671` | `initializeRelayBridge` (change target) |
