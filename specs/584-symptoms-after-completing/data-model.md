# Data Model: VS Code Tunnel Lifecycle

## Core Interfaces

### VsCodeTunnelManager (service interface)

```typescript
export type VsCodeTunnelStatus = 'stopped' | 'starting' | 'authorization_pending' | 'connected' | 'error';

export interface VsCodeTunnelStartResult {
  status: VsCodeTunnelStatus;
  tunnelName: string;
}

export interface VsCodeTunnelManager {
  start(): Promise<VsCodeTunnelStartResult>;
  stop(): Promise<void>;
  getStatus(): VsCodeTunnelStatus;
  shutdown(): Promise<void>;
}
```

### VsCodeTunnelManagerOptions (configuration)

```typescript
export interface VsCodeTunnelManagerOptions {
  binPath: string;                    // default: '/usr/local/bin/code'
  tunnelName: string;                 // clusterId — used as --name arg
  forceKillTimeoutMs?: number;        // default: 5000
  deviceCodeTimeoutMs?: number;       // default: 30000
}
```

### Environment-based loading

```typescript
export function loadOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): VsCodeTunnelManagerOptions;
```

| Env Var | Default | Description |
|---------|---------|-------------|
| `VSCODE_CLI_BIN` | `/usr/local/bin/code` | Path to VS Code CLI binary |
| `GENERACY_CLUSTER_ID` | (required) | Used as tunnel name |

## Relay Event Schema

### Channel: `cluster.vscode-tunnel`

```typescript
export interface VsCodeTunnelEvent {
  status: 'starting' | 'authorization_pending' | 'connected' | 'disconnected' | 'error';
  deviceCode?: string;        // present when status === 'authorization_pending'
  verificationUri?: string;   // present when status === 'authorization_pending'
  tunnelName?: string;        // present when status === 'connected'
  error?: string;             // present when status === 'error'
  details?: string;           // raw stdout on parse failure
}
```

### Zod Schema

```typescript
export const VsCodeTunnelEventSchema = z.object({
  status: z.enum(['starting', 'authorization_pending', 'connected', 'disconnected', 'error']),
  deviceCode: z.string().optional(),
  verificationUri: z.string().url().optional(),
  tunnelName: z.string().optional(),
  error: z.string().optional(),
  details: z.string().optional(),
});
```

## Schema Modifications

### LifecycleActionSchema (control-plane/src/schemas.ts)

```typescript
// Before:
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
  'stop',
]);

// After:
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
  'stop',
  'vscode-tunnel-start',
  'vscode-tunnel-stop',
]);
```

## Docker Compose Volume Addition

### Named volume in scaffolder

```typescript
// Added to volumes object:
'vscode-cli': null

// Added to orchestrator service volumes array:
'vscode-cli:/home/node/.vscode-cli'
```

The volume is mounted only on the orchestrator service — workers do not run VS Code tunnels.

## State Machine

```
stopped ──start()──→ starting ──stdout parsed──→ authorization_pending ──auth complete──→ connected
   ↑                    │                              │                                     │
   │                    │                              │                                     │
   └────stop()/exit─────┴──────────stop()/exit─────────┴──────────stop()/exit────────────────┘
                        │
                        └──30s timeout──→ error ──stop()/exit──→ stopped
```

Transitions:
- `stopped → starting`: `start()` called, child process spawned
- `starting → authorization_pending`: device code pattern detected in stdout
- `starting → error`: 30s timeout without device code pattern
- `authorization_pending → connected`: tunnel connection pattern detected in stdout
- `connected → disconnected`: child process exits unexpectedly
- `* → stopped`: `stop()` called or child process exits
