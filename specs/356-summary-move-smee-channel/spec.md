# Feature Specification: Orchestrator Config from config.yaml

Move `SMEE_CHANNEL_URL`, `LABEL_MONITOR_ENABLED`, and `WEBHOOK_SETUP_ENABLED` from environment variables to `.generacy/config.yaml`.

**Branch**: `356-summary-move-smee-channel` | **Date**: 2026-03-09 | **Status**: Draft

## Summary

Move `SMEE_CHANNEL_URL`, `LABEL_MONITOR_ENABLED`, and `WEBHOOK_SETUP_ENABLED` configuration from environment variables to `.generacy/config.yaml`. This reduces duplication between the `.env` file (Docker Compose) and the config file (orchestrator runtime), keeping `.env` strictly for compose-level concerns.

## Background

The setup scripts in cluster-base now generate both `.generacy/config.yaml` (project config) and `.devcontainer/.env` (Docker Compose variables). Currently, `LABEL_MONITOR_ENABLED`, `WEBHOOK_SETUP_ENABLED`, and `SMEE_CHANNEL_URL` are passed as environment variables even though they're only consumed by the orchestrator at runtime — not by Docker Compose for variable substitution.

The orchestrator already reads `repos` from config.yaml as a fallback (via `tryLoadWorkspaceConfig` → `getMonitoredRepos`). This issue extends that pattern to cover these additional settings.

## Proposed config.yaml additions

```yaml
# .generacy/config.yaml
project:
  name: "my-project"

repos:
  primary: "acme/my-app"
  dev:
    - acme/shared-lib
  clone:
    - acme/docs

orchestrator:
  labelMonitor: true
  webhookSetup: true
  smeeChannelUrl: "https://smee.io/abc123"

defaults:
  baseBranch: main
```

## User Stories

### US1: Simplified orchestrator configuration

**As a** developer setting up a Generacy project,
**I want** orchestrator settings (SMEE channel, label monitor, webhook setup) defined in `config.yaml`,
**So that** I only maintain one config file for orchestrator runtime settings instead of duplicating values across `.env` and `config.yaml`.

**Acceptance Criteria**:
- [ ] Orchestrator reads `labelMonitor`, `webhookSetup`, `smeeChannelUrl` from `orchestrator` block in config.yaml
- [ ] Existing env var overrides still work for Docker/CI environments

### US2: Backwards-compatible migration

**As a** developer with an existing Generacy deployment using env vars,
**I want** my env vars to continue working after this change,
**So that** I can migrate to config.yaml at my own pace without downtime.

**Acceptance Criteria**:
- [ ] Environment variables take precedence over config.yaml values
- [ ] No breaking changes for existing deployments

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Extend `WorkspaceConfigSchema` with optional `orchestrator` block containing `labelMonitor` (boolean), `webhookSetup` (boolean), and `smeeChannelUrl` (string) fields | P1 | In `packages/config/src/` |
| FR-002 | `packages/orchestrator/src/config/loader.ts` reads `orchestrator.*` settings from config.yaml after loading workspace config | P1 | Env vars must still override |
| FR-003 | CLI validation in `packages/generacy/src/cli/commands/orchestrator.ts` checks config.yaml for label monitor / webhook settings, not just env vars | P1 | |
| FR-004 | Environment variables (`SMEE_CHANNEL_URL`, `LABEL_MONITOR_ENABLED`, `WEBHOOK_SETUP_ENABLED`) override config.yaml values when present | P1 | Backwards compatibility |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Orchestrator starts correctly using config.yaml values | Pass | Integration test with config.yaml only (no env vars) |
| SC-002 | Orchestrator starts correctly using env vars only (no orchestrator block in config.yaml) | Pass | Existing behavior preserved |
| SC-003 | Env var overrides config.yaml when both are set | Pass | Unit test in loader.ts |

## Changes Required

### `packages/config/src/`
- Extend `TemplateConfigSchema` (or `WorkspaceConfigSchema`) with optional `orchestrator` block
- Add `orchestrator.labelMonitor`, `orchestrator.webhookSetup`, `orchestrator.smeeChannelUrl` fields

### `packages/orchestrator/src/config/loader.ts`
- After loading workspace config for repos, also read `orchestrator.*` settings from config.yaml
- Environment variables should still take precedence (for Docker/CI overrides)

### `packages/generacy/src/cli/commands/orchestrator.ts`
- Update CLI validation to check config.yaml for label monitor / webhook settings, not just env vars

## Assumptions

- The `orchestrator` block in config.yaml is entirely optional; omitting it falls back to env vars
- `cluster-base` migration to remove these fields from `.env` is a separate follow-up task

## Out of Scope

- Removing `SMEE_CHANNEL_URL`, `LABEL_MONITOR_ENABLED`, `WEBHOOK_SETUP_ENABLED` from `.env` in cluster-base (that's a follow-up)
- Other orchestrator settings not listed in the issue

## References

- [Cluster base migration plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md)
- Current loader: `packages/orchestrator/src/config/loader.ts`
- Config schema: `packages/config/src/workspace-schema.ts`

---

*Generated by speckit*
