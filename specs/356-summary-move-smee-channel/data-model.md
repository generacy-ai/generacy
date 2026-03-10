# Data Model: Move SMEE/LabelMonitor/Webhook Config to config.yaml

## New Types

### `OrchestratorSettings` (in `@generacy-ai/config`)

Represents the raw `orchestrator` block in `.generacy/config.yaml`. Lives in `packages/config/src/template-schema.ts`.

```typescript
// packages/config/src/template-schema.ts
export const OrchestratorSettingsSchema = z.object({
  labelMonitor: z.boolean().optional(),
  webhookSetup: z.boolean().optional(),
  smeeChannelUrl: z.string().url().optional(),
});

export type OrchestratorSettings = z.infer<typeof OrchestratorSettingsSchema>;
```

All fields are optional — config.yaml may omit any or all of them.

## Modified Types

### `TemplateConfigSchema` (in `@generacy-ai/config`)

```typescript
// packages/config/src/template-schema.ts — BEFORE
export const TemplateConfigSchema = z.object({
  project: z.object({ org_name: z.string().optional() }).passthrough().optional(),
  repos: TemplateReposSchema,
});

// AFTER — add optional orchestrator block
export const TemplateConfigSchema = z.object({
  project: z.object({ org_name: z.string().optional() }).passthrough().optional(),
  repos: TemplateReposSchema,
  orchestrator: OrchestratorSettingsSchema.optional(),
});
```

### `OrchestratorConfigSchema` (in `@generacy-ai/orchestrator`)

```typescript
// packages/orchestrator/src/config/schema.ts — add labelMonitor field
export const OrchestratorConfigSchema = z.object({
  mode: z.enum(['full', 'worker']).default('full'),
  server: ServerConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  auth: AuthConfigSchema,
  rateLimit: RateLimitConfigSchema.default({}),
  cors: CorsConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  repositories: z.array(RepositoryConfigSchema).default([]),
  monitor: MonitorConfigSchema.default({}),
  prMonitor: PrMonitorConfigSchema.default({}),
  epicMonitor: EpicMonitorConfigSchema.default({}),
  dispatch: DispatchConfigSchema.default({}),
  worker: WorkerConfigSchema.default({}),
  smee: SmeeConfigSchema.default({}),
  webhookSetup: WebhookSetupConfigSchema.default({}),
  labelMonitor: z.boolean().default(false),  // NEW
});
```

## New Function

### `tryLoadOrchestratorSettings` (in `@generacy-ai/config`)

```typescript
// packages/config/src/loader.ts
export function tryLoadOrchestratorSettings(configPath: string): OrchestratorSettings | null
```

**Behavior**:
- Returns `null` if file does not exist
- Returns `null` if file has no `orchestrator` key
- Validates the `orchestrator` block against `OrchestratorSettingsSchema`
- Throws if the `orchestrator` key exists but is invalid (same contract as `tryLoadWorkspaceConfig`)

## Merge Precedence for Orchestrator Settings

| Setting | CLI flag | Env var | config.yaml | Default |
|---------|----------|---------|-------------|---------|
| `labelMonitor` | `--label-monitor` | `LABEL_MONITOR_ENABLED=true` | `orchestrator.labelMonitor` | `false` |
| `smee.channelUrl` | _(none)_ | `SMEE_CHANNEL_URL` | `orchestrator.smeeChannelUrl` | `undefined` |
| `webhookSetup.enabled` | _(none)_ | `WEBHOOK_SETUP_ENABLED=true` | `orchestrator.webhookSetup` | `false` |

Higher entries in the table override lower entries.

## config.yaml Schema (on-disk format)

```yaml
project:
  name: "my-project"      # optional

repos:
  primary: "acme/my-app"  # required
  dev:                     # optional
    - acme/shared-lib
  clone:                   # optional
    - acme/docs

orchestrator:              # optional block (new)
  labelMonitor: true       # boolean, optional
  webhookSetup: true       # boolean, optional
  smeeChannelUrl: "https://smee.io/abc123"  # URL string, optional

defaults:
  baseBranch: main         # not touched by this feature
```

## Validation Rules

- `orchestrator.smeeChannelUrl`: must be a valid URL if present (Zod `z.string().url()`)
- `orchestrator.labelMonitor`: boolean only; no coercion from strings (YAML boolean)
- `orchestrator.webhookSetup`: boolean only; no coercion from strings (YAML boolean)
- Env vars `LABEL_MONITOR_ENABLED` / `WEBHOOK_SETUP_ENABLED` remain string `'true'` comparisons (existing behavior)

## Relationships

```
.generacy/config.yaml
  └─ orchestrator block
       ├─ labelMonitor  ──► OrchestratorConfig.labelMonitor
       ├─ webhookSetup  ──► OrchestratorConfig.webhookSetup.enabled
       └─ smeeChannelUrl ──► OrchestratorConfig.smee.channelUrl
```

Note: the naming is slightly different between config.yaml and `OrchestratorConfig` because `smee` and `webhookSetup` are sub-objects in the runtime config (matching their original env var grouping), while config.yaml uses a flat `orchestrator` block for simplicity.
