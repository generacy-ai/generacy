# Clarifications for #356: Orchestrator Config from config.yaml

## Batch 1 — 2026-03-09

### Q1: Schema extension target
**Context**: The spec says "Extend `TemplateConfigSchema` (or `WorkspaceConfigSchema`)" but these serve different roles. `TemplateConfigSchema` (in `packages/config/src/template-schema.ts`) is the raw `.generacy/config.yaml` format with `repos.primary/dev/clone` and `project.org_name`. `WorkspaceConfigSchema` is the normalized internal representation with flat `org/branch/repos[]`. Adding the `orchestrator` block to `TemplateConfigSchema` matches the actual config.yaml file format used on disk.
**Question**: Should the `orchestrator` block be added to `TemplateConfigSchema` (the raw config.yaml format) rather than `WorkspaceConfigSchema`?
**Options**:
- A: Extend `TemplateConfigSchema` — matches the on-disk format; orchestrator loader reads the raw YAML directly
- B: Extend `WorkspaceConfigSchema` — normalized shape; requires `convertTemplateConfig` to carry orchestrator settings through

**Answer**: **A** — Extend `TemplateConfigSchema`. The on-disk `.generacy/config.yaml` uses template format (`repos.primary/dev/clone`). The `orchestrator` block is a raw config concern that doesn't need conversion like repos do. Adding it to `TemplateConfigSchema` matches what's actually on disk, and the loader can extract it directly without routing through `convertTemplateConfig`. `WorkspaceConfigSchema` stays focused on the normalized repo representation.

---

### Q2: labelMonitor field in OrchestratorConfig
**Context**: `OrchestratorConfigSchema` (in `packages/orchestrator/src/config/schema.ts`) has `smee.channelUrl` and `webhookSetup.enabled` but no `labelMonitor` field. Label monitoring is currently inferred from `config.repositories.length > 0`. The spec proposes `orchestrator.labelMonitor: true` in config.yaml, but there is nowhere to store it in `OrchestratorConfig`.
**Question**: Should `OrchestratorConfigSchema` gain a new top-level (or nested) `labelMonitor: boolean` field, or should the config.yaml `orchestrator.labelMonitor` only be used for CLI validation (not stored in the runtime config)?
**Options**:
- A: Add `labelMonitor: z.boolean().default(false)` to `OrchestratorConfigSchema` and use it as an explicit on/off switch
- B: Keep label monitoring implicit (enabled iff `repositories.length > 0`); use `orchestrator.labelMonitor` from config.yaml only in CLI pre-flight validation, not in the runtime config schema

**Answer**: **A** — Add `labelMonitor: z.boolean().default(false)` to `OrchestratorConfigSchema`. This follows the same pattern as `webhookSetup.enabled` and `smee.channelUrl`. The loader merges all sources (config.yaml → env var → CLI flag) into `config.labelMonitor`, and runtime logic becomes `config.labelMonitor && config.repositories.length > 0` (explicit intent + valid state). Unifies the currently inconsistent approach where the CLI checks a separate flag/env var while runtime just checks repo count.

---

### Q3: API for reading orchestrator settings from config.yaml
**Context**: The orchestrator's `loader.ts` currently calls `tryLoadWorkspaceConfig(configPath)` which returns `WorkspaceConfig | null` (only has `org/branch/repos`). If `TemplateConfigSchema` is extended with an `orchestrator` block, the orchestrator loader needs a way to access those settings without a separate YAML parse.
**Question**: Should `@generacy-ai/config` export a new function (e.g. `tryLoadOrchestratorSettings(path)`) that returns the raw `orchestrator` block, or should the orchestrator's own `loader.ts` call `findWorkspaceConfigPath` + raw YAML parse to read the `orchestrator` block independently?
**Options**:
- A: New exported function in `@generacy-ai/config` (e.g. `tryLoadOrchestratorSettings`) — keeps config parsing centralised
- B: Orchestrator's `loader.ts` reads `.generacy/config.yaml` directly for the `orchestrator` block (similar to the current repos fallback but extended) — simpler, no new public API

**Answer**: **A** — New exported function in `@generacy-ai/config` (e.g. `tryLoadOrchestratorSettings(path)`). The config package already owns `tryLoadWorkspaceConfig`, `findWorkspaceConfigPath`, `getMonitoredRepos` — this follows the same pattern, keeps YAML parsing centralized, and keeps the orchestrator loader clean.

---

### Q4: CLI labelMonitor validation after config.yaml support
**Context**: The CLI command (`packages/generacy/src/cli/commands/orchestrator.ts`, lines 119–129) currently checks `options['labelMonitor'] === true || process.env['LABEL_MONITOR_ENABLED'] === 'true'`. After this change, when `LABEL_MONITOR_ENABLED` is absent but `orchestrator.labelMonitor: true` is in config.yaml, the existing CLI check won't catch it. The spec says FR-003: "CLI validation checks config.yaml for label monitor settings, not just env vars."
**Question**: Should the CLI validation read `labelMonitor` from the loaded `OrchestratorConfig` object (post-`loadConfig()`) — implying `OrchestratorConfig` gains a `labelMonitor` field (see Q2-A) — or should the CLI call a config.yaml read directly before starting the server?
**Options**:
- A: Read from `config.labelMonitor` (requires Q2-A: new field in OrchestratorConfigSchema) — one source of truth
- B: CLI calls `tryLoadOrchestratorSettings` / reads config.yaml directly for label monitor check, then passes the combined result to the server

**Answer**: **A** — Read from `config.labelMonitor`. Follows directly from Q2-A. Once `labelMonitor` is a real field in `OrchestratorConfigSchema`, the loader merges config.yaml + env vars + CLI flags into `config.labelMonitor`. CLI validation checks `config.labelMonitor && config.repositories.length === 0` → error. No separate config.yaml read needed — one source of truth.
