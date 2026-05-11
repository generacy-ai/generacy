# Data Model: Expose `routes` in ClusterRelayClientOptions

**Feature**: #576 | **Date**: 2026-05-11

## Interface Changes

### ClusterRelayClientOptions (MODIFIED)

**File**: `packages/cluster-relay/src/relay.ts:22-33`

```typescript
export interface ClusterRelayClientOptions {
  apiKey: string;
  cloudUrl?: string;
  baseReconnectDelayMs?: number;
  orchestratorUrl?: string;
  orchestratorApiKey?: string;
  routes?: RouteEntry[];  // NEW — optional, defaults to [] via RelayConfigSchema
}
```

### RouteEntry (UNCHANGED — reference only)

**File**: `packages/cluster-relay/src/config.ts:3-6`

```typescript
export interface RouteEntry {
  prefix: string;   // Must start with '/'
  target: string;   // HTTP URL or 'unix://<path>'
}
```

### RelayConfig (UNCHANGED — reference only)

Already contains `routes: RouteEntry[]` (required field, always populated by Zod default).

## Validation Rules

| Field | Type | Required | Default | Validation |
|-------|------|----------|---------|------------|
| `routes` | `RouteEntry[]` | No | `[]` | Each entry validated by `RouteEntrySchema`: prefix must start with `/`, target is any string |

## Data Flow

```
ClusterRelayClientOptions.routes
  → RelayConfigSchema.parse({ ..., routes: opts.routes })
  → sortRoutes(parsed.routes)    // longest-prefix-first ordering
  → this.config.routes           // stored on ClusterRelay instance
  → resolveRoute(path, config.routes)  // used by proxy.ts at request time
```

## Type Re-exports

`RouteEntry` is already exported from `packages/cluster-relay/src/index.ts` via the `config.ts` re-export block. No new exports needed.

The `ClusterRelayClientOptions` type is already re-exported from `index.ts`. The added field will be visible to consumers automatically.
