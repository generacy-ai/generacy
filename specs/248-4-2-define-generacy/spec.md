# Feature Specification: Define .generacy/config.yaml Schema

**Branch**: `248-4-2-define-generacy` | **Date**: 2026-02-24 | **Status**: Draft

## Summary

Define the schema and structure for `.generacy/config.yaml`, the primary configuration file that establishes project-level settings for Generacy-enabled repositories. This configuration links local development environments to the generacy.ai platform, defines repository relationships, and sets workflow execution parameters for the orchestrator and agents.

The configuration file serves as the contract between:
- The developer's local environment (via Generacy CLI and dev containers)
- The generacy.ai platform (project identification and settings)
- The orchestrator service (workflow execution and worker coordination)
- Repository tooling (multi-repo workspace setup)

## User Stories

### US1: Link Local Environment to Generacy Project

**As a** developer setting up Generacy in my repository,
**I want** a configuration file that connects my local environment to my generacy.ai project,
**So that** the CLI and orchestrator can authenticate and operate with the correct project context.

**Acceptance Criteria**:
- [ ] Config file includes unique project ID from generacy.ai
- [ ] Config file includes human-readable project name
- [ ] Generacy CLI can read and validate the project ID
- [ ] Invalid or missing project ID produces clear error messages
- [ ] Config can be generated via onboarding PR or `generacy init` command

### US2: Define Repository Workspace Structure

**As a** developer working across multiple related repositories,
**I want** to specify which repos should be cloned and their development status,
**So that** my dev container has access to all necessary code with proper workspace organization.

**Acceptance Criteria**:
- [ ] Config identifies the primary repository (where orchestrator runs)
- [ ] Config lists dev repositories (active development, full tooling enabled)
- [ ] Config lists clone-only repositories (reference only, read-only access)
- [ ] All repo references use consistent format: `github.com/org/repo`
- [ ] Dev container setup scripts can parse repo lists to clone workspaces
- [ ] Config supports 0..N dev repos and 0..N clone-only repos

### US3: Set Workflow Execution Defaults

**As a** project maintainer,
**I want** to configure default workflow behaviors and agent settings,
**So that** issue labels trigger the correct agents and workflows without per-issue configuration.

**Acceptance Criteria**:
- [ ] Config specifies default agent for workflow execution (e.g., `claude-code`)
- [ ] Config specifies default base branch for PR creation (e.g., `main`, `develop`)
- [ ] Orchestrator reads defaults when processing labeled issues
- [ ] Individual workflow files can override these defaults
- [ ] Config validation ensures valid agent names and branch references

### US4: Configure Orchestrator Behavior

**As a** project administrator,
**I want** to tune orchestrator performance parameters,
**So that** I can optimize polling frequency and worker allocation for my project's needs.

**Acceptance Criteria**:
- [ ] Config specifies GitHub polling interval in milliseconds
- [ ] Config specifies maximum concurrent worker count
- [ ] Orchestrator service reads and applies these settings on startup
- [ ] Config validation ensures reasonable bounds (e.g., 1000ms ≤ poll interval ≤ 60000ms)
- [ ] Config supports optional orchestrator settings with sensible defaults

### US5: Validate Configuration on Read

**As a** CLI tool developer,
**I want** a well-defined schema with validation rules,
**So that** I can provide clear feedback when configuration is invalid or incomplete.

**Acceptance Criteria**:
- [ ] Schema includes required vs. optional field specifications
- [ ] Schema defines valid types and formats for all fields
- [ ] Schema validation catches common errors (missing project ID, malformed repo URLs)
- [ ] Validation errors include field path and suggested fixes
- [ ] Schema is documented with examples and field descriptions

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Config must include `project.id` field with string value from generacy.ai | P0 | Required for API authentication and project association |
| FR-002 | Config must include `project.name` field for human-readable identification | P0 | Used in UI and logging |
| FR-003 | Config must identify primary repository in `repos.primary` field | P0 | String format: `github.com/org/repo` |
| FR-004 | Config must support `repos.dev` array of development repositories | P1 | Optional, defaults to empty array |
| FR-005 | Config must support `repos.clone` array of clone-only repositories | P1 | Optional, defaults to empty array |
| FR-006 | Config must specify `defaults.agent` string field | P1 | Valid values: `claude-code`, `claude-opus`, custom agent names |
| FR-007 | Config must specify `defaults.baseBranch` string field | P1 | Default branch for PR creation (e.g., `main`, `develop`) |
| FR-008 | Config must support `orchestrator.pollIntervalMs` integer field | P2 | Milliseconds between GitHub API polls, default 5000 |
| FR-009 | Config must support `orchestrator.workerCount` integer field | P2 | Maximum concurrent workers, default 3 |
| FR-010 | Schema must be parseable as YAML | P0 | Standard YAML 1.2 syntax |
| FR-011 | CLI must validate config on read and report errors with field paths | P1 | Use schema validation library (e.g., Zod, Yup) |
| FR-012 | Config validation must check repo URL format | P1 | Pattern: `(github\.com\|gitlab\.com\|bitbucket\.org)/[^/]+/[^/]+` |
| FR-013 | Config validation must enforce reasonable orchestrator parameter bounds | P2 | pollInterval: 1000-60000ms, workerCount: 1-10 |
| FR-014 | Config file must be location-aware: `.generacy/config.yaml` in repo root | P0 | Standard location across all Generacy projects |
| FR-015 | Schema must support future extensibility without breaking changes | P2 | Use optional fields, avoid strict additionalProperties: false |
| FR-016 | Config may include comments for documentation | P2 | YAML comments preserved in template files |
| FR-017 | Generacy CLI must export config type definitions for TypeScript consumers | P1 | Enable type-safe config reading in CLI and orchestrator |

