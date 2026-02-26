# Test Fixtures for Generacy Config

This directory contains test fixtures for validating the `.generacy/config.yaml` schema and loader functionality.

## Valid Fixtures

### Minimal Configurations
- **`valid-minimal.yaml`** - Bare minimum required fields (project + primary repo)
- **`valid-schema-version-explicit.yaml`** - Minimal config with explicit schema version

### Partial Configurations
- **`valid-with-defaults.yaml`** - Config with defaults section only
- **`valid-with-orchestrator.yaml`** - Config with orchestrator section only
- **`valid-dev-only.yaml`** - Config with dev repos but no clone repos
- **`valid-clone-only.yaml`** - Config with clone repos but no dev repos
- **`valid-empty-optional-arrays.yaml`** - Config with explicitly empty arrays

### Complete Configurations
- **`valid-full.yaml`** - Full config with all optional fields populated

## Invalid Fixtures

### Schema Validation Errors

#### Project Configuration
- **`invalid-project-id.yaml`** - Project ID doesn't match format `proj_{alphanumeric}`
- **`invalid-project-id-too-short.yaml`** - Project ID shorter than 12 characters
- **`invalid-project-name-too-long.yaml`** - Project name exceeds 255 characters

#### Repository URLs
- **`invalid-repo-url-format.yaml`** - Repository URL includes protocol (https://)
- **`invalid-repo-url-git-suffix.yaml`** - Repository URL ends with .git

#### Defaults
- **`invalid-agent-format.yaml`** - Agent name not in kebab-case format
- **`invalid-empty-base-branch.yaml`** - Base branch is empty string

#### Orchestrator Settings
- **`invalid-orchestrator-poll-interval.yaml`** - Poll interval below 5000ms minimum
- **`invalid-orchestrator-worker-count.yaml`** - Worker count exceeds maximum of 20

### Semantic Validation Errors

#### Repository Deduplication
- **`invalid-duplicate-repos.yaml`** - Repository appears in both dev and clone lists
- **`invalid-primary-in-dev.yaml`** - Primary repository also in dev list
- **`invalid-primary-in-clone.yaml`** - Primary repository also in clone list

### Parse Errors
- **`invalid-yaml-syntax.yaml`** - Malformed YAML (unclosed array)

## Discovery Test Structure

The **`discovery-test/`** directory contains a directory structure for testing the config file discovery algorithm:

```
discovery-test/
├── .generacy/
│   └── config.yaml          # Config at root
├── nested/
│   └── deep/                # Test discovery from nested dirs
└── README.md
```

Tests should verify that the loader can find the config when starting from nested directories and properly walk up the directory tree.

## Usage in Tests

### Loading Fixtures

```typescript
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '../loader.js';

const fixturesDir = join(__dirname, 'fixtures');

// Load valid fixture
const validMinimal = readFileSync(
  join(fixturesDir, 'valid-minimal.yaml'),
  'utf-8'
);
const config = parseConfig(validMinimal);

// Test invalid fixture
const invalidProjectId = readFileSync(
  join(fixturesDir, 'invalid-project-id.yaml'),
  'utf-8'
);
expect(() => parseConfig(invalidProjectId)).toThrow();
```

### Discovery Tests

```typescript
import { loadConfig } from '../loader.js';
import { join } from 'node:path';

const discoveryDir = join(__dirname, 'fixtures', 'discovery-test');

// Should find config from nested directory
const config = loadConfig({
  startDir: join(discoveryDir, 'nested', 'deep')
});

expect(config.project.id).toBe('proj_discovery');
```

## Maintenance

When adding new validation rules to the schema:
1. Add corresponding valid fixture demonstrating the rule
2. Add corresponding invalid fixture testing rule violation
3. Update this README with the new fixtures
4. Update test suites to cover the new fixtures
