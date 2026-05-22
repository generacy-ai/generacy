# Data Model: Phase 1 Multi-Repo Workflow Support

## Modified Types

### ExecutionOptions (workflow-engine)

**File**: `packages/workflow-engine/src/types/execution.ts`

```typescript
export interface ExecutionOptions {
  mode: ExecutionMode;
  env?: Record<string, string>;
  cwd?: string;
  startPhase?: string;
  startStep?: string;
  verbose?: boolean;
  /** Sibling repository working directories (repo name → absolute path).
   *  Injected by the orchestrator from WorkspaceConfig.repos. */
  siblingWorkdirs?: Record<string, string>;  // NEW
}
```

- Optional field. When omitted, executor defaults to `{}`.
- Keys are bare repo names (e.g., `"generacy"`, `"tetrad-development"`).
- Values are absolute filesystem paths (e.g., `"/workspaces/generacy"`).
- Does NOT include the primary repo.

### ActionContext (workflow-engine)

**File**: `packages/workflow-engine/src/types/action.ts`

```typescript
export interface ActionContext {
  workflow: ExecutableWorkflow;
  phase: PhaseDefinition;
  step: StepDefinition;
  inputs: Record<string, unknown>;
  stepOutputs: Map<string, StepOutput>;
  env: Record<string, string>;
  workdir: string;
  /** Sibling repository working directories (repo name → absolute path).
   *  Empty object when running in single-repo mode. */
  siblingWorkdirs: Record<string, string>;  // NEW (non-optional, defaults to {})
  signal: AbortSignal;
  logger: Logger;
  emitEvent?: (event: {
    type: 'log:append' | 'step:output';
    data: Record<string, unknown>;
  }) => void;
}
```

- Non-optional. Always present, defaults to `{}` for backward compatibility.
- Same key-value semantics as `ExecutionOptions.siblingWorkdirs`.
- Read-only from the perspective of action handlers.

### CliSpawnOptions (orchestrator)

**File**: `packages/orchestrator/src/worker/types.ts`

```typescript
export interface CliSpawnOptions {
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  resumeSessionId?: string;
  /** Sibling repository working directories */
  siblingWorkdirs?: Record<string, string>;  // NEW
}
```

## New Functions

### resolveSiblingWorkdirs (config)

**File**: `packages/config/src/repos.ts`

```typescript
/**
 * Resolves sibling working directories from workspace config.
 * Returns a map of repo name → absolute path for all repos
 * except the primary (identified by matching against primaryWorkdir).
 *
 * Returns empty map if:
 * - No repo path matches primaryWorkdir (fail closed)
 * - All sibling paths don't exist on disk
 */
export function resolveSiblingWorkdirs(
  config: WorkspaceConfig,
  primaryWorkdir: string,
  basePath?: string,
): Record<string, string>;
```

**Parameters**:
- `config` — parsed `WorkspaceConfig` with `repos: WorkspaceRepo[]`
- `primaryWorkdir` — absolute path to the primary repo's working directory
- `basePath` — optional override; defaults to `path.dirname(path.resolve(primaryWorkdir))`

**Return**: `Record<string, string>` — repo name → absolute path. Empty if primary can't be identified.

**Behavior**:
1. Resolve `basePath` from `dirname(resolve(primaryWorkdir))` if not provided
2. Normalize `primaryWorkdir` via `realpathSync` (try/catch → `resolve` fallback)
3. For each repo in `config.repos`:
   - Compute candidate path: `getRepoWorkdir(repo.name, basePath)`
   - Normalize via `realpathSync` (try/catch → `resolve` fallback)
   - If normalized path === normalized primaryWorkdir → skip (this is the primary)
   - If path doesn't exist on disk → skip, log info
   - Otherwise → add to result map
4. If no repo was identified as primary → return `{}`, log warning

## Existing Types (Unchanged, Referenced)

### WorkspaceConfig

**File**: `packages/config/src/workspace-schema.ts`

```typescript
export const WorkspaceConfigSchema = z.object({
  org: z.string().min(1),
  branch: z.string().min(1).default('develop'),
  repos: z.array(WorkspaceRepoSchema).min(1),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
```

### WorkspaceRepo

```typescript
export const WorkspaceRepoSchema = z.object({
  name: z.string().min(1),
  monitor: z.boolean().default(true),
});

export type WorkspaceRepo = z.infer<typeof WorkspaceRepoSchema>;
```

## Data Flow

```
.generacy/config.yaml
  ↓  tryLoadWorkspaceConfig()
WorkspaceConfig { repos: [{ name, monitor }] }
  ↓  resolveSiblingWorkdirs(config, checkoutPath)
Record<string, string>  (e.g., { "generacy": "/workspaces/generacy" })
  ↓  orchestrator passes via CliSpawnOptions.siblingWorkdirs
ExecutionOptions.siblingWorkdirs
  ↓  executor caches once in execute()
ActionContext.siblingWorkdirs  (available to every step)
```

## Validation Rules

- `siblingWorkdirs` keys must be non-empty strings (repo names from config)
- `siblingWorkdirs` values must be absolute paths that exist on disk
- Primary repo must NOT appear in the sibling map
- Map is immutable for the duration of a workflow execution
