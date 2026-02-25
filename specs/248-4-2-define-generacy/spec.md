# Feature Specification: Define .generacy/config.yaml Schema

**Branch**: `248-4-2-define-generacy` | **Date**: 2026-02-25 | **Status**: Complete

## Summary

Define and implement the `.generacy/config.yaml` configuration schema that serves as the project-level configuration file for Generacy. This schema links a local repository to a generacy.ai project, declares repository relationships (primary, dev, clone-only), sets workflow defaults (agent, base branch), and configures orchestrator runtime settings. The Generacy CLI reads, discovers, and validates this config file using Zod schemas with two-layer validation (structural + semantic).

The config file lives at `.generacy/config.yaml` in the primary repository root and is placed there by the onboarding PR (Epic 4.3). Other packages in the ecosystem (orchestrator, VS Code extension, generacy-cloud) consume the schema types via the `@generacy-ai/generacy/config` subpath export.

### Config Schema Overview

```yaml
schemaVersion: "1"          # Optional, defaults to "1"
project:
  id: "proj_abc123xyz"      # Required — server-issued project ID
  name: "My Project"        # Required — human-readable name

repos:
  primary: "github.com/acme/main-api"  # Required — repo where config lives
  dev:                                  # Optional — active development repos
    - "github.com/acme/shared-lib"
    - "github.com/acme/worker-service"
  clone:                                # Optional — read-only reference repos
    - "github.com/acme/design-system"
    - "github.com/public/api-docs"

defaults:                    # Optional section
  agent: claude-code         # Optional — default agent (kebab-case)
  baseBranch: main           # Optional — default base branch

orchestrator:                # Optional section
  pollIntervalMs: 5000       # Optional — min 5000ms
  workerCount: 3             # Optional — range 1–20
```

---

## User Stories

### US1: Project Configuration

**As a** developer onboarding a project to Generacy,
**I want** a config file that links my repository to my generacy.ai project,
**So that** the CLI and orchestrator know which project context to operate in.

**Acceptance Criteria**:
- [ ] Config file contains `project.id` (format: `proj_{alphanumeric}`, min 12 chars) and `project.name` (non-empty, max 255 chars)
- [ ] Config file is placed at `.generacy/config.yaml` in the repository root
- [ ] CLI validates the project section on load and reports clear errors for invalid IDs or missing fields

### US2: Multi-Repository Declaration

**As a** developer working on a multi-repo project,
**I want** to declare which repositories are for active development and which are reference-only,
**So that** the dev container clones the right repos with the right access levels.

**Acceptance Criteria**:
- [ ] `repos.primary` identifies the main repository (required, format: `github.com/{owner}/{repo}`)
- [ ] `repos.dev` lists 0..N repositories for active development (optional, defaults to `[]`)
- [ ] `repos.clone` lists 0..N repositories for read-only reference (optional, defaults to `[]`)
- [ ] No repository may appear in more than one list (semantic validation rejects duplicates with clear error)
- [ ] Repository URLs use protocol-agnostic format without `.git` suffix

### US3: Workflow Defaults

**As a** team lead configuring Generacy for my team,
**I want** to set default workflow settings in config,
**So that** team members don't need to specify agent and branch on every operation.

**Acceptance Criteria**:
- [ ] `defaults.agent` accepts kebab-case agent names (e.g., `claude-code`, `cursor-agent`)
- [ ] `defaults.baseBranch` accepts any branch name string (existence validated at PR creation time, not config load)
- [ ] Both fields are optional — omitting them does not cause validation errors

### US4: Orchestrator Configuration

**As a** platform operator deploying Generacy,
**I want** orchestrator settings in the project config,
**So that** I can tune polling interval and worker concurrency per project.

**Acceptance Criteria**:
- [ ] `orchestrator.pollIntervalMs` accepts integers >= 5000 (minimum 5-second interval)
- [ ] `orchestrator.workerCount` accepts integers in range 1–20
- [ ] Both fields are optional — sensible defaults are used when omitted
- [ ] Settings can be overridden by environment variables in production deployments

### US5: Config Discovery

