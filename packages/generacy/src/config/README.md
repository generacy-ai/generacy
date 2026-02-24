# Generacy Configuration Schema

This package provides Zod-based schema validation for `.generacy/config.yaml` files.

## Overview

The Generacy configuration file defines project metadata, repository relationships, workflow defaults, and orchestrator settings. It serves as the central configuration for Generacy projects.

## Quick Start

### Minimal Configuration

```yaml
project:
  id: "proj_abc123"
  name: "My Project"

repos:
  primary: "github.com/acme/main-repo"
```

### Configuration File Location

Place your config file at `.generacy/config.yaml` in your project root.

## Configuration Discovery

The Generacy CLI discovers configuration files using the following priority order:

1. **Environment Variable**: `GENERACY_CONFIG_PATH` - absolute path to config file
2. **Explicit Path**: Passed via CLI options (e.g., `--config /path/to/config.yaml`)
3. **Auto-Discovery**: Walks up from current directory looking for `.generacy/config.yaml`
   - Starts in current working directory
   - Walks up parent directories
   - Stops at repository root (detected via `.git/` directory)

**Example file locations**:

```
/workspace/myproject/.generacy/config.yaml  ✓ Found
/workspace/.generacy/config.yaml            ✓ Found (if not in myproject)
/home/user/.generacy/config.yaml            ✓ Found (if not in workspace)
```

## Usage

### CLI Commands

```bash
# Validate config (auto-discover)
generacy validate

# Validate specific config file
generacy validate --config /path/to/config.yaml

# Use environment variable
export GENERACY_CONFIG_PATH=/path/to/config.yaml
generacy validate
```

### TypeScript API

```typescript
import { loadConfig, parseConfig, type GeneracyConfig } from '@generacy-ai/generacy/config';

// Auto-discover and load config
const config = loadConfig();

// Load from explicit path
const config = loadConfig({ configPath: '/path/to/config.yaml' });

// Load from specific directory
const config = loadConfig({ startDir: '/workspace/project' });

// Parse YAML string
const yamlContent = `
project:
  id: "proj_abc123"
  name: "My Project"
repos:
  primary: "github.com/test/repo"
`;
const config = parseConfig(yamlContent);

// Just validate a config object (no file loading)
import { validateConfig, validateSemantics } from '@generacy-ai/generacy/config';

const config = validateConfig(rawConfig);
validateSemantics(config);
```

### Example Configuration

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

defaults:
  agent: claude-code
  baseBranch: main

orchestrator:
  pollIntervalMs: 5000
  workerCount: 3
```

## Schema Reference

### Root Schema: `GeneracyConfig`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `schemaVersion` | string | No | `"1"` | Schema version for future migrations |
| `project` | ProjectConfig | Yes | - | Project metadata |
| `repos` | ReposConfig | Yes | - | Repository configuration |
| `defaults` | DefaultsConfig | No | - | Workflow defaults |
| `orchestrator` | OrchestratorSettings | No | - | Orchestrator runtime settings |

### Project Configuration: `ProjectConfig`

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| `id` | string | Yes | Regex: `/^proj_[a-z0-9]+$/`, min 12 chars | Unique project ID from generacy.ai |
| `name` | string | Yes | Non-empty, max 255 chars | Human-readable project name |

**Project ID Format:**
- Must start with `proj_`
- Followed by lowercase alphanumeric characters
- Minimum 12 characters total (e.g., `proj_abc123`)

### Repository Configuration: `ReposConfig`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `primary` | string | Yes | - | Primary repository (onboarding PR target) |
| `dev` | string[] | No | `[]` | Development repositories (receive PRs) |
| `clone` | string[] | No | `[]` | Clone-only repositories (reference only) |

**Repository URL Format:**
- Format: `github.com/{owner}/{repo}`
- No protocol (no `https://` or `ssh://`)
- No `.git` suffix
- Example: `github.com/acme/main-api`

**Repository Rules:**
- Each repository can only appear once across all lists
- No duplicates between primary, dev, and clone

### Workflow Defaults: `DefaultsConfig`

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| `agent` | string | No | Regex: `/^[a-z0-9]+(-[a-z0-9]+)*$/` | Default agent name |
| `baseBranch` | string | No | Non-empty | Default base branch name |

**Agent Name Format:**
- Kebab-case format (lowercase alphanumeric with hyphens)
- Examples: `claude-code`, `cursor-agent`, `agent-v2`

**Base Branch:**
- No validation of branch existence (checked at runtime)
- Can be any valid Git branch name