## Technical Design

### YAML Schema

```yaml
# .generacy/config.yaml
# Configuration for Generacy-enabled project
# Generated by: generacy.ai onboarding PR or `generacy init`

# Project identification - links to your generacy.ai project
project:
  id: "proj_abc123"              # Required: Unique project ID from generacy.ai
  name: "My Project"             # Required: Human-readable project name

# Repository workspace configuration
repos:
  # Primary repository where the orchestrator runs and dev containers live
  primary: "github.com/acme/main-api"  # Required: Format: "platform.com/org/repo"

  # Development repositories - cloned for active development with full tooling
  dev:
    - "github.com/acme/shared-lib"
    - "github.com/acme/worker-service"

  # Clone-only repositories - cloned for reference, read-only access
  clone:
    - "github.com/acme/design-system"
    - "github.com/public/api-docs"

# Workflow execution defaults
defaults:
  agent: claude-code             # Default agent for workflow execution
  baseBranch: main               # Default base branch for PR creation

# Orchestrator performance tuning (optional)
orchestrator:
  pollIntervalMs: 5000          # GitHub API polling interval (1000-60000ms)
  workerCount: 3                # Maximum concurrent workers (1-10)
```

### TypeScript Type Definition

```typescript
/**
 * Generacy project configuration schema
 * Location: .generacy/config.yaml
 */
export interface GeneracyConfig {
  project: {
    /** Unique project ID from generacy.ai (e.g., "proj_abc123") */
    id: string;
    /** Human-readable project name */
    name: string;
  };

  repos: {
    /** Primary repository where orchestrator and dev containers run */
    primary: string;
    /** Repositories cloned for active development (optional) */
    dev?: string[];
    /** Repositories cloned for reference only (optional) */
    clone?: string[];
  };

  defaults: {
    /** Default agent for workflow execution */
    agent: string;
    /** Default base branch for PR creation */
    baseBranch: string;
  };

  orchestrator?: {
    /** GitHub API polling interval in milliseconds (default: 5000) */
    pollIntervalMs?: number;
    /** Maximum concurrent workers (default: 3) */
    workerCount?: number;
  };
}
```

### Validation Rules (Zod Schema)

```typescript
import { z } from 'zod';

const repoUrlPattern = /^(github\.com|gitlab\.com|bitbucket\.org)\/[^/]+\/[^/]+$/;

export const generacyConfigSchema = z.object({
  project: z.object({
    id: z.string().min(1, 'Project ID is required'),
    name: z.string().min(1, 'Project name is required'),
  }),

  repos: z.object({
    primary: z.string().regex(repoUrlPattern, 'Invalid repo URL format. Expected: platform.com/org/repo'),
    dev: z.array(z.string().regex(repoUrlPattern)).optional().default([]),
    clone: z.array(z.string().regex(repoUrlPattern)).optional().default([]),
  }),

  defaults: z.object({
    agent: z.string().min(1, 'Default agent must be specified'),
    baseBranch: z.string().min(1, 'Default base branch must be specified'),
  }),

  orchestrator: z.object({
    pollIntervalMs: z.number().int().min(1000).max(60000).optional().default(5000),
    workerCount: z.number().int().min(1).max(10).optional().default(3),
  }).optional(),
});

export type GeneracyConfig = z.infer<typeof generacyConfigSchema>;
```

### CLI Integration Points

1. **Config Reading**: `generacy` CLI loads config at startup
   ```typescript
   import { loadConfig } from '@generacy-ai/generacy/config';

   const config = await loadConfig('.generacy/config.yaml');
   ```