**As a** developer running CLI commands from any subdirectory,
**I want** the CLI to automatically find my project config,
**So that** I don't have to specify the config path every time.

**Acceptance Criteria**:
- [ ] CLI discovers `.generacy/config.yaml` by walking up the directory tree from the current directory
- [ ] Discovery stops at the repository root (detected via `.git/` directory)
- [ ] `GENERACY_CONFIG_PATH` environment variable overrides discovery (highest priority)
- [ ] Explicit `--config` option overrides discovery (second priority)
- [ ] Clear error message when config not found, showing all searched paths

---

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Define Zod schema for `project` section with `id` and `name` fields | P1 | `id`: regex `^proj_[a-z0-9]+$`, min 12 chars; `name`: non-empty, max 255 chars |
| FR-002 | Define Zod schema for `repos` section with `primary`, `dev`, `clone` fields | P1 | `primary` required; `dev`/`clone` optional, default `[]` |
| FR-003 | Validate repository URL format: `github.com/{owner}/{repo}` | P1 | No protocol prefix, no `.git` suffix, regex-validated |
| FR-004 | Define Zod schema for `defaults` section with `agent` and `baseBranch` | P2 | Both optional; `agent` must be kebab-case |
| FR-005 | Define Zod schema for `orchestrator` section with `pollIntervalMs` and `workerCount` | P2 | Both optional; `pollIntervalMs` >= 5000, `workerCount` 1–20 |
| FR-006 | Implement `GeneracyConfigSchema` root schema composing all sections | P1 | `project` and `repos` required; `defaults` and `orchestrator` optional |
| FR-007 | Add optional `schemaVersion` field with default `"1"` | P2 | For future migration support |
| FR-008 | Implement semantic validator: no duplicate repos across lists | P1 | Primary cannot appear in dev/clone; no overlap between dev and clone; no duplicates within a list |
| FR-009 | Implement config file discovery via directory tree walking | P1 | Walk up from startDir, check `.generacy/config.yaml` at each level, stop at `.git/` |
| FR-010 | Support `GENERACY_CONFIG_PATH` environment variable override | P1 | Highest priority in discovery chain |
| FR-011 | Support explicit `configPath` option in `loadConfig()` | P1 | Second priority after env var |
| FR-012 | Implement YAML parsing with clear error messages | P1 | `ConfigParseError` with file path and parse error details |
| FR-013 | Implement schema validation error reporting with field paths | P1 | `ConfigSchemaError` with dotted paths (e.g., `repos.primary`) |
| FR-014 | Export `validateConfig()` function for structural validation | P1 | Returns typed `GeneracyConfig` or throws `ZodError` |
| FR-015 | Export `loadConfig()` function with full discovery + validation pipeline | P1 | Env var → explicit path → auto-discovery → parse → validate → semantic check |
| FR-016 | Export `parseConfig()` for validating YAML string content | P2 | For testing and programmatic use |
| FR-017 | Export `findConfigFile()` for standalone discovery | P2 | Returns path or `null` |
| FR-018 | Export all types and schemas via `@generacy-ai/generacy/config` subpath | P1 | Allows orchestrator and other consumers to import types without full CLI |
| FR-019 | Define custom error classes: `ConfigNotFoundError`, `ConfigParseError`, `ConfigSchemaError`, `ConfigValidationError` | P1 | Each error includes context (file path, search path, conflicting repos) |

---

## Technical Design

### Validation Layers

1. **Structural Validation (Zod)** — Type correctness, required fields, format patterns, range constraints
2. **Semantic Validation (Custom)** — Cross-field rules (repository deduplication across lists)
3. **Not Validated** — Branch existence (checked at PR creation), repository accessibility (checked at clone), agent registry (format-only)

### Config Discovery Priority

```
1. GENERACY_CONFIG_PATH env var  →  absolute path
2. LoadConfigOptions.configPath  →  explicit path
3. findConfigFile(startDir)      →  walk up directories
   └─ Check .generacy/config.yaml at each level
   └─ Stop at .git/ boundary
   └─ Return null if not found
```

### Public API Surface

