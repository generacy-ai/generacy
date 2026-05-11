# Research: Expose `routes` in ClusterRelayClientOptions

**Feature**: #576 | **Date**: 2026-05-11

## Current Architecture

The `ClusterRelay` constructor accepts two shapes via a union type:

1. **`RelayConfig`** (full config) — used when caller has a complete config object. Detected by `'relayUrl' in config`. Routes are manually sorted via `sortRoutes()` on line 79.

2. **`ClusterRelayClientOptions`** (orchestrator API) — a simplified interface that maps field names (e.g. `cloudUrl` -> `relayUrl`) and delegates to `RelayConfigSchema.parse()` for validation and defaults. This path currently does NOT accept or pass `routes`.

The route dispatch chain is fully wired:
- `config.ts`: `RouteEntry` type + `RouteEntrySchema` + `RelayConfigSchema` (routes field with `.optional().default([])`)
- `dispatcher.ts`: `sortRoutes()`, `resolveRoute()` (longest-prefix-match), `isUnixSocket()`, `parseUnixTarget()`
- `proxy.ts`: `handleApiRequest()` calls `resolveRoute()` and dispatches to unix socket or HTTP target

The only gap is at the constructor entry point for `ClusterRelayClientOptions`.

## Design Decision: Sort After Parse

The `RelayConfig` path explicitly sorts routes. The `RelayConfigSchema.parse()` path does not sort. For consistency, the implementation should sort routes after parsing in the `ClusterRelayClientOptions` branch. This is safe because:
- `sortRoutes()` is a pure function that returns a new array
- Empty arrays (the default) are unaffected
- The proxy's `resolveRoute()` does a linear scan, so unsorted routes would still work but wouldn't guarantee longest-prefix-match

## Alternatives Considered

| Alternative | Decision | Rationale |
|-------------|----------|-----------|
| Add sorting inside `RelayConfigSchema` via `.transform()` | Rejected | Would change behavior for all `RelayConfigSchema` consumers (e.g. `loadConfig`). Scope creep. |
| Add a `setRoutes()` method instead of constructor option | Rejected | Routes should be immutable after construction. Constructor injection is the established pattern. |
| Thread routes via env var (e.g. `RELAY_ROUTES_JSON`) | Rejected | Over-engineered for this use case. The orchestrator constructs the relay programmatically. |

## Implementation Pattern

Follows the exact pattern used for `activationCode` and `clusterApiKeyId` — optional fields on `ClusterRelayClientOptions` that pass through to `RelayConfigSchema.parse()`. No new patterns introduced.

## References

- `packages/cluster-relay/src/relay.ts:22-33` — `ClusterRelayClientOptions` interface
- `packages/cluster-relay/src/relay.ts:75-90` — Constructor with dual-path config handling
- `packages/cluster-relay/src/config.ts:8-20` — `RelayConfig` interface (has `routes`)
- `packages/cluster-relay/src/config.ts:27-39` — `RelayConfigSchema` (validates routes)
- `packages/cluster-relay/src/dispatcher.ts:11-13` — `sortRoutes()`
- `packages/cluster-relay/src/proxy.ts:141-195` — `handleApiRequest()` uses routes
- Issue #574 (umbrella) — orchestrator-side wiring (separate issue)
