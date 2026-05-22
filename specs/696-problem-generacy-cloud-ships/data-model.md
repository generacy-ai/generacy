# Data Model: Worker Scale Lifecycle Action

## Schemas (Zod)

### WorkerScaleBodySchema (NEW)

```typescript
// packages/control-plane/src/schemas.ts
export const WorkerScaleBodySchema = z.object({
  count: z.number().int().min(1),
});

export type WorkerScaleBody = z.infer<typeof WorkerScaleBodySchema>;
```

### LifecycleActionSchema (MODIFIED)

```typescript
// packages/control-plane/src/schemas.ts (line 39)
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
  'prepare-workspace',
  'stop',
  'vscode-tunnel-start',
  'vscode-tunnel-stop',
  'worker-scale',  // NEW
]);
```

### WorkerScaleResponse

```typescript
// Response shape returned by handler
interface WorkerScaleResponse {
  accepted: true;
  action: 'worker-scale';
  previousCount: number;
  requestedCount: number;
}
```

## Type Modifications

### ClusterMetadataPayload (MODIFIED)

```typescript
// packages/orchestrator/src/types/relay.ts
export interface ClusterMetadataPayload {
  version: string;
  uptimeSeconds: number;
  activeWorkflowCount: number;
  gitRemotes: GitRemoteInfo[];
  workers?: number;                // RENAMED from workerCount
  channel?: 'preview' | 'stable';
  reportedAt: string;
  codeServerReady?: boolean;
  controlPlaneReady?: boolean;
  initResult?: { stores: Record<string, string>; warnings: string[] };
}
```

## File Formats

### .env (WORKER_COUNT line)

```env
# Relevant line in .generacy/.env
WORKER_COUNT=2
```

- Format: `KEY=VALUE` (no quotes, no spaces around `=`)
- Update strategy: regex replace `WORKER_COUNT=\d+` → `WORKER_COUNT=<new>`
- If line missing: append `WORKER_COUNT=<new>\n`

### cluster.yaml (workers field)

```yaml
# .generacy/cluster.yaml
channel: stable
workers: 2
variant: cluster-base
```

- Field: `workers` (flat number, not nested object)
- Update strategy: parse YAML → modify `workers` field → stringify → atomic write

## Service Interface

### WorkerScaler (NEW)

```typescript
// packages/control-plane/src/services/worker-scaler.ts

export interface ScaleResult {
  previousCount: number;
  requestedCount: number;
}

export interface ScaleOptions {
  count: number;
  orchestratorUrl?: string;      // default: http://127.0.0.1:3100
  orchestratorApiKey?: string;   // from ORCHESTRATOR_INTERNAL_API_KEY
}

export async function scaleWorkers(options: ScaleOptions): Promise<ScaleResult>;
```

Internal steps:
1. `resolveGeneracyDir()` → `.generacy/` path
2. `readCurrentCount(generacyDir)` → current WORKER_COUNT from .env
3. `updateEnvFile(generacyDir, count)` → atomic .env update
4. `updateClusterYaml(generacyDir, count)` → atomic yaml update
5. `execDockerScale(generacyDir, count)` → spawn docker compose
6. `triggerMetadataRefresh(orchestratorUrl, apiKey)` → POST /internal/refresh-metadata

### RefreshMetadata Endpoint (NEW)

```typescript
// packages/orchestrator/src/routes/internal-refresh-metadata.ts

export function setupInternalRefreshMetadataRoute(
  server: FastifyInstance,
  getRelayBridge: () => RelayBridge | null,
): void;
```

- Method: `POST /internal/refresh-metadata`
- Auth: Bearer token matching `ORCHESTRATOR_INTERNAL_API_KEY`
- Response 200: `{ accepted: true }`
- Response 503: `{ error: 'relay bridge not yet initialized' }`

## Relay-Bridge Changes

### readClusterYaml (MODIFIED)

```typescript
// Before:
private readClusterYaml(): { workerCount?: number; channel?: string } | null {
  return { workerCount: parsed?.workerCount, ... };
}

// After:
private readClusterYaml(): { workers?: number; channel?: string } | null {
  return { workers: typeof parsed?.workers === 'number' ? parsed.workers : undefined, ... };
}
```

### collectMetadata (MODIFIED)

```typescript
// Before (line 547):
metadata.workerCount = clusterData.workerCount;

// After:
metadata.workers = clusterData.workers;
```

## Relationships

```
Cloud UI (PATCH /workers)
    → generacy-cloud API
    → Relay WebSocket (api_request)
    → Orchestrator proxy (prefix: /control-plane)
    → Control-plane (POST /lifecycle/worker-scale)
        → worker-scaler.ts
            → .env (WORKER_COUNT)
            → cluster.yaml (workers)
            → docker compose --scale
            → POST /internal/refresh-metadata
                → relay-bridge.sendMetadata()
                    → Relay WebSocket (metadata)
                        → Cloud Firestore (project.workers)
                            → SSE → UI update
```