### Orchestrator Settings: `OrchestratorSettings`

| Field | Type | Required | Validation | Description |
|-------|------|----------|------------|-------------|
| `pollIntervalMs` | number | No | Integer, min 5000 | Polling interval in milliseconds |
| `workerCount` | number | No | Integer, 1-20 | Maximum concurrent workers |

## Validation Layers

### 1. Structural Validation (Zod)

- Type correctness
- Required fields present
- Format validation (regex patterns)
- Range validation (min/max values)

### 2. Semantic Validation (Custom)

- Repository deduplication across lists
- Project ID format validation
- Agent name format validation

### 3. No Runtime Validation

- Branch existence NOT checked
- Repository accessibility NOT checked
- Config loading works offline

## Error Handling

The config system provides detailed, user-friendly error messages for all failure scenarios.

### ConfigNotFoundError

Thrown when config file cannot be found during discovery.

```typescript
import { ConfigNotFoundError } from '@generacy-ai/generacy/config';

try {
  const config = loadConfig();
} catch (error) {
  if (error instanceof ConfigNotFoundError) {
    console.error('Searched in:', error.searchPath);
    console.error('Starting from:', error.startDir);
  }
}
```

**Error message example**:

```
Config file not found. Searched in:
  - /workspace/project/.generacy/config.yaml
  - /workspace/.generacy/config.yaml
  - /home/user/.generacy/config.yaml

Create a config file at: /workspace/project/.generacy/config.yaml
```

### ConfigParseError

Thrown when YAML parsing fails (invalid YAML syntax).

```typescript
import { ConfigParseError } from '@generacy-ai/generacy/config';

try {
  const config = parseConfig(yamlContent);
} catch (error) {
  if (error instanceof ConfigParseError) {
    console.error('Parse error in:', error.filePath);
    console.error('Cause:', error.cause);
  }
}
```

**Error message example**:

```
Failed to parse config file: .generacy/config.yaml

Unexpected token at line 5, column 3
```

### ConfigSchemaError

Thrown when config fails structural validation (Zod schema).

```typescript
import { ConfigSchemaError } from '@generacy-ai/generacy/config';

try {
  const config = loadConfig();
} catch (error) {
  if (error instanceof ConfigSchemaError) {
    console.error('Schema errors:', error.errors);
    console.error('In file:', error.filePath);
  }
}
```

**Error message example**:

```
Config validation failed: .generacy/config.yaml

Validation errors:
  - project.id: Project ID must match format: proj_{alphanumeric}
  - repos.primary: Required
  - orchestrator.workerCount: Worker count cannot exceed 20

See documentation for schema reference.
```

### ConfigValidationError

Thrown when config fails semantic validation (custom logic).

```typescript
import { ConfigValidationError } from '@generacy-ai/generacy/config';

try {
  const config = loadConfig();
} catch (error) {
  if (error instanceof ConfigValidationError) {
    console.error('Conflicts:', error.conflictingRepos);
    console.error('Locations:', error.locations);
  }
}
```

**Error message example**:

```
Duplicate repositories found: github.com/acme/main, github.com/acme/lib.
Each repository can only appear once across primary, dev, and clone lists.
```

### Complete Error Handling Example

```typescript
import {
  loadConfig,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigSchemaError,
  ConfigValidationError,
} from '@generacy-ai/generacy/config';

try {
  const config = loadConfig();
  console.log('Config loaded successfully:', config.project.name);
} catch (error) {
  if (error instanceof ConfigNotFoundError) {
    console.error('Config file not found. Please create .generacy/config.yaml');
    console.error('Searched in:', error.searchPath);
  } else if (error instanceof ConfigParseError) {
    console.error('Invalid YAML syntax in config file');
    console.error(error.message);
  } else if (error instanceof ConfigSchemaError) {
    console.error('Config validation failed');
    console.error(error.message);
  } else if (error instanceof ConfigValidationError) {
    console.error('Semantic validation failed');
    console.error(error.message);
    if (error.conflictingRepos) {
      console.error('Conflicting repos:', error.conflictingRepos);
    }
  } else {
    console.error('Unexpected error:', error);
  }
  process.exit(1);
}
```

## Examples

See example configurations in `/packages/generacy/examples/`:

- `config-minimal.yaml` - Minimal configuration with only required fields
- `config-single-repo.yaml` - Single repository with defaults
- `config-multi-repo.yaml` - Multiple development and clone-only repos
- `config-full.yaml` - Complete configuration with all available fields

## TypeScript Types

All schemas export corresponding TypeScript types:

