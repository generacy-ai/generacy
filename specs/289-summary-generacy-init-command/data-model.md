# Data Model Changes: Cluster Templates Integration

## Schema Changes

### 1. Template Context Schema (`@generacy-ai/templates`)

**File**: `packages/templates/src/schema.ts`

#### New: `ClusterContextSchema`

```typescript
export const ClusterVariantSchema = z.enum(['standard', 'microservices']);
export type ClusterVariant = z.infer<typeof ClusterVariantSchema>;

export const ClusterContextSchema = z.object({
  /** Cluster variant determining the template set */
  variant: ClusterVariantSchema.default('standard'),
});
export type ClusterContext = z.infer<typeof ClusterContextSchema>;
```

#### Modified: `TemplateContextSchema`

```typescript
// Before
export const TemplateContextSchema = z.object({
  project: ProjectContextSchema,
  repos: ReposContextSchema,
  defaults: DefaultsContextSchema,
  orchestrator: OrchestratorContextSchema,
  devcontainer: DevContainerContextSchema,
  metadata: MetadataContextSchema,
});

// After
export const TemplateContextSchema = z.object({
  project: ProjectContextSchema,
  repos: ReposContextSchema,
  defaults: DefaultsContextSchema,
  orchestrator: OrchestratorContextSchema,
  devcontainer: DevContainerContextSchema,
  metadata: MetadataContextSchema,
  cluster: ClusterContextSchema,  // NEW
});
```

#### Modified: Input Schemas

```typescript
// SingleRepoInputSchema — add optional variant
export const SingleRepoInputSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  primaryRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  baseImage: z.string().optional(),
  releaseStream: z.enum(['stable', 'preview']).optional(),
  baseBranch: z.string().optional(),
  agent: z.string().optional(),
  variant: ClusterVariantSchema.optional(),  // NEW
});

// MultiRepoInputSchema — add optional variant
export const MultiRepoInputSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  primaryRepo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  devRepos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).min(1),
  cloneRepos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).optional(),
  baseImage: z.string().optional(),
  releaseStream: z.enum(['stable', 'preview']).optional(),
  baseBranch: z.string().optional(),
  agent: z.string().optional(),
  workerCount: z.number().int().min(1).max(20).optional(),
  pollIntervalMs: z.number().int().min(5000).optional(),
  variant: ClusterVariantSchema.optional(),  // NEW
});
```

---

### 2. CLI Config Schema (`@generacy-ai/generacy`)

**File**: `packages/generacy/src/config/schema.ts`

#### New: `ClusterConfigSchema`

```typescript
export const ClusterConfigSchema = z.object({
  /** Cluster variant: standard (DooD) or microservices (DinD) */
  variant: z.enum(['standard', 'microservices']).default('standard'),
});

export type ClusterConfig = z.infer<typeof ClusterConfigSchema>;
```

#### Modified: `GeneracyConfigSchema`

```typescript
// Before
export const GeneracyConfigSchema = z.object({
  schemaVersion: z.string().default('1'),
  project: ProjectConfigSchema,
  repos: ReposConfigSchema,
  defaults: DefaultsConfigSchema.optional(),
  orchestrator: OrchestratorSettingsSchema.optional(),
});

// After
export const GeneracyConfigSchema = z.object({
  schemaVersion: z.string().default('1'),
  project: ProjectConfigSchema,
  repos: ReposConfigSchema,
  defaults: DefaultsConfigSchema.optional(),
  orchestrator: OrchestratorSettingsSchema.optional(),
  cluster: ClusterConfigSchema.optional(),  // NEW
});
```

---

### 3. CLI Types (`InitOptions`)

**File**: `packages/generacy/src/cli/commands/init/types.ts`

```typescript
// Before
export interface InitOptions {
  projectId: string;
  projectName: string;
  primaryRepo: string;
  devRepos: string[];
  cloneRepos: string[];
  agent: string;
  baseBranch: string;
  releaseStream: 'stable' | 'preview';
  force: boolean;
  dryRun: boolean;
  skipGithubCheck: boolean;
  yes: boolean;
}

// After
export interface InitOptions {
  projectId: string;
  projectName: string;
  primaryRepo: string;
  devRepos: string[];
  cloneRepos: string[];
  agent: string;
  baseBranch: string;
  releaseStream: 'stable' | 'preview';
  variant: 'standard' | 'microservices';  // NEW
  force: boolean;
  dryRun: boolean;
  skipGithubCheck: boolean;
  yes: boolean;
}
```

---

## Generated File: `.generacy/config.yaml`

### Before (no cluster section)

```yaml
schemaVersion: "1"
project:
  id: proj_locala1b2c3d4
  name: My Project
repos:
  primary: github.com/acme/app
defaults:
  agent: claude-code
  baseBranch: main
```

### After (with cluster section)

```yaml
schemaVersion: "1"
project:
  id: proj_locala1b2c3d4
  name: My Project
repos:
  primary: github.com/acme/app
defaults:
  agent: claude-code
  baseBranch: main
cluster:
  variant: standard
```

---

## Variant Resolution Priority Chain

```
1. CLI flag: --variant <value>           (highest priority)
2. Existing config: .generacy/config.yaml → cluster.variant
3. Interactive prompt: @clack/prompts select
4. Default: "standard"                   (lowest priority)
```

Special case with `--yes`:
- If config has `cluster.variant`: use config value
- If no config: default to `"standard"`
- `--variant` flag always overrides both
