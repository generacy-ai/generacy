# Feature Specification: Remove hardcoded tetrad-development bootstrap fallback

Remove the hardcoded `tetrad-development` bootstrap fallback from `generacy setup workspace` so external projects can use their own `.generacy/config.yaml`.

**Branch**: `333-problem-generacy-setup` | **Date**: 2026-03-06 | **Status**: Draft

## Problem

`generacy setup workspace` has a hardcoded bootstrap fallback that assumes `tetrad-development` is always the config source. When no config is found via CLI args or env vars, it:

1. **Hardcodes the config lookup path** to `<workdir>/tetrad-development/.generacy/config.yaml` ([workspace.ts:62](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/setup/workspace.ts#L62))
2. **Falls back to cloning `tetrad-development`** when no config is found ([workspace.ts:72](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/setup/workspace.ts#L72))

This breaks external projects that use the cluster-templates devcontainer setup. Their project repo is already mounted at `/workspaces/project` with a valid `.generacy/config.yaml`, but the workspace setup never looks there.

### Observed behavior (external project)

```
INFO: Resolved repos
    source: "bootstrap (config not found)"
    count: 1
INFO: Cloning repository
    repo: "tetrad-development"
ERROR: Failed to clone repository
    repo: "tetrad-development"
    stderr: "remote: Write access to repository not granted."
```

### Expected behavior

The setup should discover the `.generacy/config.yaml` in the already-mounted project repo and use it — no fallback cloning needed.

### Context

- Issue #291 (closed) established the design: **no hardcoded repo list**, config file is the sole source of truth, `findWorkspaceConfigPath()` was added to walk directories
- The `findWorkspaceConfigPath()` function exists in `packages/config/src/loader.ts:35-55` but is never called from workspace setup
- #291's Q6 answer explicitly stated: "There should be no `BOOTSTRAP_REPOS` constant... If no config file exists, the command fails with a clear error"

### Proposed fix

1. Remove the `tetrad-development` bootstrap fallback entirely
2. Use `findWorkspaceConfigPath()` (or check the mounted project directory) to discover config from the project repo that's already on disk
3. If no config is found anywhere, fail with a clear error message rather than silently trying to clone `tetrad-development`

### Reproduction

1. Create a project using the standard cluster-template with a `.generacy/config.yaml`
2. Start the devcontainer
3. Observe orchestrator fails trying to clone `tetrad-development` from `generacy-ai` org

## User Stories

### US1: External project workspace setup

**As an** external project developer using the cluster-templates devcontainer,
**I want** `generacy setup workspace` to discover and use my project's `.generacy/config.yaml`,
**So that** I can set up my workspace without needing access to the `tetrad-development` repository.

**Acceptance Criteria**:
- [ ] Workspace setup finds `.generacy/config.yaml` in any mounted project directory under `/workspaces/`
- [ ] No attempt is made to clone `tetrad-development` when a valid config exists on disk
- [ ] Setup completes successfully using the discovered config

### US2: Clear failure on missing config

**As a** developer setting up a workspace without any config file,
**I want** a clear error message explaining that no `.generacy/config.yaml` was found,
**So that** I know exactly what to fix rather than seeing a cryptic clone failure.

**Acceptance Criteria**:
- [ ] When no config is found anywhere, the command fails with an actionable error message
- [ ] The error message indicates where config files are expected (e.g., `/workspaces/<project>/.generacy/config.yaml`)
- [ ] No fallback cloning is attempted

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Remove the hardcoded `tetrad-development` bootstrap fallback from workspace setup | P1 | Lines ~62-72 in workspace.ts |
| FR-002 | Call `findWorkspaceConfigPath()` from workspace setup to discover config from mounted project repos | P1 | Function already exists in `packages/config/src/loader.ts:35-55` |
| FR-003 | Fail with a clear, actionable error message when no config is found | P1 | Per #291 Q6 design decision |
| FR-004 | Remove or deprecate the `BOOTSTRAP_REPOS` constant if it exists | P2 | Per #291 design: no hardcoded repo list |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | External project setup succeeds | 100% of projects with valid `.generacy/config.yaml` set up without errors | Manual test with cluster-template project |
| SC-002 | No hardcoded repo references | Zero references to `tetrad-development` in workspace setup logic | Code review / grep |
| SC-003 | Clear error on missing config | Error message includes expected config path | Manual test without config |

## Assumptions

- The `findWorkspaceConfigPath()` function in `packages/config/src/loader.ts` correctly walks directories to find config files
- External projects following the cluster-template pattern mount their repo at `/workspaces/<project-name>/`
- The `.generacy/config.yaml` schema is consistent across internal and external projects

## Out of Scope

- Changes to the `.generacy/config.yaml` schema or format
- Changes to how config is loaded after discovery (only the discovery/fallback mechanism changes)
- Supporting config discovery outside of `/workspaces/` directories
- Migration tooling for existing setups

---

*Generated by speckit*
