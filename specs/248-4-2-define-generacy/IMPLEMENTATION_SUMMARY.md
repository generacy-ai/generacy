# Implementation Summary

**Feature:** 4.2 — Define .generacy/config.yaml schema
**Status:** Ready for Implementation
**Estimated Effort:** 3-5 hours

## Quick Overview

This feature defines the schema for `.generacy/config.yaml`, the central configuration file for Generacy projects. The implementation uses Zod for type-safe validation, supports config discovery via directory tree walking, and exports types for use across the Generacy ecosystem.

## What's Being Built

### Core Components

1. **Zod Schema Definition** (`packages/generacy/src/config/schema.ts`)
   - Type-safe validation schemas
   - Project metadata, repository lists, workflow defaults, orchestrator settings
   - Format validation (project ID, agent names, repo URLs)

2. **Config Loader** (`packages/generacy/src/config/loader.ts`)
   - Directory tree walking to find `.generacy/config.yaml`
   - YAML parsing and validation
   - Helpful error messages

3. **Custom Validators** (`packages/generacy/src/config/validator.ts`)
   - Repository deduplication checks
   - Semantic validation rules

4. **CLI Command** (`packages/generacy/src/cli/commands/validate.ts`)
   - `generacy validate-config` command
   - Exit codes: 0 (valid), 1 (invalid), 2 (not found), 3 (parse error)

5. **Subpath Exports** (`packages/generacy/package.json`)
   - `@generacy-ai/generacy/config` for type imports
   - Enables orchestrator, VS Code extension, and generacy-cloud to import types

## Configuration Schema

### Minimal Example

```yaml
project:
  id: "proj_abc123"
  name: "My Project"
repos:
  primary: "github.com/acme/api"
```

### Full Example

```yaml
schemaVersion: "1"
project:
  id: "proj_abc123xyz"
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

## Key Validation Rules

| Field | Validation | Example Error |
|-------|-----------|---------------|
| `project.id` | `/^proj_[a-z0-9]+$/`, min 12 chars | "Must start with 'proj_' followed by at least 8 alphanumeric characters" |
| `project.name` | Non-empty, max 255 chars | "Project name must be between 1 and 255 characters" |
| Repository URLs | `github.com/{owner}/{repo}` | "Repository must be in format 'github.com/owner/repo'" |
| `defaults.agent` | Kebab-case `/^[a-z0-9]+(-[a-z0-9]+)*$/` | "Agent name must be kebab-case" |
| No duplicates | Repo can't be in multiple lists | "Repository appears in multiple lists: github.com/acme/shared" |

## File Structure

```
packages/generacy/
├── src/
│   ├── config/
│   │   ├── schema.ts           # Zod schemas (NEW)
│   │   ├── loader.ts           # Config discovery (NEW)
│   │   ├── validator.ts        # Custom validation (NEW)
│   │   ├── index.ts            # Public exports (NEW)
│   │   └── README.md           # Schema docs (NEW)
│   ├── cli/
│   │   └── commands/
│   │       └── validate.ts     # CLI command (NEW)
│   └── index.ts                # Updated for subpath exports
├── examples/
│   ├── config-minimal.yaml     # Example config (NEW)
│   ├── config-single-repo.yaml # Example config (NEW)
│   └── config-multi-repo.yaml  # Example config (NEW)
└── package.json                # Updated with subpath exports
```

## Implementation Phases

### Phase 1: Schema Definition (1-2 hours)
- Create Zod schemas for all config sections
- Implement validation rules from clarifications Q1-Q15
- Custom validators for repository deduplication
- Unit tests for schema validation

### Phase 2: Config Loading (1-2 hours)
- Implement directory tree walking
- YAML parsing with error handling
- Config discovery algorithm
- Tests for discovery and loading

### Phase 3: CLI Integration (1 hour)
- `validate-config` command
- Subpath export configuration
- Integration tests
- Help text and error formatting

### Phase 4: Documentation (30-60 minutes)
- Schema reference documentation
- Example configurations
- CLI usage guide

## Testing Strategy

### Test Coverage Requirements

- **Unit Tests:** >90% coverage
  - Schema validation (valid/invalid inputs)
  - Custom validators (deduplication)
  - Config discovery algorithm
  - Error message formatting

- **Integration Tests:**
  - CLI command execution
  - Subpath import resolution
  - End-to-end validation flow

### Example Test Cases

```typescript
// Schema validation
✓ Valid minimal config
✓ Valid full config
✓ Invalid project ID format
✓ Invalid repository URL
✓ Duplicate repository detection
✓ Empty/omitted arrays handled