2. **Config Validation**: Validate on read with clear error reporting
   ```typescript
   try {
     const config = await loadConfig('.generacy/config.yaml');
   } catch (error) {
     if (error instanceof ConfigValidationError) {
       console.error('Invalid config:', error.message);
       console.error('Field:', error.fieldPath);
       console.error('Expected:', error.expected);
     }
   }
   ```

3. **Config Generation**: `generacy init` command creates config from template
   ```bash
   $ generacy init
   ? Enter your project ID: proj_abc123
   ? Project name: My Awesome Project
   ? Primary repository: github.com/acme/main-api
   ✓ Generated .generacy/config.yaml
   ```

### File Location and Discovery

- **Standard location**: `.generacy/config.yaml` in repository root
- **Discovery logic**: Walk up directory tree until `.generacy/config.yaml` found
- **Environment override**: `GENERACY_CONFIG_PATH` for non-standard locations
- **Validation on discovery**: Fail fast with clear error if config invalid

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Config validation errors provide actionable field-level feedback | 100% of validation failures include field path and expected format | Manual testing with intentionally invalid configs |
| SC-002 | CLI config load time | < 50ms for typical config file | Performance benchmark in CLI test suite |
| SC-003 | Schema extensibility | Can add new optional fields without breaking existing configs | Version compatibility test suite |
| SC-004 | Developer comprehension | New users understand config structure without docs reference | User testing during onboarding (qualitative) |
| SC-005 | Config generation success rate | 100% of `generacy init` executions produce valid config | CI integration test |

## Implementation Tasks

### Phase 1: Schema Definition
- [ ] Define TypeScript interface for `GeneracyConfig`
- [ ] Implement Zod validation schema with error messages
- [ ] Create YAML template with inline documentation comments
- [ ] Write unit tests for schema validation (valid and invalid cases)

### Phase 2: CLI Integration
- [ ] Implement `loadConfig()` function in `@generacy-ai/generacy` package
- [ ] Add config validation on CLI startup
- [ ] Implement directory tree walk for config discovery
- [ ] Add `GENERACY_CONFIG_PATH` environment variable support
- [ ] Export types and validation utilities for downstream consumers

### Phase 3: Template Generation
- [ ] Create config template for single-repo projects
- [ ] Create config template for multi-repo projects
- [ ] Implement variable substitution in template system
- [ ] Add config generation to `generacy init` command
- [ ] Add config generation to onboarding PR service

### Phase 4: Documentation
- [ ] Document schema in `generacy` repo README
- [ ] Add inline YAML comments to templates
- [ ] Create migration guide for future schema changes
- [ ] Add troubleshooting guide for common config errors

## Assumptions

- GitHub is the primary supported platform for Phase 1 (GitLab/Bitbucket in future)
- Project IDs are globally unique identifiers issued by generacy.ai
- Config file is committed to version control (not in `.gitignore`)
- Orchestrator settings apply to entire project (not per-workflow overrides)
- YAML format is preferred over JSON for readability and comments
- Config schema will remain backward-compatible across minor versions
- Developer has write access to primary repo to merge onboarding PR
- Repository URLs do not include protocol prefix (`https://` omitted)

## Out of Scope

- **Secrets management**: API keys, tokens, and credentials belong in `.generacy/generacy.env` (not in `config.yaml`)
- **Workflow definitions**: Individual workflow YAML files are separate from project config
- **User-specific settings**: Editor preferences, local paths, etc. (use local `.env` or VS Code settings)
- **Team/organization config**: Multi-project, org-level settings (future: separate `org-config.yaml`)
- **Dynamic config updates**: Config changes require orchestrator restart (no hot-reloading in Phase 1)
- **Config inheritance**: No parent/child config relationships or includes
- **Environment-specific overrides**: No separate `config.dev.yaml`, `config.prod.yaml` (single config per repo)
- **Encrypted config values**: No built-in encryption for sensitive fields (use external secret management)
- **Config validation webhooks**: No server-side validation before merge (validated at runtime only)
- **Non-Git version control**: Subversion, Mercurial, Perforce not supported

## Dependencies

**Upstream (Blockers):**
- None — can start immediately (Phase 1: Foundation)

**Downstream (Depends on this):**
- Issue 4.1: Define onboarding PR template content (needs schema for template generation)
- Issue 4.3: Implement onboarding PR generation service (needs schema for config file creation)
- Issue 4.5: Generacy CLI `generacy init` command (needs schema for interactive config generation)
- Issue 5.3: Generacy VS Code extension config panel (needs schema for UI rendering)

## References

- [Onboarding Build-Out Plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md) — Epic 4, Issue 4.2
- [Dev Container Feature Specification](https://containers.dev/implementors/features/) — For `.devcontainer` integration
- [YAML 1.2 Specification](https://yaml.org/spec/1.2/spec.html) — Reference implementation

---

*Generated by speckit*
