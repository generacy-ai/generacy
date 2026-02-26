# Implementation Plan: Define .generacy/config.yaml Schema

**Feature:** 4.2 — Define .generacy/config.yaml schema
**Status:** Ready for Implementation
**Complexity:** Medium
**Estimated Effort:** 3-5 hours

## Summary

Implement the `.generacy/config.yaml` schema that serves as the central configuration file for Generacy projects. This schema defines project metadata, repository relationships, workflow defaults, and orchestrator settings. The implementation focuses on Zod-based validation in the CLI package with subpath exports for type sharing across the ecosystem.

## Technical Context

**Language:** TypeScript 5.4.5
**Framework:** Node.js >=20.0.0
**Primary Package:** `@generacy-ai/generacy` (CLI)
**Key Dependencies:**
- `zod` (schema validation) - already in use by orchestrator
- `yaml` (YAML parsing) - already in use by orchestrator
- Subpath exports for type sharing

**Existing Patterns:**
- Orchestrator already uses Zod schemas in `packages/orchestrator/src/config/schema.ts`
- Config loader pattern established in `packages/orchestrator/src/config/loader.ts`
- Environment variable override pattern: `ORCHESTRATOR_*` prefix
- Deep merge for file + env config, with env taking precedence

## Architecture Overview

### Package Structure

```
packages/generacy/
├── src/
│   ├── config/
│   │   ├── schema.ts          # Zod schemas and TypeScript types
│   │   ├── loader.ts          # Config discovery and loading
│   │   ├── validator.ts       # Custom validation logic
│   │   └── index.ts           # Public exports
│   ├── cli/
│   │   └── commands/
│   │       ├── init.ts        # Generate config (future)
│   │       └── validate.ts    # Validate config command
│   └── index.ts               # Main entry with subpath exports
└── package.json               # Add subpath export for /config
```

### Config File Location Strategy

**Discovery Order** (walk up from CWD):
1. Check for `.generacy/config.yaml` in current directory
2. Walk up parent directories until found
3. Stop at repository root (detected via `.git/` directory)
4. Fail if not found

**Environment Override:**
- `GENERACY_CONFIG_PATH` env var for explicit path specification

### Validation Layers

1. **Structural Validation** (Zod schemas)
   - Type correctness
   - Required fields present
   - Format validation (regex patterns)

2. **Semantic Validation** (custom validators)
   - Repository URL deduplication across lists
   - Project ID format validation
   - Agent name format validation

3. **No Runtime Validation**
   - Branch existence NOT checked (Q5 clarification)
   - Repository accessibility NOT checked (Q13 clarification)

## Implementation Phases

### Phase 1: Schema Definition and Validation

**Duration:** 1-2 hours

1. **Create Zod Schemas** (`packages/generacy/src/config/schema.ts`)
   - `ProjectConfigSchema`: Project metadata (id, name)
   - `ReposConfigSchema`: Repository lists (primary, dev, clone)
   - `DefaultsConfigSchema`: Workflow defaults (agent, baseBranch)
   - `OrchestratorSettingsSchema`: Orchestrator settings (pollIntervalMs, workerCount)
   - `GeneracyConfigSchema`: Root schema with optional schemaVersion

2. **Validation Rules:**
   - `project.id`: Regex `/^proj_[a-z0-9]+$/`, min 12 chars (Q1)
   - `project.name`: Non-empty string, max 255 chars (Q11)
   - Repository URLs: Format `github.com/{owner}/{repo}` (Q2, Q13)
   - `defaults.agent`: Kebab-case format `/^[a-z0-9]+(-[a-z0-9]+)*$/` (Q4)
   - `defaults.baseBranch`: Non-empty string, no existence check (Q5)
   - `orchestrator.pollIntervalMs`: Min 5000ms
   - `orchestrator.workerCount`: Min 1, max 20 (reasonable upper bound)
   - `repos.dev` and `repos.clone`: Optional arrays (Q14)
   - `schemaVersion`: Optional, defaults to "1" if omitted (Q12)

3. **Custom Validators** (`packages/generacy/src/config/validator.ts`)
   - Repository deduplication check across primary/dev/clone (Q6)
   - Primary repo self-reference validation (Q3)

**Files Created:**
- `packages/generacy/src/config/schema.ts`
- `packages/generacy/src/config/validator.ts`
- `packages/generacy/src/config/index.ts`

**Tests:**
- Valid config parsing
- Invalid field type errors
- Format validation (project ID, agent name, repo URLs)
- Duplicate repository detection
- Empty/omitted array handling
- Schema version defaulting

