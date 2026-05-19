# Data Model: Fix cloud-to-cluster /control-plane/* 404s

**Branch**: `574-symptoms-bootstrap-wizard` | **Date**: 2026-05-11

## Modified Types

### `ClusterRelayClientOptions` (cluster-relay)

```typescript
// packages/cluster-relay/src/relay.ts
export interface ClusterRelayClientOptions {
  apiKey: string;
  cloudUrl?: string;
  baseReconnectDelayMs?: number;
  orchestratorUrl?: string;
  orchestratorApiKey?: string;
  routes?: RouteEntry[];           // NEW — optional, defaults to []
}
```

**Validation**: Validated by `RelayConfigSchema` which applies `z.array(RouteEntrySchema).optional().default([])`.

### `RouteEntry` (existing, unchanged)

```typescript
// packages/cluster-relay/src/config.ts
export interface RouteEntry {
  prefix: string;   // e.g. "/control-plane"
  target: string;   // e.g. "unix:///run/generacy-control-plane/control.sock"
}
```

**Validation**: `RouteEntrySchema = z.object({ prefix: z.string(), target: z.string() })`

## Route Configuration (runtime)

The orchestrator registers exactly one route at startup:

| prefix | target | Effect |
|--------|--------|--------|
| `/control-plane` | `unix:///run/generacy-control-plane/control.sock` | Strips prefix, forwards to control-plane |

### Path transformation examples

| Incoming path | Stripped path | Handler |
|--------------|---------------|---------|
| `PUT /control-plane/credentials/gh-app` | `PUT /credentials/gh-app` | control-plane `handlePutCredential` |
| `GET /control-plane/state` | `GET /state` | control-plane `handleGetState` |
| `POST /control-plane/lifecycle/bootstrap-complete` | `POST /lifecycle/bootstrap-complete` | control-plane `handleLifecycleAction` |
| `GET /health` | (no match) | orchestrator fallback |
| `POST /conversations` | (no match) | orchestrator fallback |

## Relationships

```
ClusterRelayClientOptions
  └── routes?: RouteEntry[]
        │
        ▼
  RelayConfig.routes: RouteEntry[]  (via RelayConfigSchema.parse)
        │
        ▼
  handleApiRequest() → resolveRoute() → dispatcher
        │                                    │
        ├── match + unix → forwardToUnixSocket()
        ├── match + http → forwardToHttp()
        └── no match     → orchestratorUrl fallback
```

## No New Types

This fix introduces no new types, schemas, or data structures. It adds one optional field to an existing interface and wires an existing configuration mechanism.
