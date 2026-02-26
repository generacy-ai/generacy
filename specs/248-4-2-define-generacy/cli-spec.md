# CLI Command Specification

**Feature:** 4.2 — Define .generacy/config.yaml schema
**Package:** `@generacy-ai/generacy`

## Overview

This document specifies the CLI commands for working with `.generacy/config.yaml` files. Phase 1 focuses on config validation; config generation is deferred to Epic 4.3.

---

## Commands

### `generacy validate-config`

Validates the `.generacy/config.yaml` file in the current project.

#### Usage

```bash
generacy validate-config [options]
```

#### Options

| Option | Alias | Type | Description |
|--------|-------|------|-------------|
| `--config <path>` | `-c` | string | Path to config file (default: auto-discover) |
| `--verbose` | `-v` | boolean | Show detailed validation output |
| `--quiet` | `-q` | boolean | Only show errors (suppress success message) |

#### Exit Codes

| Code | Meaning | Example |
|------|---------|---------|
| `0` | Valid | Config is well-formed and passes all validation |
| `1` | Invalid | Validation errors found (format, schema, semantic) |
| `2` | Not found | Config file not found in project |
| `3` | Parse error | YAML syntax error |

#### Examples

**Basic validation:**
```bash
$ generacy validate-config
✓ Config is valid
  Project: My Project (proj_abc123xyz)
  Primary repo: github.com/acme/main-api
  Dev repos: 2
  Clone repos: 1
```

**Explicit config path:**
```bash
$ generacy validate-config --config /path/to/config.yaml
✓ Config is valid
```

**Validation failure:**
```bash
$ generacy validate-config
✗ Config validation failed

Error at project.id:
  Project ID must start with 'proj_' followed by at least 8 alphanumeric characters
  Received: "invalid-id"
  Expected: /^proj_[a-z0-9]+$/ with min length 12

Error at repos:
  Repository appears in multiple lists: github.com/acme/shared
  A repository cannot be in both 'dev' and 'clone' lists.

Exit code: 1
```

**Config not found:**
```bash
$ generacy validate-config
✗ Config file not found

Searched:
  /workspace/my-project/.generacy/config.yaml
  /workspace/.generacy/config.yaml
  /home/user/.generacy/config.yaml

No .generacy/config.yaml found in project.
Run 'generacy init' to create a config file.

Exit code: 2
```

**YAML parse error:**
```bash
$ generacy validate-config
✗ Failed to parse config file

YAML syntax error at line 12:
  unexpected character: ':'

  10 | repos:
  11 |   primary: github.com/acme/api
  12 |   dev:
     |      ^ unexpected indentation

Exit code: 3
```

**Verbose output:**
```bash
$ generacy validate-config --verbose
Finding config file...
  Checking: /workspace/my-project/.generacy/config.yaml ✓

Parsing YAML...
  Lines: 18
  Schema version: 1

Validating schema...
  ✓ project.id: "proj_abc123xyz"
  ✓ project.name: "My Project"
  ✓ repos.primary: "github.com/acme/main-api"
  ✓ repos.dev: 2 repositories
  ✓ repos.clone: 1 repository
  ✓ defaults.agent: "claude-code"
  ✓ defaults.baseBranch: "main"
  ✓ orchestrator.pollIntervalMs: 5000
  ✓ orchestrator.workerCount: 3

Validating semantic rules...
  ✓ No duplicate repositories
  ✓ Project ID format valid
  ✓ Agent name format valid

✓ Config is valid
```

**Quiet mode:**
```bash
$ generacy validate-config --quiet
# No output if valid, errors only if invalid
$ echo $?
0
```

#### Implementation Notes

**Config Discovery:**
1. If `--config` provided, use that path
2. Otherwise, walk up from CWD to find `.generacy/config.yaml`
3. Stop at repository root (`.git/` directory)
4. Respect `GENERACY_CONFIG_PATH` env var

**Error Formatting:**
- Show validation errors with field path
- Include expected vs. received values
- Suggest fixes where applicable
- Show YAML line numbers for parse errors

**TypeScript Interface:**
```typescript
interface ValidateConfigOptions {
  config?: string;
  verbose?: boolean;
  quiet?: boolean;
}

export async function validateConfigCommand(
  options: ValidateConfigOptions
): Promise<number> {
  try {
    const configPath = options.config || findConfigFile();
    if (!configPath) {
      console.error('✗ Config file not found');
      return 2;
    }

    const config = loadConfig({ configPath });

    if (!options.quiet) {
      console.log('✓ Config is valid');
      console.log(`  Project: ${config.project.name} (${config.project.id})`);
      console.log(`  Primary repo: ${config.repos.primary}`);
      if (config.repos.dev?.length) {
        console.log(`  Dev repos: ${config.repos.dev.length}`);
      }
      if (config.repos.clone?.length) {
        console.log(`  Clone repos: ${config.repos.clone.length}`);
      }
    }

    return 0;
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('✗ Config validation failed\n');
      formatValidationErrors(error);
      return 1;
    }

    if (error instanceof YAMLParseError) {
      console.error('✗ Failed to parse config file\n');
      formatParseError(error);
      return 3;
    }

    console.error('✗ Unexpected error:', error.message);
    return 1;
  }
}
```