### Phase 2: Config Discovery and Loading

**Duration:** 1-2 hours

1. **Config Loader** (`packages/generacy/src/config/loader.ts`)
   - Directory tree walking (stop at `.git/`)
   - YAML file parsing
   - Schema validation
   - Helpful error messages

2. **Discovery Algorithm:**
   ```typescript
   function findConfigFile(startDir: string): string | null {
     let currentDir = resolve(startDir);
     const root = parse(currentDir).root;

     while (currentDir !== root) {
       const configPath = join(currentDir, '.generacy', 'config.yaml');
       if (existsSync(configPath)) {
         return configPath;
       }

       // Stop at repository root
       if (existsSync(join(currentDir, '.git'))) {
         return null;
       }

       currentDir = dirname(currentDir);
     }

     return null;
   }
   ```

3. **Environment Variable Override:**
   - `GENERACY_CONFIG_PATH` for explicit path
   - No other env var overrides in Phase 1 (Q10 clarification: orchestrator uses env vars, not generacy config)

4. **Error Handling:**
   - File not found: Clear message with discovery path
   - Parse errors: Show YAML line number
   - Validation errors: Show specific field and constraint violated

**Files Created:**
- `packages/generacy/src/config/loader.ts`

**Tests:**
- Config discovery from nested directories
- Stop at repository root
- Environment variable override
- File not found error
- Invalid YAML error
- Validation error formatting

### Phase 3: CLI Integration and Subpath Exports

**Duration:** 1 hour

1. **Subpath Export Configuration** (`packages/generacy/package.json`)
   ```json
   {
     "exports": {
       ".": {
         "types": "./dist/index.d.ts",
         "import": "./dist/index.js"
       },
       "./config": {
         "types": "./dist/config/index.d.ts",
         "import": "./dist/config/index.js"
       }
     }
   }
   ```

2. **Public Type Exports** (`packages/generacy/src/config/index.ts`)
   - Export all schemas and types
   - Export loader functions
   - Export validator utilities

3. **CLI Command** (`packages/generacy/src/cli/commands/validate.ts`)
   - `generacy validate-config` command
   - Loads config and reports validation status
   - Exit code 0 = valid, 1 = invalid

4. **Example Usage:**
   ```typescript
   // From orchestrator or other packages
   import { GeneracyConfig, loadConfig } from '@generacy-ai/generacy/config';

   const config = loadConfig({ startDir: process.cwd() });
   console.log(`Project: ${config.project.name}`);
   ```

**Files Modified:**
- `packages/generacy/package.json` (add subpath exports)
- `packages/generacy/src/index.ts` (register subpath exports)

**Files Created:**
- `packages/generacy/src/cli/commands/validate.ts`

**Tests:**
- Subpath import resolution
- CLI validate command success
- CLI validate command failure with helpful errors

### Phase 4: Documentation and Examples

**Duration:** 30-60 minutes

1. **Schema Documentation** (`packages/generacy/src/config/README.md`)
   - Full schema reference
   - Field descriptions
   - Validation rules
   - Default values
   - Example configurations

2. **Example Configs** (`packages/generacy/examples/`)
   - Single-repo project
   - Multi-repo project with dev dependencies
   - Minimal configuration
   - Full configuration with all optional fields

3. **Migration Guide** (for future v2)
   - Schema version detection
   - Migration path placeholder

**Files Created:**
- `packages/generacy/src/config/README.md`
- `packages/generacy/examples/config-single-repo.yaml`
- `packages/generacy/examples/config-multi-repo.yaml`
- `packages/generacy/examples/config-minimal.yaml`

## Data Model

See [`data-model.md`](./data-model.md) for complete schema specification.

**Key Entities:**
- `GeneracyConfig`: Root configuration object
- `ProjectConfig`: Project metadata
- `ReposConfig`: Repository relationships
- `DefaultsConfig`: Workflow defaults
- `OrchestratorSettings`: Orchestrator runtime settings

## API Contracts

**Public TypeScript API:**

```typescript
// Load config from filesystem
export function loadConfig(options?: LoadConfigOptions): GeneracyConfig;

// Validate config object
export function validateConfig(config: unknown): GeneracyConfig;

// Find config file path
export function findConfigFile(startDir?: string): string | null;

// Parse YAML config
export function parseConfig(yamlContent: string): GeneracyConfig;

export interface LoadConfigOptions {
  /** Directory to start searching from (default: process.cwd()) */
  startDir?: string;
  /** Explicit config file path (skips discovery) */
  configPath?: string;
}
```

