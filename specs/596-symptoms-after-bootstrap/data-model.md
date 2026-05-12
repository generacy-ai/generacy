# Data Model: Fix `codeServerReady` Cross-Process Singleton Bug

**Feature**: #596 | **Date**: 2026-05-12

## Types & Interfaces

### New: `probeCodeServerSocket` function signature

```typescript
// packages/orchestrator/src/services/code-server-probe.ts

/**
 * Probes whether code-server is alive by attempting a unix socket connection.
 * Returns true if the socket accepts a connection within the timeout period.
 */
export async function probeCodeServerSocket(
  socketPath?: string,   // Default: CODE_SERVER_SOCKET_PATH env ?? '/run/generacy-control-plane/code-server.sock'
  timeoutMs?: number,    // Default: 500
): Promise<boolean>;
```

### Modified: `collectMetadata` signature change

```typescript
// packages/orchestrator/src/services/relay-bridge.ts

// Before (sync)
collectMetadata(): ClusterMetadata

// After (async)
async collectMetadata(): Promise<ClusterMetadata>
```

### Modified: `sendMetadata` signature change

```typescript
// packages/orchestrator/src/services/relay-bridge.ts

// Before (sync, void)
sendMetadata(): void

// After (async)
async sendMetadata(): Promise<void>
```

### Existing: `ClusterMetadata` (unchanged)

```typescript
// packages/cluster-relay/src/messages.ts
interface ClusterMetadata {
  // ... existing fields ...
  codeServerReady?: boolean;  // Already optional, no change needed
}
```

### Existing: `/health` response shape (unchanged)

```typescript
// packages/orchestrator/src/types/api.ts
{
  status: 'ok' | 'error';
  services: { server: 'ok' | 'error' };
  codeServerReady: z.boolean().optional();
}
```

## Data Flow

```
code-server process (control-plane)
    └─ binds to unix socket
         └─ /run/generacy-control-plane/code-server.sock

probeCodeServerSocket()
    └─ net.connect(socketPath)
         ├─ connect event → true
         ├─ error event → false
         └─ timeout (500ms) → false

orchestrator /health handler
    └─ await probeCodeServerSocket()
         └─ { codeServerReady: boolean }

relay-bridge collectMetadata()
    └─ await probeCodeServerSocket()
         └─ ClusterMetadata { codeServerReady: boolean }

cluster-relay collectMetadata()
    └─ HTTP GET /health
         └─ reads codeServerReady from response (transitive fix)
```

## Validation Rules

| Field | Type | Constraint | Notes |
|-------|------|-----------|-------|
| `socketPath` | `string` | Valid unix socket path | Env var `CODE_SERVER_SOCKET_PATH` or default |
| `timeoutMs` | `number` | Positive integer, recommended 100-1000 | Prevents `/health` from hanging |
| `codeServerReady` | `boolean` | Always `true` or `false`, never `undefined` | Probe guarantees boolean return |

## Import Changes

### `health.ts`
```diff
- import { getCodeServerManager } from '@generacy-ai/control-plane';
+ import { probeCodeServerSocket } from '../services/code-server-probe.js';
```

### `relay-bridge.ts`
```diff
- import { getCodeServerManager } from '@generacy-ai/control-plane';
+ import { probeCodeServerSocket } from './code-server-probe.js';
```

Note: If `getCodeServerManager` is used elsewhere in these files for other purposes, only remove it from the import if it's no longer referenced. The exploration showed it's used only for `codeServerReady` in both files.
