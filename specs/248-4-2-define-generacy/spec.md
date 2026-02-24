# Feature Specification: Define .generacy/config.yaml Schema

**Branch**: `248-4-2-define-generacy` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

Define the schema for `.generacy/config.yaml`, the central configuration file for Generacy projects. This file establishes the connection between a local development environment and the generacy.ai platform, specifies which repositories are involved in development, configures workflow defaults, and sets orchestrator behavior. The schema must be well-documented, validated by the Generacy CLI, and support both simple and complex multi-repository project structures.

## User Stories

### US1: Project Configuration

**As a** developer initializing a Generacy project,
**I want** to configure my project ID and name in `.generacy/config.yaml`,
**So that** my local environment is linked to the correct generacy.ai project and I can manage project metadata in one place.

**Acceptance Criteria**:
- [ ] Config file includes `project.id` field for generacy.ai linking
- [ ] Config file includes `project.name` field for human-readable identification
- [ ] Generacy CLI validates that `project.id` follows the format `proj_[alphanumeric]`
- [ ] Generacy CLI validates that `project.name` is a non-empty string

### US2: Repository Organization

**As a** developer working across multiple repositories,
**I want** to specify which repositories are primary, dev, or clone-only,
**So that** Generacy knows which repos to actively develop in versus clone for reference only.

**Acceptance Criteria**:
- [ ] Config supports `repos.primary` field for the main repository URL
- [ ] Config supports `repos.dev` array for repositories actively developed
- [ ] Config supports `repos.clone` array for reference-only repositories
- [ ] Generacy CLI validates that all repository URLs follow valid format (e.g., `github.com/org/repo`)
- [ ] Generacy CLI ensures `repos.primary` is specified if `repos` section exists
- [ ] Documentation clarifies the distinction between dev and clone repositories

### US3: Workflow Defaults

**As a** team lead standardizing workflows,
**I want** to set default agent and base branch in the config,
**So that** all developers on my team use consistent settings without manual configuration.

**Acceptance Criteria**:
- [ ] Config supports `defaults.agent` field for specifying default AI agent (e.g., `claude-code`)
- [ ] Config supports `defaults.baseBranch` field for specifying default base branch (e.g., `main`, `develop`)
- [ ] Generacy CLI validates that `defaults.agent` is one of the supported agent types
- [ ] Generacy CLI validates that `defaults.baseBranch` is a valid git branch name format

### US4: Orchestrator Configuration

**As a** developer optimizing orchestrator performance,
**I want** to configure poll interval and worker count,
**So that** I can balance responsiveness with system resource usage.

**Acceptance Criteria**:
- [ ] Config supports `orchestrator.pollIntervalMs` field for polling frequency in milliseconds
- [ ] Config supports `orchestrator.workerCount` field for number of concurrent workers
- [ ] Generacy CLI validates that `pollIntervalMs` is a positive integer
- [ ] Generacy CLI validates that `workerCount` is a positive integer between 1 and reasonable max (e.g., 10)
- [ ] Default values are provided when orchestrator settings are omitted

### US5: Schema Validation

**As a** developer editing `.generacy/config.yaml`,
**I want** immediate validation feedback from the CLI,
**So that** I can catch configuration errors before running Generacy commands.

**Acceptance Criteria**:
- [ ] Generacy CLI reads and parses `.generacy/config.yaml` on all relevant commands
- [ ] CLI provides clear error messages for invalid YAML syntax
- [ ] CLI provides clear error messages for schema validation failures
- [ ] CLI indicates which field failed validation and why
- [ ] CLI exits with non-zero code when config is invalid

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Schema must define `project.id` as required string field | P0 | Format: `proj_[alphanumeric]`, links to generacy.ai |
| FR-002 | Schema must define `project.name` as required string field | P0 | Human-readable project name |
| FR-003 | Schema must define `repos.primary` as required string field | P0 | Primary repository URL in format `github.com/org/repo` |
| FR-004 | Schema must define `repos.dev` as optional string array | P1 | Repositories cloned for active development |
| FR-005 | Schema must define `repos.clone` as optional string array | P1 | Repositories cloned read-only for reference |
| FR-006 | Schema must define `defaults.agent` as optional string field | P1 | Default agent identifier, e.g., `claude-code` |
| FR-007 | Schema must define `defaults.baseBranch` as optional string field | P1 | Default base branch name, e.g., `main` or `develop` |
| FR-008 | Schema must define `orchestrator.pollIntervalMs` as optional integer field | P1 | Polling interval in milliseconds, default 5000 |
| FR-009 | Schema must define `orchestrator.workerCount` as optional integer field | P1 | Concurrent worker count, default 3, max 10 |
| FR-010 | CLI must validate YAML syntax and provide parse error details | P0 | Exit with non-zero code on invalid YAML |
| FR-011 | CLI must validate all required fields are present | P0 | List missing required fields in error message |
| FR-012 | CLI must validate field types match schema | P0 | E.g., string vs integer vs array |
| FR-013 | CLI must validate repository URL format | P1 | Support `github.com/org/repo` pattern, allow other hosts |
| FR-014 | CLI must validate project ID format matches `proj_[alphanumeric]` | P1 | Prevent invalid project IDs |
| FR-015 | CLI must validate orchestrator values are within acceptable ranges | P1 | pollIntervalMs > 0, workerCount between 1-10 |
| FR-016 | Schema documentation must include complete example config | P0 | Show all fields with realistic values |
| FR-017 | Schema documentation must specify which fields are required vs optional | P0 | Clear indication in docs |
| FR-018 | Schema documentation must document default values for optional fields | P1 | Users need to know implicit defaults |