**CLI Commands:**

```bash
# Validate config (exit 0 if valid, 1 if invalid)
generacy validate-config [--config <path>]

# Future: Initialize new config
generacy init [--project-id <id>]
```

## Key Technical Decisions

### 1. Use Zod for Schema Validation

**Rationale:**
- Already used by orchestrator package
- Excellent TypeScript inference
- Composable schemas
- Clear error messages
- Runtime validation + static types in one

**Alternatives Considered:**
- JSON Schema: Less TypeScript integration
- Ajv: More verbose, less type-safe
- Manual validation: Error-prone, harder to maintain

### 2. Subpath Exports for Type Sharing

**Decision:** Use `@generacy-ai/generacy/config` subpath export

**Rationale:**
- Keeps config types co-located with validation logic
- Allows other packages to import types without full CLI
- Follows Node.js ESM best practices
- Aligns with clarification Q15

**Impact:**
- Orchestrator can import config types without circular dependencies
- VS Code extension can read config with type safety
- generacy-cloud can validate configs server-side

### 3. Format-Only Validation (No Network Calls)

**Decision:** Validate formats only, not existence/accessibility

**Rationale:**
- Config loading must work offline (Q13)
- Repository accessibility depends on runtime auth (Q2)
- Branch existence may change over time (Q5)
- Keeps config loading fast and predictable

**Impact:**
- Validation errors happen at runtime (clone time, PR creation)
- Config files can be committed before referenced resources exist
- Better developer experience for new projects

### 4. Repository URL Format

**Decision:** Use `github.com/{owner}/{repo}` format (no protocol, no `.git`)

**Rationale:**
- Protocol-agnostic (HTTPS vs SSH determined at clone time)
- Clean, readable format
- Matches GitHub's web URLs
- Auth handled separately (Q2)

**Impact:**
- Clone operations must add protocol based on available credentials
- Config examples are cleaner
- Supports both HTTPS (with token) and SSH workflows

### 5. Optional Schema Version Field

**Decision:** Include `schemaVersion` field, optional with default "1"

**Rationale:**
- Zero-cost future-proofing (Q12)
- Generated configs include it explicitly
- Manual configs work without it
- Clear migration path for v2

**Impact:**
- All generated configs include `schemaVersion: "1"`
- Loader defaults to "1" if omitted
- Future versions can detect and migrate automatically

### 6. Single Root Config for Monorepos

**Decision:** One `.generacy/config.yaml` at repository root (Q8)

**Rationale:**
- Config represents a *project*, not a package
- Consistent with onboarding PR placement
- Simpler discovery logic
- Matches existing internal usage

**Impact:**
- Monorepo packages all share same Generacy project
- No hierarchical config merging needed
- Clear ownership and discoverability

### 7. No Semantic Ordering for Repository Lists

**Decision:** Repository order has no runtime meaning (Q9)

**Rationale:**
- Repos clone independently (parallel safe)
- No dependency ordering described in buildout plan
- Order preserved for UI display only

**Impact:**
- Orchestrator can clone repos in parallel
- Order in YAML matches order in dashboard displays
- No implicit dependencies between repos

## Risk Mitigation

### Risk 1: Breaking Changes to Schema

**Mitigation:**
- Include `schemaVersion` field from day 1
- Version detection enables future migrations
- Comprehensive test coverage for validation
- Document all validation rules clearly

### Risk 2: Config Discovery Ambiguity

**Mitigation:**
- Clear algorithm: walk up, stop at `.git/`
- `GENERACY_CONFIG_PATH` env var for override
- Helpful error messages showing search path
- Document discovery behavior in README

### Risk 3: Poor Error Messages

**Mitigation:**
- Zod provides detailed path information
- Custom error formatter for common mistakes
- Include examples in error messages
- CLI command shows validation errors clearly

### Risk 4: Type Export Issues

**Mitigation:**
- Test subpath imports in integration tests
- Document import paths in README
- Use TypeScript's `tsc --noEmit` to verify exports
- Add example usage in documentation

### Risk 5: Config Validation Too Strict

**Mitigation:**
- Follow clarification decisions (Q1-Q15)
- Format-only validation (no network calls)
- Accept optional fields (dev/clone repos)
- Document all constraints clearly

## Out of Scope

The following items are explicitly excluded from this implementation:

1. **Config Hot-Reloading** (Q7)
   - Phase 1 requires manual orchestrator restart
   - No file watching or change detection
   - Documented in Getting Started guide (Epic 6)