// Config loading
✓ Find config in current directory
✓ Find config in parent directory
✓ Stop at repository root (.git/)
✓ Config not found error
✓ YAML parse error
✓ Environment variable override

// CLI command
✓ Exit 0 for valid config
✓ Exit 1 for invalid config
✓ Exit 2 for not found
✓ Exit 3 for parse error
✓ Verbose output format
✓ Quiet mode suppression
```

## Dependencies

### NPM Dependencies (Already Installed)

- `zod`: Schema validation (already in orchestrator)
- `yaml`: YAML parsing (already in orchestrator)
- `commander`: CLI framework (already in generacy)

### Internal Dependencies

- None (can start immediately)

### Blocked Downstream

- Epic 4.3: CLI init command
- Epic 4.4: Onboarding PR template
- Epic 5.1: Dev container setup
- Epic 5.4: Orchestrator config integration

## Key Technical Decisions

### 1. Zod for Validation
- **Why:** Already used by orchestrator, type-safe, excellent DX
- **Impact:** Single source of truth for schemas and types

### 2. Protocol-Agnostic Repository URLs
- **Format:** `github.com/owner/repo` (no `https://` or `git@`)
- **Why:** Auth determined at runtime (SSH vs HTTPS)
- **Impact:** Clean config, flexible deployment

### 3. Format-Only Validation
- **What:** Validate formats, not existence/accessibility
- **Why:** Fast, offline-capable, resources may not exist yet
- **Impact:** Runtime errors happen during clone/PR operations

### 4. Optional Schema Version
- **Default:** `"1"` if omitted
- **Why:** Future-proof for v2 migration
- **Impact:** Generated configs include it, manual configs optional

### 5. Single Root Config for Monorepos
- **Location:** `.generacy/config.yaml` at repository root
- **Why:** Config represents project, not package
- **Impact:** Simple discovery, clear ownership

## Success Criteria Checklist

Implementation is complete when:

- [x] Plan document created
- [ ] Zod schemas implemented with all validation rules
- [ ] Config loader with directory tree walking
- [ ] Custom validators for semantic rules
- [ ] Subpath exports configured
- [ ] CLI validate-config command
- [ ] Comprehensive test suite (>90% coverage)
- [ ] Documentation with examples
- [ ] Example config files
- [ ] Integration tests verify subpath imports

## Usage Examples

### Loading Config in TypeScript

```typescript
import { loadConfig, GeneracyConfig } from '@generacy-ai/generacy/config';

// Auto-discover from CWD
const config = loadConfig();
console.log(`Project: ${config.project.name}`);

// Explicit path
const config = loadConfig({ configPath: '/path/to/config.yaml' });

// Validation only
import { validateConfig } from '@generacy-ai/generacy/config';
const config = validateConfig(yamlObject);
```

### CLI Usage

```bash
# Validate config (auto-discover)
$ generacy validate-config
✓ Config is valid

# Explicit path
$ generacy validate-config --config /path/to/config.yaml

# Verbose output
$ generacy validate-config --verbose

# Quiet mode (for CI)
$ generacy validate-config --quiet && echo "Valid"
```

### Type Imports (Other Packages)

