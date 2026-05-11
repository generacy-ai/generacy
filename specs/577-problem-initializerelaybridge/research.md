# Research: Register /control-plane Unix-Socket Route on Relay Client

## Technology Decisions

### Decision 1: Use existing `routes` mechanism (no new code paths)

**Rationale**: The cluster-relay package already has a complete prefix-based routing system:
- `dispatcher.ts` — `sortRoutes()`, `resolveRoute()`, `isUnixSocket()`, `parseUnixTarget()`
- `proxy.ts` — `handleApiRequest()` checks `resolveRoute()` first, then falls back to orchestrator URL
- `config.ts` — `RouteEntry` type and `RelayConfig.routes` field

The only gap is that `ClusterRelayClientOptions` (the orchestrator-facing API) doesn't expose `routes`, and `initializeRelayBridge` doesn't pass them. This is a wiring-only fix.

**Alternatives considered**:
1. **Add Fastify route handlers for `/control-plane/*`**: Would proxy inside the orchestrator process. Rejected — adds unnecessary hop; the relay proxy already handles Unix sockets directly.
2. **Environment-variable-based route config**: Parse routes from a JSON env var. Rejected — over-engineered for a single known route; hard-coded route is simpler and the pattern is already established.

### Decision 2: Hard-code the single `/control-plane` route

**Rationale**: There is currently only one non-orchestrator target (the control-plane Unix socket). Adding a config system for routes would be premature. If more routes are needed later, they can be added to the same array literal.

### Decision 3: Use `controlPlaneSocket` variable already in scope

**Rationale**: Line 618 of `server.ts` already resolves the socket path from `CONTROL_PLANE_SOCKET_PATH` env var with a sensible default. Reusing this avoids duplicating the env var lookup.

## Implementation Pattern: Relay Path-Prefix Dispatch

Request flow after fix:

```
Cloud → WebSocket → ClusterRelay.handleApiRequest()
                         │
                    resolveRoute(path, routes)
                         │
              ┌──────────┴──────────┐
              │ match found         │ no match
              │                     │
         isUnixSocket?         forwardToHttp(orchestratorUrl)
              │
    forwardToUnixSocket(socketPath, strippedPath)
              │
    control-plane router.dispatch()
```

Prefix stripping example:
- Incoming: `PUT /control-plane/credentials/github-main-org`
- After strip: `PUT /credentials/github-main-org`
- Control-plane pattern match: `/^\/credentials\/([^/]+)$/` → `id = 'github-main-org'`

## Key Sources

| File | Role |
|------|------|
| `packages/orchestrator/src/server.ts:613-671` | `initializeRelayBridge` — the function to modify |
| `packages/cluster-relay/src/relay.ts:22-33` | `ClusterRelayClientOptions` — needs `routes` from #576 |
| `packages/cluster-relay/src/relay.ts:81-89` | Constructor branch that parses options to `RelayConfig` |
| `packages/cluster-relay/src/dispatcher.ts` | Route matching logic (already complete) |
| `packages/cluster-relay/src/proxy.ts:141-195` | `handleApiRequest` — uses dispatcher, forwards to Unix or HTTP |
| `packages/cluster-relay/src/config.ts:3-6` | `RouteEntry` type definition |
| `packages/control-plane/src/router.ts` | Control-plane route table (already handles all paths) |

## Dependency Analysis

| Dependency | Status | Impact |
|-----------|--------|--------|
| #576 — `ClusterRelayClientOptions` gains `routes` | Must be merged first | TypeScript won't compile without it |
| `cluster-base#24` — control-plane process running | Separate deployment concern | Socket connect will fail at runtime if not running, but relay returns 503 gracefully |
| `@generacy-ai/cluster-relay` package version | Must be updated in orchestrator's deps after #576 | Normal monorepo package update |