2. **Config Generation/Init Command**
   - `generacy init` command deferred to Epic 4.3
   - Only validation command in this spec

3. **Git Repository Validation**
   - No checks for branch existence (Q5)
   - No checks for repository accessibility (Q13)
   - Format validation only

4. **Environment Variable Overrides for Config Fields**
   - Orchestrator settings have env var overrides (Q10)
   - Generacy config does NOT (loaded from YAML only)
   - `GENERACY_CONFIG_PATH` is the only env var

5. **Multi-Config Support**
   - Single config per repository (Q8)
   - No hierarchical merging
   - No per-package configs in monorepos

6. **Advanced Repository Configuration**
   - No clone depth, sparse checkout, or clone options
   - Basic repo identifier only (owner/repo)
   - Advanced features deferred to future phases

## Testing Strategy

### Unit Tests

1. **Schema Validation Tests** (`packages/generacy/src/config/__tests__/schema.test.ts`)
   - Valid config parsing (all fields)
   - Valid config parsing (minimal fields)
   - Invalid project ID format
   - Invalid agent name format
   - Invalid repository URL format
   - Out-of-range orchestrator settings
   - Schema version defaulting
   - Empty/omitted array handling

2. **Validator Tests** (`packages/generacy/src/config/__tests__/validator.test.ts`)
   - Duplicate repository detection (primary in dev)
   - Duplicate repository detection (dev in clone)
   - Duplicate repository detection (all three lists)
   - No duplicates (valid multi-repo config)

3. **Loader Tests** (`packages/generacy/src/config/__tests__/loader.test.ts`)
   - Find config in current directory
   - Find config in parent directory
   - Find config in grandparent directory
   - Stop at repository root (.git/)
   - Config not found error
   - Invalid YAML error
   - Validation error
   - Environment variable override (GENERACY_CONFIG_PATH)

### Integration Tests

1. **CLI Command Tests** (`packages/generacy/src/cli/__tests__/validate.test.ts`)
   - Valid config returns exit 0
   - Invalid config returns exit 1
   - Config not found returns exit 1
   - Helpful error messages printed

2. **Subpath Export Tests** (`packages/generacy/__tests__/exports.test.ts`)
   - Import from `@generacy-ai/generacy/config`
   - Type definitions available
   - Functions exported correctly

### Example Configs for Testing

```yaml
# Minimal valid config
project:
  id: "proj_test123"
  name: "Test Project"
repos:
  primary: "github.com/test/repo"

---
# Full config with all fields
schemaVersion: "1"
project:
  id: "proj_abc123xyz"
  name: "My Full Project"
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

---
# Invalid: duplicate repo in dev and clone
project:
  id: "proj_invalid"
  name: "Invalid"
repos:
  primary: "github.com/test/primary"
  dev:
    - "github.com/test/shared"
  clone:
    - "github.com/test/shared"  # ERROR: duplicate
```

## Success Criteria

Implementation is complete when:

1. ✅ Zod schema defined with all validation rules from Q1-Q15
2. ✅ Config loader with directory tree walking and discovery
3. ✅ Custom validation for repository deduplication
4. ✅ Subpath exports configured in package.json
5. ✅ Types exported from `@generacy-ai/generacy/config`
6. ✅ CLI `validate-config` command implemented
7. ✅ Comprehensive test suite (>90% coverage)
8. ✅ Documentation with examples and schema reference
9. ✅ Example config files for common scenarios
10. ✅ Integration tests verify subpath imports work

## Dependencies

**Upstream (must complete first):**
- None (can start immediately)

**Downstream (blocked on this):**
- Epic 4.3: CLI init command (uses schema to generate config)
- Epic 4.4: Onboarding PR template (includes config.yaml)
- Epic 5.1: Dev container setup (reads config for repo cloning)
- Epic 5.4: Orchestrator config integration (imports types from generacy/config)

## Notes

- This implementation establishes the foundation for all config-driven functionality
- Schema version field enables future migrations without breaking changes
- Format-only validation keeps config loading fast and offline-capable
- Subpath exports enable type sharing without circular dependencies
- Single root config model is simple and sufficient for Phase 1
- Repository lists have no semantic ordering (parallel clone safe)
- Project names are not unique (project IDs handle uniqueness)
- Config changes require manual restart in Phase 1 (documented)

## References

- [Onboarding Buildout Plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md)
- [Clarifications Q1-Q15](./clarifications.md)
- [Data Model](./data-model.md)
- Existing orchestrator config: `/workspaces/generacy/packages/orchestrator/src/config/`
