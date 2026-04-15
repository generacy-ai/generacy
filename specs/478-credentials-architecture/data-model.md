# Data Model: Credentials Integration Gap Fix

## Modified Types

### WorkerConfig (extended)

**File**: `packages/orchestrator/src/worker/config.ts`

```typescript
export const WorkerConfigSchema = z.object({
  phaseTimeoutMs: z.number().int().min(60_000).default(600_000),
  workspaceDir: z.string().default('/tmp/orchestrator-workspaces'),
  shutdownGracePeriodMs: z.number().int().min(1000).default(5000),
  validateCommand: z.string().default('pnpm test && pnpm build'),
  preValidateCommand: z.string().default("pnpm install && pnpm -r --filter './packages/*' build"),
  maxImplementRetries: z.number().int().min(0).max(5).default(2),
  gates: z.record(z.string(), z.array(GateDefinitionSchema)).default({...}),
  // NEW FIELD
  credentialRole: z.string().optional(),  // from .generacy/config.yaml defaults.role
});
```

**Validation**: Optional string. When set, the orchestrator expects the credhelper daemon to be running.

### LaunchRequestCredentials (existing, unchanged)

**File**: `packages/credhelper/src/types/launch.ts`

```typescript
export interface LaunchRequestCredentials {
  role: string;    // e.g., "developer", "ci-runner"
  uid: number;     // e.g., 1001 (generacy-workflow)
  gid: number;     // e.g., 1000 (node group)
}
```

### LaunchRequest (existing, unchanged)

**File**: `packages/orchestrator/src/launcher/types.ts`

```typescript
export interface LaunchRequest {
  intent: LaunchIntent;
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  detached?: boolean;
  credentials?: LaunchRequestCredentials;  // Populated when credentialRole is set
}
```

## New Helper Function

### buildLaunchCredentials

**File**: `packages/orchestrator/src/worker/credentials-helper.ts` (new, or inline in a shared location)

```typescript
import type { LaunchRequestCredentials } from '@generacy-ai/credhelper';

const DEFAULT_WORKFLOW_UID = 1001;
const DEFAULT_WORKFLOW_GID = 1000;

export function buildLaunchCredentials(
  credentialRole: string | undefined,
): LaunchRequestCredentials | undefined {
  if (!credentialRole) return undefined;
  return {
    role: credentialRole,
    uid: Number(process.env.GENERACY_WORKFLOW_UID ?? DEFAULT_WORKFLOW_UID),
    gid: Number(process.env.GENERACY_WORKFLOW_GID ?? DEFAULT_WORKFLOW_GID),
  };
}
```

## New Config Loader Function

### tryLoadDefaultsRole

**File**: `packages/config/src/loader.ts`

```typescript
/**
 * Load defaults.role from .generacy/config.yaml.
 * Returns null if not configured.
 */
export function tryLoadDefaultsRole(configPath: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const doc = parseYaml(raw) as Record<string, unknown>;
    const defaults = doc['defaults'] as Record<string, unknown> | undefined;
    const role = defaults?.['role'];
    return typeof role === 'string' ? role : null;
  } catch {
    return null;
  }
}
```

## Environment Variables

| Variable | Default | Source | Purpose |
|----------|---------|--------|---------|
| `GENERACY_CREDHELPER_SOCKET` | `/run/generacy-credhelper/control.sock` | Container env | Credhelper daemon socket path |
| `GENERACY_WORKFLOW_UID` | `1001` | Dockerfile | Uid for isolated workflow processes |
| `GENERACY_WORKFLOW_GID` | `1000` | Dockerfile | Gid for isolated workflow processes |
| `GENERACY_CREDENTIAL_ROLE` | _(none)_ | Container env | Env var override for `defaults.role` |

## Data Flow

```
.generacy/config.yaml
  defaults:
    role: "developer"     ──► tryLoadDefaultsRole() ──► "developer"
                                    │
                                    ▼
                        orchestrator loadFromEnv()
                        worker.credentialRole = "developer"
                                    │
                                    ▼
                            WorkerConfig
                      { credentialRole: "developer" }
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
              CliSpawner    PrFeedbackHandler  ConversationSpawner
                    │               │               │
                    ▼               ▼               ▼
          buildLaunchCredentials("developer")
          → { role: "developer", uid: 1001, gid: 1000 }
                    │               │               │
                    ▼               ▼               ▼
            agentLauncher.launch({ ..., credentials })
                                    │
                                    ▼
                          AgentLauncher.launch()
                          ├─ credentials present?
                          │   ├─ credhelperClient? → applyCredentials()
                          │   └─ no client? → throw CredhelperUnavailableError
                          └─ no credentials → skip interceptor (legacy)
```