```typescript
// Orchestrator
import { GeneracyConfig } from '@generacy-ai/generacy/config';

function initFromConfig(config: GeneracyConfig) {
  return new Orchestrator({
    pollIntervalMs: config.orchestrator?.pollIntervalMs || 5000,
    maxWorkers: config.orchestrator?.workerCount || 3
  });
}

// VS Code Extension
import { loadConfig } from '@generacy-ai/generacy/config';

const config = await loadConfig();
vscode.window.showInformationMessage(
  `Generacy Project: ${config.project.name}`
);
```

## Common Validation Errors

### Invalid Project ID

```
Error at project.id:
  Project ID must start with 'proj_' followed by at least 8 alphanumeric characters
  Received: "my-project"
  Expected: /^proj_[a-z0-9]+$/ with min length 12
```

**Fix:** Get project ID from generacy.ai (format: `proj_abc123xyz`)

### Duplicate Repository

```
Error at repos:
  Repository appears in multiple lists: github.com/acme/shared
  A repository cannot be in both 'dev' and 'clone' lists.
```

**Fix:** Choose one classification (dev OR clone, not both)

### Invalid Agent Name

```
Error at defaults.agent:
  Agent name must be kebab-case (lowercase alphanumeric with hyphens)
  Received: "Claude Code"
  Expected: /^[a-z0-9]+(-[a-z0-9]+)*$/
```

**Fix:** Use kebab-case format (e.g., `claude-code`, `custom-agent-v2`)

## Out of Scope

### Explicitly Excluded from Phase 1

1. **Config Generation** (`generacy init` command)
   - Deferred to Epic 4.3

2. **Hot-Reloading**
   - Config changes require manual orchestrator restart
   - Documented in Getting Started guide

3. **Repository Accessibility Validation**
   - No network calls during validation
   - Checks happen at clone time

4. **Branch Existence Checks**
   - Config may be created before branch exists
   - Validation happens at PR creation time

5. **Multiple Configs per Repository**
   - Single root config only
   - No hierarchical merging

## Documentation Deliverables

### Required Documentation

1. **Schema Reference** (`packages/generacy/src/config/README.md`)
   - Field descriptions
   - Validation rules
   - Default values
   - Examples

2. **CLI Help Text** (`generacy validate-config --help`)
   - Command usage
   - Options
   - Examples
   - Exit codes

3. **Example Configs** (`packages/generacy/examples/`)
   - Minimal configuration
   - Single-repo project
   - Multi-repo project

4. **Implementation Artifacts** (This Spec)
   - plan.md
   - data-model.md
   - research.md
   - cli-spec.md

## Next Steps

### After Epic 4.2 Completion

1. **Epic 4.3:** CLI init command (uses schema to generate config)
2. **Epic 4.4:** Onboarding PR template (includes config.yaml)
3. **Epic 5.1:** Dev container setup (reads config for repo cloning)
4. **Epic 5.4:** Orchestrator integration (imports from generacy/config)

## References

### Specification Documents

- [Implementation Plan](./plan.md) - Detailed implementation phases
- [Data Model](./data-model.md) - Complete schema specification
- [Research](./research.md) - Technical decisions and alternatives
- [CLI Specification](./cli-spec.md) - Command-line interface details
- [Clarifications](./clarifications.md) - Q1-Q15 answered questions

### External References

- [Onboarding Buildout Plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md)
- Existing orchestrator config: `/workspaces/generacy/packages/orchestrator/src/config/`
- Zod Documentation: https://zod.dev/
- YAML Specification: https://yaml.org/spec/1.2.2/

## Questions?

For clarification on any aspect of this implementation:

1. Review the detailed [plan.md](./plan.md)
2. Check the [data-model.md](./data-model.md) for schema details
3. See [research.md](./research.md) for technical decision rationale
4. Consult [cli-spec.md](./cli-spec.md) for CLI behavior

All 15 clarification questions (Q1-Q15) have been answered and incorporated into the design.
