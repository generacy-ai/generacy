# Data Model: Control-Plane Daemon Crash Resilience

**Feature**: #624 | **Date**: 2026-05-15

## New Types

### StoreStatus (control-plane)

Location: `packages/control-plane/src/types/init-result.ts`

```typescript
/** Status of a store after initialization */
export type StoreStatus = 'ok' | 'fallback' | 'disabled';
```

| Value | Meaning |
|-------|---------|
| `ok` | Initialized on preferred path |
| `fallback` | Preferred path failed, using `/tmp/generacy-app-config/` |
| `disabled` | Both paths failed, store is in no-op mode |

### StoreInitResult (control-plane)

```typescript
export interface StoreInitResult {
  status: StoreStatus;
  /** Filesystem path actually used (undefined when disabled) */
  path?: string;
  /** Human-readable reason when status is 'fallback' or 'disabled' */
  reason?: string;
}
```

### InitResult (control-plane)

```typescript
export interface InitResult {
  stores: {
    appConfigEnv: StoreInitResult;
    appConfigFile: StoreInitResult;
  };
  /** Non-fatal warnings collected during init */
  warnings: string[];
}
```

Serialized to `/run/generacy-control-plane/init-result.json` at daemon boot. Read by orchestrator for relay metadata.

### StoreDisabledError (control-plane)

```typescript
export class StoreDisabledError extends Error {
  readonly code: string;
  readonly reason: string;

  constructor(code: string, reason?: string) {
    super(reason ?? 'Store is disabled');
    this.code = code;
    this.reason = reason ?? 'Store is disabled';
  }
}
```

Thrown by `set()` methods when store is disabled. Mapped to 503 by route handlers.

## Extended Types

### ClusterMetadataPayload (orchestrator)

Location: `packages/orchestrator/src/types/relay.ts`

```typescript
export interface ClusterMetadataPayload {
  // ... existing fields ...
  version: string;
  uptimeSeconds: number;
  activeWorkflowCount: number;
  gitRemotes: GitRemoteInfo[];
  workerCount?: number;
  channel?: 'preview' | 'stable';
  reportedAt: string;
  codeServerReady?: boolean;

  // NEW in #624
  /** Whether the control-plane Unix socket is accepting connections */
  controlPlaneReady?: boolean;
  /** Init results from the control-plane daemon (read from init-result.json) */
  initResult?: {
    stores: Record<string, StoreStatus>;
    warnings: string[];
  };
}
```

### Health Response (orchestrator)

Location: `packages/orchestrator/src/routes/health.ts`

Current shape extended:

```typescript
{
  status: 'ok' | 'degraded' | 'error',
  timestamp: string,
  services: Record<string, 'ok' | 'error'>,
  codeServerReady: boolean,
  // NEW in #624
  controlPlaneReady: boolean,
}
```

### Init Result File Schema

Written to `/run/generacy-control-plane/init-result.json` by the control-plane daemon:

```typescript
const InitResultFileSchema = z.object({
  stores: z.object({
    appConfigEnv: z.object({
      status: z.enum(['ok', 'fallback', 'disabled']),
      path: z.string().optional(),
      reason: z.string().optional(),
    }),
    appConfigFile: z.object({
      status: z.enum(['ok', 'fallback', 'disabled']),
      path: z.string().optional(),
      reason: z.string().optional(),
    }),
  }),
  warnings: z.array(z.string()),
  timestamp: z.string(),
});
```

## Validation Rules

| Field | Rule |
|-------|------|
| `StoreStatus` | Enum: `'ok' \| 'fallback' \| 'disabled'` |
| `StoreInitResult.path` | Present when status is `'ok'` or `'fallback'`; absent when `'disabled'` |
| `StoreInitResult.reason` | Present when status is `'fallback'` or `'disabled'`; absent when `'ok'` |
| `InitResult.warnings` | Array of strings; may be empty |
| `controlPlaneReady` | Boolean; `false` when socket probe fails |

## Store Behavior Matrix

| Store Status | `getAll()` | `set()` | HTTP Response |
|-------------|-----------|---------|---------------|
| `ok` | Normal data | Normal write | 200 |
| `fallback` | Normal data (from tmpfs) | Normal write (to tmpfs) | 200 |
| `disabled` | Empty shape (`[]`) | Throws `StoreDisabledError` | 503 `{ error: 'app-config-store-disabled', reason }` |

## Structured Log Events

Emitted by control-plane daemon entrypoint:

```json
{ "event": "store-init", "store": "appConfigEnv", "status": "ok", "path": "/var/lib/generacy-app-config/env" }
{ "event": "store-init", "store": "appConfigEnv", "status": "fallback", "path": "/tmp/generacy-app-config/env", "reason": "EACCES on /var/lib/generacy-app-config/env" }
{ "event": "store-init", "store": "appConfigEnv", "status": "disabled", "reason": "Both /var/lib/generacy-app-config/env and /tmp/generacy-app-config/env failed: EACCES" }
```

## Relationships

```
AppConfigEnvStore --init()--> StoreInitResult
AppConfigFileStore --init()--> StoreInitResult
control-plane entrypoint --aggregates--> InitResult --writes--> init-result.json
orchestrator relay-bridge --reads--> init-result.json --embeds--> ClusterMetadataPayload
orchestrator health.ts --calls--> probeControlPlaneSocket() --produces--> controlPlaneReady
orchestrator server.ts --on timeout--> relayClient.send(error status) --then--> process.exit(1)
```
