# Implementation Plan: Move SMEE/LabelMonitor/Webhook Config to config.yaml

**Feature**: Move `SMEE_CHANNEL_URL`, `LABEL_MONITOR_ENABLED`, and `WEBHOOK_SETUP_ENABLED` from env vars to `.generacy/config.yaml`
**Branch**: `356-summary-move-smee-channel`
**Status**: Complete

## Summary

Extend the existing `config.yaml` reading pattern (already used for `repos`) to also cover `orchestrator.smeeChannelUrl`, `orchestrator.labelMonitor`, and `orchestrator.webhookSetup`. Environment variables continue to take precedence over config.yaml values for backwards compatibility.

## Technical Context

- **Language**: TypeScript
- **Package manager**: pnpm workspaces
- **Schema validation**: Zod
- **Config parsing**: `yaml` npm package
- **Affected packages**:
  - `packages/config` (`@generacy-ai/config`) — shared config schema + loader
  - `packages/orchestrator` (`@generacy-ai/orchestrator`) — runtime config
  - `packages/generacy` — CLI entry point

## Architecture

### Config.yaml format (template format, on disk)

```yaml
# .generacy/config.yaml
project:
  name: "my-project"
repos:
  primary: "acme/my-app"
  dev:
    - acme/shared-lib
orchestrator:
  labelMonitor: true
  webhookSetup: true
  smeeChannelUrl: "https://smee.io/abc123"
```

### Merge priority (highest → lowest)

1. CLI flags (`--label-monitor`, `--smee-url`, etc.)
2. Environment variables (`LABEL_MONITOR_ENABLED`, `SMEE_CHANNEL_URL`, `WEBHOOK_SETUP_ENABLED`)
3. `config.yaml` `orchestrator` block
4. Schema defaults

## File-by-File Changes

### 1. `packages/config/src/template-schema.ts`

Add optional `orchestrator` block to `TemplateConfigSchema`:

```typescript
export const OrchestratorSettingsSchema = z.object({
  labelMonitor: z.boolean().optional(),
  webhookSetup: z.boolean().optional(),
  smeeChannelUrl: z.string().url().optional(),
});

export const TemplateConfigSchema = z.object({
  project: z.object({ org_name: z.string().optional() }).passthrough().optional(),
  repos: TemplateReposSchema,
  orchestrator: OrchestratorSettingsSchema.optional(),
});

export type OrchestratorSettings = z.infer<typeof OrchestratorSettingsSchema>;
```

### 2. `packages/config/src/loader.ts`

Add `tryLoadOrchestratorSettings(configPath)` that reads and returns the raw `orchestrator` block from `config.yaml`, or `null` if not present:

```typescript
export function tryLoadOrchestratorSettings(configPath: string): OrchestratorSettings | null
```

Parses the YAML, validates against `OrchestratorSettingsSchema`, returns `null` if the file is absent or has no `orchestrator` key.

### 3. `packages/config/src/index.ts`

Export `OrchestratorSettingsSchema`, `OrchestratorSettings`, and `tryLoadOrchestratorSettings`.

### 4. `packages/orchestrator/src/config/schema.ts`

Add `labelMonitor: z.boolean().default(false)` to `OrchestratorConfigSchema`:

```typescript
export const OrchestratorConfigSchema = z.object({
  // ... existing fields ...
  labelMonitor: z.boolean().default(false),
  smee: SmeeConfigSchema.default({}),
  webhookSetup: WebhookSetupConfigSchema.default({}),
});
```

This follows the same pattern as `smee.channelUrl` and `webhookSetup.enabled`.

### 5. `packages/orchestrator/src/config/loader.ts`

In `loadFromEnv()`, add a new section after the existing repo fallback to read `orchestrator.*` from `config.yaml`:

```typescript
// After the repos fallback block (lines ~116-125)
// Fallback: read orchestrator settings from .generacy/config.yaml
const orchSettings = configPath ? tryLoadOrchestratorSettings(configPath) : null;

if (!config.labelMonitor && orchSettings?.labelMonitor !== undefined) {
  config.labelMonitor = orchSettings.labelMonitor;
}
if (orchSettings?.smeeChannelUrl && !smeeChannelUrl) {
  config.smee = { channelUrl: orchSettings.smeeChannelUrl };
}
if (orchSettings?.webhookSetup !== undefined && !process.env['WEBHOOK_SETUP_ENABLED'] && !process.env[`${ENV_PREFIX}WEBHOOK_SETUP_ENABLED`]) {
  config.webhookSetup = { enabled: orchSettings.webhookSetup };
}
```

Note: `configPath` is already computed earlier in the repos fallback. Re-use it.

### 6. `packages/generacy/src/cli/commands/orchestrator.ts`

Replace the manual `labelMonitorEnabled` check (lines 119–122) with reading from `config.labelMonitor`:

```typescript
// Before (reads env var directly, misses config.yaml):
const labelMonitorEnabled =
  options['labelMonitor'] === true ||
  process.env['LABEL_MONITOR_ENABLED'] === 'true';

// After (config is the source of truth, loader already merged all sources):
if (options['labelMonitor'] === true) {
  config.labelMonitor = true;
}
if (config.labelMonitor && config.repositories.length === 0) { ... }
```

## Test Updates

- `packages/config/src/__tests__/template-schema.test.ts` — add tests for `orchestrator` block parsing
- `packages/config/src/__tests__/loader.test.ts` — add tests for `tryLoadOrchestratorSettings`
- `packages/orchestrator/src/config/__tests__/loader-workspace.test.ts` — add tests for config.yaml → labelMonitor/smee/webhookSetup merge, env var override precedence

## Implementation Sequence

1. `packages/config`: schema → loader → index (export)
2. `packages/orchestrator`: schema (`labelMonitor` field) → loader (`tryLoadOrchestratorSettings` call + workspace config merge)
3. `packages/generacy`: CLI command (`labelMonitor` flag handling)
4. Tests for each layer

## Out of Scope

- Cluster-base `.env` cleanup (separate issue; depends on this landing first)
- Adding `defaults.baseBranch` or other config.yaml extensions
