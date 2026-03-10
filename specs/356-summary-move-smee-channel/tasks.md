# Tasks: Move SMEE/LabelMonitor/Webhook Config to config.yaml

**Input**: Design documents from `/specs/356-summary-move-smee-channel/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, research.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Config Package — Schema & Loader

- [X] T001 Add `OrchestratorSettingsSchema` and extend `TemplateConfigSchema` in `packages/config/src/template-schema.ts`
  - Add `OrchestratorSettingsSchema` with optional `labelMonitor`, `webhookSetup`, `smeeChannelUrl` fields
  - Add `orchestrator: OrchestratorSettingsSchema.optional()` to `TemplateConfigSchema`
  - Export `OrchestratorSettings` type
- [X] T002 Add `tryLoadOrchestratorSettings(configPath)` to `packages/config/src/loader.ts`
  - Reads and validates the `orchestrator` block from config.yaml
  - Returns `null` if file absent or has no `orchestrator` key
  - Throws if `orchestrator` key exists but is invalid (same contract as `tryLoadWorkspaceConfig`)
- [X] T003 Export `OrchestratorSettingsSchema`, `OrchestratorSettings`, and `tryLoadOrchestratorSettings` from `packages/config/src/index.ts`

## Phase 2: Orchestrator Package

- [X] T004 [P] Add `labelMonitor: z.boolean().default(false)` to `OrchestratorConfigSchema` in `packages/orchestrator/src/config/schema.ts`
  - Insert after `webhookSetup` field, following the established pattern
- [X] T005 Update `loadFromEnv()` in `packages/orchestrator/src/config/loader.ts` to read and merge `orchestrator.*` from config.yaml
  - Reuse existing `configPath` variable from the repos fallback block
  - Call `tryLoadOrchestratorSettings(configPath)` after the repos fallback
  - Merge: `labelMonitor`, `smeeChannelUrl` → `smee.channelUrl`, `webhookSetup` → `webhookSetup.enabled`
  - Env vars/CLI flags take precedence over config.yaml values

## Phase 3: CLI Update

- [X] T006 Update `packages/generacy/src/cli/commands/orchestrator.ts` to use `config.labelMonitor` as single source of truth
  - Remove manual `labelMonitorEnabled` check that reads `LABEL_MONITOR_ENABLED` directly
  - Apply `--label-monitor` CLI flag onto `config.labelMonitor` after `loadConfig()` returns
  - Change pre-flight validation to `config.labelMonitor && config.repositories.length === 0`

## Phase 4: Tests

- [X] T007 [P] Add tests for `orchestrator` block parsing in `packages/config/src/__tests__/template-schema.test.ts`
  - Valid block with all three fields
  - Valid block with partial fields (each field independently optional)
  - Invalid `smeeChannelUrl` (non-URL string) → validation error
  - Missing `orchestrator` key → parses without error
- [X] T008 [P] Add tests for `tryLoadOrchestratorSettings` in `packages/config/src/__tests__/loader.test.ts`
  - Returns `null` when file does not exist
  - Returns `null` when file has no `orchestrator` key
  - Returns parsed settings when `orchestrator` block is present
  - Throws when `orchestrator` block fails validation
- [X] T009 Add merge precedence tests in `packages/orchestrator/src/config/__tests__/loader-workspace.test.ts`
  - config.yaml `orchestrator.labelMonitor` → `config.labelMonitor`
  - config.yaml `orchestrator.smeeChannelUrl` → `config.smee.channelUrl`
  - config.yaml `orchestrator.webhookSetup` → `config.webhookSetup.enabled`
  - Env var `LABEL_MONITOR_ENABLED=true` overrides config.yaml `labelMonitor: false`
  - Env var `SMEE_CHANNEL_URL` overrides config.yaml `smeeChannelUrl`
  - Env var `WEBHOOK_SETUP_ENABLED=true` overrides config.yaml `webhookSetup: false`

## Dependencies & Execution Order

**Sequential chain**:
- T001 → T002 → T003 (config package: schema before loader before exports)
- T003 → T005 (orchestrator loader needs exported `tryLoadOrchestratorSettings`)
- T004 → T005 (orchestrator loader needs `labelMonitor` field in schema)
- T005 → T006 (CLI needs `config.labelMonitor` to exist in runtime config)
- T005 → T009 (orchestrator merge tests need loader changes)

**Parallel opportunities**:
- T004 can run in parallel with Phase 1 (T001–T003) — different package, no shared dependencies
- T007 and T008 can run in parallel after T001/T002 respectively
- T007 and T008 can run in parallel with each other and with T009
