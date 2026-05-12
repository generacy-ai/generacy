# Data Model: Open IDE Flow Fix (#586)

## Type Changes

### 1. HealthData Interface (cluster-relay)

**File**: `packages/cluster-relay/src/metadata.ts`

```typescript
// Current (line ~28-32)
interface HealthData {
  version: string;
  channel: string;
  uptime: number;
}

// After
interface HealthData {
  version: string;
  channel: string;
  uptime: number;
  codeServerReady: boolean;
}
```

### 2. Health Response Schema (orchestrator)

**File**: `packages/orchestrator/src/types/api.ts`

```typescript
// Current (line ~209-214)
export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  services: z.record(ServiceStatusSchema),
});

// After — add optional codeServerReady field
export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  services: z.record(ServiceStatusSchema),
  codeServerReady: z.boolean().optional(),
});
```

### 3. CodeServerManager Interface Extension

**File**: `packages/control-plane/src/services/code-server-manager.ts`

```typescript
// Current (line ~12-18)
export interface CodeServerManager {
  start(): Promise<CodeServerStartResult>;
  stop(): Promise<void>;
  touch(): void;
  getStatus(): CodeServerStatus;
  shutdown(): Promise<void>;
}

// After — add callback setter
export interface CodeServerManager {
  start(): Promise<CodeServerStartResult>;
  stop(): Promise<void>;
  touch(): void;
  getStatus(): CodeServerStatus;
  shutdown(): Promise<void>;
  onStatusChange(callback: (status: CodeServerStatus) => void): void;
}
```

### 4. Metadata Object (relay-bridge)

**File**: `packages/orchestrator/src/services/relay-bridge.ts`

```typescript
// collectMetadata() return type gains codeServerReady
// Current return shape (~line 493-514):
{
  version: string;
  uptimeSeconds: number;
  activeWorkflowCount: number;
  gitRemotes: string[];
  reportedAt: string;
  workerCount?: number;
  channel?: string;
}

// After:
{
  version: string;
  uptimeSeconds: number;
  activeWorkflowCount: number;
  gitRemotes: string[];
  reportedAt: string;
  workerCount?: number;
  channel?: string;
  codeServerReady: boolean;
}
```

### 5. Cluster Metadata (cluster-relay collectMetadata)

**File**: `packages/cluster-relay/src/metadata.ts`

```typescript
// collectMetadata() return type gains codeServerReady
// Current return shape (~line 9-26):
{
  workerCount: number;
  activeWorkflows: number;
  channel: string;
  orchestratorVersion: string;
  gitRemotes: string[];
  uptime: number;
}

// After:
{
  workerCount: number;
  activeWorkflows: number;
  channel: string;
  orchestratorVersion: string;
  gitRemotes: string[];
  uptime: number;
  codeServerReady: boolean;
}
```

## Relationships

```
Cloud SSE ← Firestore cluster doc ← cluster-registration.ts ← relay metadata
                                                                     ↑
                                            ┌────────────────────────┤
                                            │                        │
                                   cluster-relay/metadata.ts    relay-bridge.ts
                                   (handshake path)             (periodic path)
                                            │                        │
                                   fetchHealth() HTTP          getCodeServerManager()
                                            │                   .getStatus()
                                            ↓                        │
                                   orchestrator /health ←────────────┘
                                            │
                                   CodeServerManager.getStatus()
                                            │
                                   CodeServerProcessManager.status
                                   ('stopped' | 'starting' | 'running')
```

## Validation Rules

- `codeServerReady` is always a boolean (never undefined in metadata)
- In `/health` response it's `z.boolean().optional()` for backward compatibility
- Default to `false` when `getCodeServerManager()` returns a manager with status !== 'running'
- Default to `false` in `fetchHealth()` when field is missing from response (graceful degradation with older orchestrator versions)