---

### Future Command: `generacy init`

Config generation command (deferred to Epic 4.3).

#### Planned Usage

```bash
generacy init [options]
```

#### Planned Options

| Option | Type | Description |
|--------|------|-------------|
| `--project-id <id>` | string | Project ID from generacy.ai |
| `--name <name>` | string | Project name |
| `--interactive` | boolean | Interactive setup wizard |

#### Planned Example

```bash
$ generacy init --project-id proj_abc123
? Project name: My Awesome Project
? Primary repository: github.com/acme/main-api
? Add development repositories? Yes
? Dev repo 1: github.com/acme/shared-lib
? Dev repo 2: (leave blank to finish)
? Add clone-only repositories? No
? Default agent: claude-code
? Default base branch: main

✓ Created .generacy/config.yaml
  Run 'generacy validate-config' to verify
```

**Note:** This command is out of scope for Epic 4.2. Specified here for completeness.

---

## Help Output

### `generacy --help`

```
generacy - Headless workflow execution CLI for Generacy

Usage: generacy [command] [options]

Commands:
  validate-config  Validate .generacy/config.yaml file
  orchestrator     Start the orchestrator service
  worker           Start a workflow worker
  run              Run a single workflow
  setup            Setup commands for project initialization

Options:
  -h, --help       Show help
  -v, --version    Show version
  --no-color       Disable colored output

Run 'generacy <command> --help' for more information on a command.
```

### `generacy validate-config --help`

```
generacy validate-config - Validate .generacy/config.yaml file

Usage: generacy validate-config [options]

Validates the project's .generacy/config.yaml file for correctness.
Checks schema, format, and semantic rules.

Options:
  -c, --config <path>  Path to config file (default: auto-discover)
  -v, --verbose        Show detailed validation output
  -q, --quiet          Only show errors (suppress success message)
  -h, --help           Show help

Examples:
  generacy validate-config
  generacy validate-config --config /path/to/config.yaml
  generacy validate-config --verbose

Exit codes:
  0  Config is valid
  1  Validation errors found
  2  Config file not found
  3  YAML parse error

Environment variables:
  GENERACY_CONFIG_PATH  Override config file location

For more information, visit: https://generacy.ai/docs/config
```

---

## Error Message Examples

### Format Validation Errors

**Invalid Project ID:**
```
Error at project.id:
  Project ID must start with 'proj_' followed by at least 8 alphanumeric characters

  Received: "my-project"
  Expected: /^proj_[a-z0-9]+$/ with min length 12

  Example: proj_abc123xyz
```

**Invalid Repository URL:**
```
Error at repos.dev[0]:
  Repository must be in format 'github.com/owner/repo'

  Received: "https://github.com/acme/api.git"
  Expected: github.com/acme/api

  Do not include protocol (https://) or .git suffix
```

**Invalid Agent Name:**
```
Error at defaults.agent:
  Agent name must be kebab-case (lowercase alphanumeric with hyphens)

  Received: "Claude Code"
  Expected: /^[a-z0-9]+(-[a-z0-9]+)*$/

  Valid examples: claude-code, custom-agent-v2
```

### Semantic Validation Errors

**Duplicate Repository:**
```
Error at repos:
  Repository appears in multiple lists: github.com/acme/shared

  Found in:
    - repos.dev[1]
    - repos.clone[0]

  A repository cannot be in both 'dev' and 'clone' lists.
  Choose one classification per repository.
```

### YAML Parse Errors

**Syntax Error:**
```
YAML syntax error at line 12:
  unexpected character: ':'

  10 | repos:
  11 |   primary: github.com/acme/api
  12 |   dev:
     |      ^ unexpected indentation

  YAML requires consistent indentation (2 spaces recommended)
```

**Type Error:**
```
YAML type error at line 15:
  expected array, got string

  13 | repos:
  14 |   primary: github.com/acme/api
  15 |   dev: github.com/acme/lib
     |        ^^^^^^^^^^^^^^^^^^^^^^

  Did you mean:
    dev:
      - github.com/acme/lib
```

---

## Configuration File Discovery

### Discovery Algorithm

```
Start: /workspace/my-project/packages/frontend/src/
  Check: .generacy/config.yaml → Not found
  Move:  /workspace/my-project/packages/frontend/

  Check: .generacy/config.yaml → Not found
  Move:  /workspace/my-project/packages/

  Check: .generacy/config.yaml → Not found
  Move:  /workspace/my-project/

  Check: .generacy/config.yaml → Found! ✓
  Check: .git/ → Exists (repository root)

Result: /workspace/my-project/.generacy/config.yaml
```

### Environment Variable Override

```bash
# Explicit path (skips discovery)
export GENERACY_CONFIG_PATH=/custom/location/config.yaml
generacy validate-config
# Uses: /custom/location/config.yaml
```

