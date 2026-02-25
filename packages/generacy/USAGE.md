# Using @generacy-ai/generacy

## Installation

```bash
pnpm add @generacy-ai/generacy
```

## Configuration Schema

Import configuration types and validation from the `/config` subpath:

```typescript
import {
  // Types
  type GeneracyConfig,
  type ProjectConfig,
  type ReposConfig,
  type DefaultsConfig,
  type OrchestratorSettings,
  
  // Schemas (Zod)
  GeneracyConfigSchema,
  ProjectConfigSchema,
  ReposConfigSchema,
  DefaultsConfigSchema,
  OrchestratorSettingsSchema,
  
  // Validation functions
  validateConfig,
  validateSemantics,
  validateNoDuplicateRepos,
  
  // Error classes
  ConfigValidationError,
} from '@generacy-ai/generacy/config';
```

### Example: Validate a Configuration

```typescript
import { validateConfig, validateSemantics } from '@generacy-ai/generacy/config';
import { parse } from 'yaml';
import { readFileSync } from 'fs';

// Load and parse YAML
const yamlContent = readFileSync('.generacy/config.yaml', 'utf-8');
const rawConfig = parse(yamlContent);

// Validate structure with Zod
const config = validateConfig(rawConfig);

// Validate semantics (no duplicate repos, etc.)
validateSemantics(config);

console.log('Config is valid!', config);
```

### Example: Type-safe Config Object

```typescript
import type { GeneracyConfig } from '@generacy-ai/generacy/config';

const config: GeneracyConfig = {
  schemaVersion: '1',
  project: {
    id: 'proj_abc123xyz',
    name: 'My Project',
  },
  repos: {
    primary: 'github.com/acme/main',
    dev: ['github.com/acme/lib'],
    clone: ['github.com/acme/docs'],
  },
  defaults: {
    agent: 'claude-code',
    baseBranch: 'main',
  },
  orchestrator: {
    pollIntervalMs: 5000,
    workerCount: 3,
  },
};
```

### Error Handling

```typescript
import { validateConfig, validateSemantics, ConfigValidationError } from '@generacy-ai/generacy/config';
import { ZodError } from 'zod';

try {
  const config = validateConfig(rawConfig);
  validateSemantics(config);
} catch (error) {
  if (error instanceof ZodError) {
    console.error('Schema validation failed:');
    console.error(error.format());
  } else if (error instanceof ConfigValidationError) {
    console.error('Semantic validation failed:', error.message);
    if (error.conflictingRepos) {
      console.error('Conflicting repos:', error.conflictingRepos);
    }
  } else {
    throw error;
  }
}
```

## CLI Commands

### `generacy validate`

Validate a `.generacy/config.yaml` file and report any errors.

#### Usage

```bash
# Auto-discover config file in current directory or parent directories
generacy validate

# Validate a specific config file
generacy validate path/to/config.yaml

# Quiet mode (only show errors)
generacy validate --quiet

# JSON output (for tooling integration)
generacy validate --json
```

#### Examples

```bash
# Validate config in current project
cd my-project
generacy validate
# Output:
# ✓ Configuration is valid
#
# Config file: /path/to/my-project/.generacy/config.yaml
#
# Project:
#   ID: proj_abc123
#   Name: My Project
# ...

# Validate and get exit code for CI
generacy validate --quiet
echo $?  # 0 for success, 1 for failure

# Validate and parse output in scripts
generacy validate --json | jq '.config.project.id'
```

#### Error Reporting

The validate command provides detailed error messages for:

- **Schema Errors**: Invalid YAML syntax, missing required fields, wrong data types
- **Format Errors**: Invalid project ID format, repository URLs, agent names
- **Semantic Errors**: Duplicate repositories across primary/dev/clone lists
- **Range Errors**: Invalid values for pollIntervalMs, workerCount, etc.

Example error output:

```
Schema validation failed: /path/to/config.yaml

Validation errors:
  - project.id: Project ID must match format: proj_{alphanumeric}
  - repos.primary: Repository URL must match format: github.com/{owner}/{repo}
  - orchestrator.workerCount: Worker count must be at least 1
```

## See Also

- [Configuration Schema Documentation](./src/config/README.md)
- [Example Configurations](./examples/)
