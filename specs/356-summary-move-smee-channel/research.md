# Research: Move SMEE/LabelMonitor/Webhook Config to config.yaml

## Key Design Decisions

All four design questions were resolved during the clarify phase (see `clarifications.md`). Recorded here for implementation reference.

---

### Decision 1: Schema extension target — `TemplateConfigSchema` vs `WorkspaceConfigSchema`

**Chosen**: Extend `TemplateConfigSchema` (Option A).

**Rationale**: `.generacy/config.yaml` uses the template format (`repos.primary/dev/clone`). The `orchestrator` block is a raw config concern that doesn't need conversion through `convertTemplateConfig` the way repos do. `WorkspaceConfigSchema` stays focused on the normalized, flat `org/branch/repos[]` representation consumed by the rest of the system.

**Implication**: The orchestrator loader reads the `orchestrator` block via `tryLoadOrchestratorSettings`, which parses the raw YAML — not through `tryLoadWorkspaceConfig`. The two reads may open the same file twice, but that's acceptable given file is small and read at startup.

---

### Decision 2: `labelMonitor` field in `OrchestratorConfigSchema`

**Chosen**: Add `labelMonitor: z.boolean().default(false)` to `OrchestratorConfigSchema` (Option A).

**Rationale**: Follows the same pattern as `webhookSetup.enabled`. Makes `labelMonitor` a proper first-class field in the runtime config rather than a side-channel env var check scattered across the codebase. Runtime logic becomes `config.labelMonitor && config.repositories.length > 0`, which is explicit about both intent and valid state.

**Implication**: The inconsistency where the CLI checked `options['labelMonitor'] || LABEL_MONITOR_ENABLED` while the server just checked `repositories.length > 0` is resolved — all paths use `config.labelMonitor`.

---

### Decision 3: API for reading `orchestrator` block

**Chosen**: New exported function `tryLoadOrchestratorSettings(path)` in `@generacy-ai/config` (Option A).

**Rationale**: `@generacy-ai/config` already owns all config.yaml parsing (`tryLoadWorkspaceConfig`, `findWorkspaceConfigPath`, `getMonitoredRepos`). Adding `tryLoadOrchestratorSettings` keeps YAML parsing centralized and follows the established pattern. The orchestrator loader stays clean.

**Alternative considered**: Orchestrator `loader.ts` reads `.generacy/config.yaml` directly for the `orchestrator` block. Rejected because it duplicates YAML parsing logic and bypasses the centralized config layer.

---

### Decision 4: CLI `labelMonitor` validation

**Chosen**: Read from `config.labelMonitor` after `loadConfig()` (Option A, follows from Decision 2).

**Rationale**: Once `labelMonitor` is a real field in `OrchestratorConfigSchema`, the loader already merges config.yaml + env vars into `config.labelMonitor`. The CLI only needs to apply the `--label-monitor` flag on top. No separate config.yaml read needed in the CLI layer.

**Before** (scattered check):
```typescript
const labelMonitorEnabled =
  options['labelMonitor'] === true ||
  process.env['LABEL_MONITOR_ENABLED'] === 'true';
```

**After** (single source of truth):
```typescript
if (options['labelMonitor'] === true) {
  config.labelMonitor = true;  // CLI flag wins
}
if (config.labelMonitor && config.repositories.length === 0) { ... }
```

---

## Backwards Compatibility

All existing deployments using env vars continue to work unchanged:

| Scenario | Before | After |
|----------|--------|-------|
| `SMEE_CHANNEL_URL` set | ✓ | ✓ (env var > config.yaml) |
| `LABEL_MONITOR_ENABLED=true` set | ✓ | ✓ (env var > config.yaml) |
| `WEBHOOK_SETUP_ENABLED=true` set | ✓ | ✓ (env var > config.yaml) |
| config.yaml has `orchestrator.*` | N/A | ✓ (new) |
| Neither env var nor config.yaml | defaults apply | same defaults |

---

## Implementation Pattern Reference

The pattern this feature extends is already established in `packages/orchestrator/src/config/loader.ts` (lines ~116-125):

```typescript
// Existing: fallback to .generacy/config.yaml for repos
const configPath = findWorkspaceConfigPath(process.cwd());
if (configPath) {
  const workspaceConfig = tryLoadWorkspaceConfig(configPath);
  if (workspaceConfig) {
    config.repositories = getMonitoredRepos(workspaceConfig);
  }
}
```

The new `tryLoadOrchestratorSettings` call will reuse the same `configPath` value, keeping it DRY.