```typescript
// Types
export type GeneracyConfig    // Root config type
export type ProjectConfig     // Project section
export type ReposConfig       // Repos section
export type DefaultsConfig    // Defaults section
export type OrchestratorSettings // Orchestrator section

// Schemas (Zod)
export const GeneracyConfigSchema
export const ProjectConfigSchema
export const ReposConfigSchema
export const DefaultsConfigSchema
export const OrchestratorSettingsSchema

// Functions
export function loadConfig(options?: LoadConfigOptions): GeneracyConfig
export function findConfigFile(startDir?: string): string | null
export function parseConfig(yamlContent: string): GeneracyConfig
export function validateConfig(config: unknown): GeneracyConfig
export function validateSemantics(config: GeneracyConfig): void
export function validateNoDuplicateRepos(config: GeneracyConfig): void

// Error classes
export class ConfigNotFoundError    // Config file not found (includes search path)
export class ConfigParseError       // Invalid YAML syntax
export class ConfigSchemaError      // Zod validation failure (includes field paths)
export class ConfigValidationError  // Semantic validation failure (includes conflicting repos)
```

### Key Files

| File | Purpose |
|------|---------|
| `packages/generacy/src/config/schema.ts` | Zod schemas and `validateConfig()` |
| `packages/generacy/src/config/validator.ts` | Semantic validators (`validateNoDuplicateRepos`, `validateSemantics`) |
| `packages/generacy/src/config/loader.ts` | Discovery, YAML parsing, `loadConfig()`, error classes |
| `packages/generacy/src/config/index.ts` | Public API re-exports for subpath `@generacy-ai/generacy/config` |

---

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Schema validation coverage | All fields validated with correct constraints | Unit tests for every field's valid/invalid cases |
| SC-002 | Semantic validation coverage | Duplicate repos detected across all list combinations | Unit tests for primary↔dev, primary↔clone, dev↔clone, within-list duplicates |
| SC-003 | Config discovery reliability | Finds config from any subdirectory depth | Unit tests for current dir, parent, grandparent, and .git boundary |
| SC-004 | Error message clarity | Every error type includes actionable context | Errors include file path, field path, search path, or conflicting repos as appropriate |
| SC-005 | Test coverage | ≥ 60 test cases across schema, validator, and loader | Automated test suite in `__tests__/` directory |
| SC-006 | Example configs | Minimal, single-repo, multi-repo, and full examples provided | Example YAML files in `packages/generacy/examples/` |
| SC-007 | Subpath export works | Other packages can import from `@generacy-ai/generacy/config` | TypeScript compilation succeeds for orchestrator imports |

---

## Assumptions

- Project IDs are server-issued by generacy.ai and follow the `proj_{alphanumeric}` format — the CLI validates format only, not existence
- The `.generacy/config.yaml` file lives in the primary repository root and is placed by the onboarding PR (Epic 4.3)
- Repository URLs use GitHub-only format (`github.com/{owner}/{repo}`) — support for other Git hosts (GitLab, Bitbucket) is out of scope
- Authentication for repository access is handled externally (GitHub App tokens via generacy-cloud, `GITHUB_TOKEN` for local dev) — config stores identifiers only
- In monorepos, a single config at the repository root covers all packages
- Orchestrator settings can be overridden by environment variables in production (following the existing orchestrator config pattern)
- Config changes require manual restart of running services (no hot-reloading in Phase 1)

## Out of Scope

- **Repository authentication** — Config stores identifiers, not credentials. Auth handled at runtime by orchestrator/CLI
- **Branch existence validation** — `defaults.baseBranch` is a string reference, validated at PR creation time
- **Repository accessibility checks** — No network calls during config validation. Accessibility checked at clone time
- **Agent registry validation** — Agent names are format-validated (kebab-case) but not checked against a registry
- **Config hot-reloading** — Phase 1 requires manual restart after config changes
- **Per-package config in monorepos** — Single root config only; hierarchical merge not supported
- **Non-GitHub repository hosts** — Only `github.com` URLs supported in this phase
- **CLI `validate-config` command** — The validation library is implemented; the CLI command wrapper is a separate task
- **Config file generation / `generacy init`** — Config file creation is part of the onboarding PR flow (Epic 4.3)

---

*Generated by speckit*