```typescript
import type {
  GeneracyConfig,
  ProjectConfig,
  ReposConfig,
  DefaultsConfig,
  OrchestratorSettings,
} from '@generacy-ai/generacy/config';
```

## Schema Evolution

The `schemaVersion` field enables future migrations:

- Current version: `"1"`
- Defaults to `"1"` if omitted
- Future versions can detect and migrate automatically

## Design Decisions

### Repository URL Format

Uses `github.com/{owner}/{repo}` format (no protocol) to:
- Support both HTTPS and SSH workflows
- Keep configs protocol-agnostic
- Simplify configuration files

### No Network Validation

Config validation is format-only to:
- Work offline
- Keep loading fast
- Avoid auth-dependent validation
- Allow configs to reference future resources

### Single Root Config

One `.generacy/config.yaml` per repository:
- Config represents a project, not a package
- Simpler discovery logic
- Clear ownership
- Works well for monorepos

### Repository Deduplication

Repositories can only appear once because:
- Prevents conflicting PR strategies
- Clarifies repo role (dev vs clone-only)
- Avoids ambiguous workflow behavior

## Advanced Topics

### Environment Variable Overrides

While the main config comes from `.generacy/config.yaml`, you can override the config file path:

```bash
# Use a different config file
export GENERACY_CONFIG_PATH=/custom/path/config.yaml
generacy validate
```

### Programmatic Config Discovery

```typescript
import { findConfigFile } from '@generacy-ai/generacy/config';

// Find config file starting from current directory
const configPath = findConfigFile();
if (configPath) {
  console.log('Found config at:', configPath);
} else {
  console.log('No config file found');
}

// Find config starting from specific directory
const configPath = findConfigFile('/workspace/project');
```

### Config File Parsing Only

If you have the config file content but want to parse and validate it:

```typescript
import { parseConfig } from '@generacy-ai/generacy/config';

const yamlContent = fs.readFileSync('.generacy/config.yaml', 'utf-8');
const config = parseConfig(yamlContent);
```

### Schema-Only Validation

For testing or when you already have a parsed object:

```typescript
import { validateConfig, validateSemantics } from '@generacy-ai/generacy/config';

// Structural validation only
const config = validateConfig(rawConfigObject);

// Full validation (structural + semantic)
const config = validateConfig(rawConfigObject);
validateSemantics(config);
```

## Testing

### Example Test Cases

```typescript
import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigSchemaError, ConfigValidationError } from '@generacy-ai/generacy/config';

describe('Config Validation', () => {
  it('should accept valid minimal config', () => {
    const yaml = `
      project:
        id: "proj_test123"
        name: "Test"
      repos:
        primary: "github.com/test/repo"
    `;
    expect(() => parseConfig(yaml)).not.toThrow();
  });

  it('should reject invalid project ID format', () => {
    const yaml = `
      project:
        id: "invalid_id"
        name: "Test"
      repos:
        primary: "github.com/test/repo"
    `;
    expect(() => parseConfig(yaml)).toThrow(ConfigSchemaError);
  });

  it('should reject duplicate repositories', () => {
    const yaml = `
      project:
        id: "proj_test123"
        name: "Test"
      repos:
        primary: "github.com/test/repo"
        dev:
          - "github.com/test/repo"
    `;
    expect(() => parseConfig(yaml)).toThrow(ConfigValidationError);
  });
});
```

## Related Files

- **Schema Definition**: [`schema.ts`](./schema.ts) - Zod schemas and TypeScript types
- **Config Loader**: [`loader.ts`](./loader.ts) - Config discovery and loading logic
- **Semantic Validator**: [`validator.ts`](./validator.ts) - Custom validation rules
- **Main Exports**: [`index.ts`](./index.ts) - Public API surface
- **CLI Validate Command**: [`../cli/commands/validate.ts`](../cli/commands/validate.ts) - CLI integration
- **Example Configs**: [`../../examples/`](../../examples/)
  - [`config-minimal.yaml`](../../examples/config-minimal.yaml) - Minimal required fields
  - [`config-single-repo.yaml`](../../examples/config-single-repo.yaml) - Single repository
  - [`config-multi-repo.yaml`](../../examples/config-multi-repo.yaml) - Multiple repositories
  - [`config-full.yaml`](../../examples/config-full.yaml) - All available fields

## Support

For issues or questions:
- **GitHub Issues**: [generacy-ai/tetrad-development](https://github.com/generacy-ai/tetrad-development/issues)
- **Documentation**: [onboarding-buildout-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/onboarding-buildout-plan.md)