## Technical Specification

### Schema Structure

```yaml
# Required section
project:
  id: string                # Required, format: proj_[alphanumeric]
  name: string              # Required, human-readable project name

# Required section
repos:
  primary: string           # Required, format: github.com/org/repo
  dev: string[]             # Optional, default: []
  clone: string[]           # Optional, default: []

# Optional section
defaults:
  agent: string             # Optional, default: "claude-code"
  baseBranch: string        # Optional, default: "main"

# Optional section
orchestrator:
  pollIntervalMs: integer   # Optional, default: 5000, min: 100
  workerCount: integer      # Optional, default: 3, min: 1, max: 10
```

### Validation Rules

1. **Project Section**
   - `project.id`: Must match regex `^proj_[a-zA-Z0-9]+$`
   - `project.name`: Non-empty string, max 200 characters

2. **Repos Section**
   - `repos.primary`: Must be valid repository URL (e.g., `github.com/org/repo` or `gitlab.com/group/project`)
   - `repos.dev`: Each entry must be valid repository URL
   - `repos.clone`: Each entry must be valid repository URL
   - No duplicate URLs across `primary`, `dev`, and `clone`

3. **Defaults Section**
   - `defaults.agent`: Must be one of supported agents (initially: `claude-code`)
   - `defaults.baseBranch`: Must be valid git branch name (alphanumeric, hyphens, underscores, slashes)

4. **Orchestrator Section**
   - `orchestrator.pollIntervalMs`: Integer >= 100 and <= 60000 (1 minute max)
   - `orchestrator.workerCount`: Integer >= 1 and <= 10

### Example Configuration

```yaml
# .generacy/config.yaml
project:
  id: "proj_abc123"
  name: "My Project"

repos:
  primary: "github.com/acme/main-api"
  dev:
    - "github.com/acme/shared-lib"
    - "github.com/acme/worker-service"
  clone:
    - "github.com/acme/design-system"
    - "github.com/public/api-docs"

defaults:
  agent: claude-code
  baseBranch: main

orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
```

### Minimal Configuration

```yaml
# Minimal valid .generacy/config.yaml
project:
  id: "proj_xyz789"
  name: "Simple Project"

repos:
  primary: "github.com/user/my-repo"
```

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Schema documentation completeness | 100% of fields documented | Review documentation covers all schema fields |
| SC-002 | CLI validation coverage | 100% of validation rules implemented | Test suite covers all validation scenarios |
| SC-003 | Error message clarity | 90%+ user comprehension | User testing with invalid configs |
| SC-004 | Config parse time | < 100ms for typical config | Performance benchmark |
| SC-005 | Validation error identification | 100% accuracy | All invalid configs correctly identified |

## Assumptions

- The `.generacy/config.yaml` file will be located in the root of the project workspace
- Repository URLs will primarily use GitHub, but should support other Git hosting providers
- The `project.id` will be generated by generacy.ai and provided to users during project setup
- Only one primary repository is needed per Generacy project
- All developers on a project will use the same `.generacy/config.yaml` (committed to version control)
- The orchestrator runs locally in the developer's environment, not on generacy.ai servers
- Default values are reasonable for most use cases and can be overridden when needed
- YAML is an acceptable configuration format for the target developer audience
- Configuration validation should happen early (at CLI startup) rather than failing mid-execution

## Out of Scope

- Automatic config generation or interactive setup wizard (may be added in future)
- Migration tools for config format changes (will be needed when schema evolves)
- Environment-specific overrides (e.g., `.generacy/config.local.yaml`)
- Secrets management or credential storage (should use separate secure storage)
- Repository authentication configuration (handled separately by Git)
- Advanced orchestrator features (priority queues, resource limits, scheduling)
- Config validation web UI or generacy.ai dashboard integration
- Automated config syncing between team members
- Config templates for different project types
- Schema versioning or backward compatibility (first version, no legacy to support)
- Dynamic config reloading without CLI restart
- Config encryption or obfuscation
- Multi-environment support (dev, staging, prod configs)

## Dependencies

None (can start immediately)

## Plan Reference

[onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Issue 4.2

---

**Phase:** 1 — Foundation (no blockers)
**Blocked by:** None — can start immediately

---

*Generated by speckit*