### Not Found Error Output

```
✗ Config file not found

Searched:
  /workspace/my-project/packages/frontend/.generacy/config.yaml
  /workspace/my-project/packages/.generacy/config.yaml
  /workspace/my-project/.generacy/config.yaml

Stopped at repository root: /workspace/my-project/.git/

No .generacy/config.yaml found in project.

To create a config file:
  1. Run 'generacy init' to generate interactively
  2. See docs at https://generacy.ai/docs/config for manual setup
```

---

## Integration with CI/CD

### Validation in CI

**GitHub Actions Example:**
```yaml
name: Validate Generacy Config

on: [pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Generacy CLI
        run: npm install -g @generacy-ai/generacy

      - name: Validate config
        run: generacy validate-config
```

### Pre-commit Hook

**.git/hooks/pre-commit:**
```bash
#!/bin/bash

# Validate Generacy config before commit
if [ -f .generacy/config.yaml ]; then
  echo "Validating Generacy config..."

  if ! generacy validate-config --quiet; then
    echo "❌ Generacy config validation failed"
    echo "   Fix errors before committing"
    exit 1
  fi

  echo "✅ Generacy config is valid"
fi
```

---

## Testing Strategy

### Unit Tests

**Test File:** `packages/generacy/src/cli/__tests__/validate.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { validateConfigCommand } from '../commands/validate';

describe('validate-config command', () => {
  it('returns 0 for valid config', async () => {
    const exitCode = await validateConfigCommand({
      config: './fixtures/valid-config.yaml'
    });
    expect(exitCode).toBe(0);
  });

  it('returns 1 for invalid project ID', async () => {
    const exitCode = await validateConfigCommand({
      config: './fixtures/invalid-project-id.yaml'
    });
    expect(exitCode).toBe(1);
  });

  it('returns 2 for missing config', async () => {
    const exitCode = await validateConfigCommand({
      config: './nonexistent.yaml'
    });
    expect(exitCode).toBe(2);
  });

  it('returns 3 for YAML parse error', async () => {
    const exitCode = await validateConfigCommand({
      config: './fixtures/invalid-yaml.txt'
    });
    expect(exitCode).toBe(3);
  });

  it('shows verbose output when --verbose flag set', async () => {
    const output = captureOutput(() => {
      validateConfigCommand({
        config: './fixtures/valid-config.yaml',
        verbose: true
      });
    });

    expect(output).toContain('Finding config file');
    expect(output).toContain('Validating schema');
    expect(output).toContain('Validating semantic rules');
  });

  it('suppresses output when --quiet flag set', async () => {
    const output = captureOutput(() => {
      validateConfigCommand({
        config: './fixtures/valid-config.yaml',
        quiet: true
      });
    });

    expect(output).toBe('');
  });
});
```

### Integration Tests

**Test File:** `packages/generacy/__tests__/cli-integration.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

describe('CLI integration', () => {
  it('validates config via CLI', async () => {
    const { stdout, stderr } = await execAsync(
      'generacy validate-config --config ./fixtures/valid-config.yaml'
    );

    expect(stdout).toContain('✓ Config is valid');
    expect(stderr).toBe('');
  });

  it('shows help with --help flag', async () => {
    const { stdout } = await execAsync('generacy validate-config --help');

    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('Options:');
    expect(stdout).toContain('Examples:');
  });

  it('exits with code 1 for invalid config', async () => {
    try {
      await execAsync(
        'generacy validate-config --config ./fixtures/invalid-config.yaml'
      );
      throw new Error('Should have failed');
    } catch (error) {
      expect(error.code).toBe(1);
      expect(error.stderr).toContain('validation failed');
    }
  });
});
```

---

## Documentation Requirements

### README Section

**Location:** `packages/generacy/README.md`

**Content:**
- Config file location (`.generacy/config.yaml`)
- Discovery algorithm
- Validation command usage
- Common validation errors and fixes
- Link to full config schema documentation

### Schema Documentation

**Location:** `packages/generacy/src/config/README.md`

**Content:**
- Complete field reference
- Validation rules for each field
- Example configurations
- Migration guide (for future v2)

### CLI Help Text

All help text must be:
- Concise and actionable
- Include examples
- Show exit codes
- Reference environment variables
- Link to online docs

---

## Future Enhancements

### Planned for Later Phases

1. **Config Diff Command**
   ```bash
   generacy config diff <other-config.yaml>
   ```

2. **Config Merge Command**
   ```bash
   generacy config merge <override.yaml>
   ```

3. **Config Migration Command**
   ```bash
   generacy config migrate --to v2
   ```

4. **Config Lint Command**
   ```bash
   generacy config lint --fix
   ```

---

## References

- [Implementation Plan](./plan.md)
- [Data Model](./data-model.md)
- [Research](./research.md)
- Commander.js: https://github.com/tj/commander.js
- Chalk (colors): https://github.com/chalk/chalk
