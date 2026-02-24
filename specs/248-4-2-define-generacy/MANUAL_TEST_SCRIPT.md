# Manual CLI Testing Script

**Task**: T022 - Manual CLI testing
**Date**: 2026-02-24
**Tester**: _________________

## Prerequisites

- [ ] CLI package built: `cd /workspaces/generacy/packages/generacy && pnpm build`
- [ ] CLI is accessible via: `node /workspaces/generacy/packages/generacy/bin/generacy.js`

## Test Environment Setup

```bash
# Navigate to test directory
cd /workspaces/generacy/specs/248-4-2-define-generacy

# Create alias for easier testing
alias generacy="node /workspaces/generacy/packages/generacy/bin/generacy.js"
```

---

## Test Suite 1: Validate Config in Real Project

### Test 1.1: Validate with explicit path (minimal config)
**Objective**: Test explicit path argument with minimal valid config

```bash
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml
```

**Expected Output**:
```
✓ Configuration is valid

Config file: /workspaces/generacy/packages/generacy/examples/config-minimal.yaml

Project:
  ID: proj_abc123
  Name: My Project

Repositories:
  Primary: github.com/myorg/my-repo
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 1.2: Validate with explicit path (full config)
**Objective**: Test explicit path argument with all optional fields

```bash
generacy validate /workspaces/generacy/packages/generacy/examples/config-full.yaml
```

**Expected Output**:
```
✓ Configuration is valid

Config file: /workspaces/generacy/packages/generacy/examples/config-full.yaml

Project:
  ID: proj_complete123
  Name: Complete Example Project

Repositories:
  Primary: github.com/example/main-repo
  Dev (3):
    - github.com/example/shared-library
    - github.com/example/microservice-a
    - github.com/example/microservice-b
  Clone (3):
    - github.com/example/design-system
    - github.com/example/internal-docs
    - github.com/public/external-api

Defaults:
  Agent: claude-code
  Base Branch: main

Orchestrator:
  Poll Interval: 5000ms
  Worker Count: 3
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 1.3: Validate with --quiet flag
**Objective**: Test quiet mode only outputs errors

```bash
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml --quiet
```

**Expected Output**:
```
✓ Valid
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 1.4: Validate with --json flag
**Objective**: Test JSON output format

```bash
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml --json
```

**Expected Output**: Valid JSON with structure:
```json
{
  "valid": true,
  "configPath": "/workspaces/generacy/packages/generacy/examples/config-minimal.yaml",
  "config": {
    "schemaVersion": "1",
    "project": {
      "id": "proj_abc123",
      "name": "My Project"
    },
    "repos": {
      "primary": "github.com/myorg/my-repo"
    }
  }
}
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

## Test Suite 2: Discovery from Nested Directories

### Setup: Create test directory structure
```bash
# Create nested test structure
mkdir -p /tmp/generacy-test/a/b/c
cd /tmp/generacy-test

# Create config at root
mkdir -p .generacy
cp /workspaces/generacy/packages/generacy/examples/config-minimal.yaml .generacy/config.yaml

# Initialize git (for discovery boundary)
git init
```

### Test 2.1: Auto-discover from root directory
**Objective**: Verify discovery from directory containing .generacy/

```bash
cd /tmp/generacy-test
generacy validate
```

**Expected Output**:
```
Searching for config file...
Found config file
✓ Configuration is valid

Config file: /tmp/generacy-test/.generacy/config.yaml
[... rest of config summary ...]
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 2.2: Auto-discover from nested directory (1 level)
**Objective**: Verify discovery walks up 1 directory level

```bash
cd /tmp/generacy-test/a
generacy validate
```

**Expected Output**:
```
Searching for config file...
Found config file
✓ Configuration is valid

Config file: /tmp/generacy-test/.generacy/config.yaml
[... rest of config summary ...]
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 2.3: Auto-discover from deeply nested directory (3 levels)
**Objective**: Verify discovery walks up multiple directory levels

```bash
cd /tmp/generacy-test/a/b/c
generacy validate
```

**Expected Output**:
```
Searching for config file...
Found config file
✓ Configuration is valid

Config file: /tmp/generacy-test/.generacy/config.yaml
[... rest of config summary ...]
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 2.4: Discovery stops at git repository root
**Objective**: Verify discovery doesn't search outside git repo

```bash
cd /tmp/generacy-test/a/b/c
rm -rf /tmp/generacy-test/.generacy  # Remove config
generacy validate
```

**Expected Output** (error message):
```
Validation failed:

Config file not found. Searched in:
  - /tmp/generacy-test/a/b/c/.generacy/config.yaml
  - /tmp/generacy-test/a/b/.generacy/config.yaml
  - /tmp/generacy-test/a/.generacy/config.yaml
  - /tmp/generacy-test/.generacy/config.yaml

Create a config file at: /tmp/generacy-test/a/b/c/.generacy/config.yaml
```

**Exit Code**: `echo $?` should output `1`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Cleanup Test Suite 2
```bash
rm -rf /tmp/generacy-test
```

---

## Test Suite 3: Helpful Error Messages

### Setup: Create test configs
```bash
mkdir -p /tmp/generacy-errors
cd /tmp/generacy-errors
```

### Test 3.1: Missing required field (project.id)
**Objective**: Verify schema validation error is helpful

```bash
cat > /tmp/generacy-errors/missing-id.yaml << 'EOF'
schemaVersion: "1"
project:
  name: "Test Project"
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/generacy-errors/missing-id.yaml
```

**Expected Output**:
```
Validation failed:

Schema validation failed: /tmp/generacy-errors/missing-id.yaml

Validation errors:
  - project.id: Required
```

**Exit Code**: `echo $?` should output `1`

**Error is Helpful**:
- [ ] Clearly identifies missing field
- [ ] Shows exact path (project.id)
- [ ] Explains issue (Required)

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 3.2: Invalid project ID format
**Objective**: Verify semantic validation error is helpful

```bash
cat > /tmp/generacy-errors/invalid-id.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "invalid_format"
  name: "Test Project"
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/generacy-errors/invalid-id.yaml
```

**Expected Output**:
```
Validation failed:

Semantic validation failed:

Invalid project ID format: invalid_format
Expected format: proj_{alphanumeric}, e.g., proj_abc123
```

**Exit Code**: `echo $?` should output `1`

**Error is Helpful**:
- [ ] Identifies invalid value
- [ ] Explains expected format
- [ ] Provides example

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 3.3: Invalid repository URL format
**Objective**: Verify repository format validation

```bash
cat > /tmp/generacy-errors/invalid-repo.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_test123"
  name: "Test Project"
repos:
  primary: "https://github.com/test/repo"
EOF

generacy validate /tmp/generacy-errors/invalid-repo.yaml
```

**Expected Output**:
```
Validation failed:

Semantic validation failed:

Invalid repository URL: https://github.com/test/repo
Expected format: github.com/{owner}/{repo} (no protocol, no .git suffix)
```

**Exit Code**: `echo $?` should output `1`

**Error is Helpful**:
- [ ] Identifies invalid URL
- [ ] Explains correct format
- [ ] Mentions common mistakes (protocol, .git)

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 3.4: Invalid YAML syntax
**Objective**: Verify YAML parsing error is helpful

```bash
cat > /tmp/generacy-errors/bad-yaml.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_test123"
  name: "Test Project"
    invalid indentation
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/generacy-errors/bad-yaml.yaml
```

**Expected Output**:
```
Validation failed:

Failed to parse YAML: /tmp/generacy-errors/bad-yaml.yaml

[YAML parser error message about indentation]
```

**Exit Code**: `echo $?` should output `1`

**Error is Helpful**:
- [ ] Identifies it as a YAML parsing error
- [ ] Shows file path
- [ ] Includes parser's error details

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 3.5: File not found
**Objective**: Verify missing file error is helpful

```bash
generacy validate /tmp/generacy-errors/does-not-exist.yaml
```

**Expected Output**:
```
Validation failed:

Config file not found. Searched in:
  - /tmp/generacy-errors/does-not-exist.yaml

Create a config file at: /tmp/generacy-errors/does-not-exist.yaml
```

**Exit Code**: `echo $?` should output `1`

**Error is Helpful**:
- [ ] Clearly states file not found
- [ ] Shows searched path
- [ ] Suggests creating file

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 3.6: Out-of-range workerCount
**Objective**: Verify range validation

```bash
cat > /tmp/generacy-errors/invalid-workers.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_test123"
  name: "Test Project"
repos:
  primary: "github.com/test/repo"
orchestrator:
  workerCount: 25
EOF

generacy validate /tmp/generacy-errors/invalid-workers.yaml
```

**Expected Output**:
```
Validation failed:

Schema validation failed: /tmp/generacy-errors/invalid-workers.yaml

Validation errors:
  - orchestrator.workerCount: Number must be less than or equal to 20
```

**Exit Code**: `echo $?` should output `1`

**Error is Helpful**:
- [ ] Shows exact field path
- [ ] Explains constraint violation
- [ ] Specifies maximum value

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 3.7: Invalid pollIntervalMs (below minimum)
**Objective**: Verify minimum value validation

```bash
cat > /tmp/generacy-errors/invalid-poll.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_test123"
  name: "Test Project"
repos:
  primary: "github.com/test/repo"
orchestrator:
  pollIntervalMs: 1000
EOF

generacy validate /tmp/generacy-errors/invalid-poll.yaml
```

**Expected Output**:
```
Validation failed:

Schema validation failed: /tmp/generacy-errors/invalid-poll.yaml

Validation errors:
  - orchestrator.pollIntervalMs: Number must be greater than or equal to 5000
```

**Exit Code**: `echo $?` should output `1`

**Error is Helpful**:
- [ ] Shows exact field path
- [ ] Explains minimum constraint
- [ ] Specifies minimum value (5000)

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Cleanup Test Suite 3
```bash
rm -rf /tmp/generacy-errors
```

---

## Test Suite 4: Environment Variable Override

### Test 4.1: GENERACY_CONFIG_PATH overrides auto-discovery
**Objective**: Verify environment variable takes precedence

```bash
# Setup
mkdir -p /tmp/generacy-env-test/.generacy
mkdir -p /tmp/generacy-env-override

# Create different configs
cat > /tmp/generacy-env-test/.generacy/config.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_autodiscovered"
  name: "Auto Discovered Config"
repos:
  primary: "github.com/test/auto"
EOF

cat > /tmp/generacy-env-override/override.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_override"
  name: "Environment Override Config"
repos:
  primary: "github.com/test/override"
EOF

# Test from directory with .generacy/config.yaml
cd /tmp/generacy-env-test
GENERACY_CONFIG_PATH=/tmp/generacy-env-override/override.yaml generacy validate
```

**Expected Output**:
```
✓ Configuration is valid

Config file: /tmp/generacy-env-override/override.yaml

Project:
  ID: proj_override
  Name: Environment Override Config

Repositories:
  Primary: github.com/test/override
```

**Verification**:
- [ ] Uses override config (proj_override), not auto-discovered (proj_autodiscovered)

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 4.2: GENERACY_CONFIG_PATH with non-existent file
**Objective**: Verify helpful error when env var points to missing file

```bash
cd /tmp/generacy-env-test
GENERACY_CONFIG_PATH=/tmp/does-not-exist.yaml generacy validate
```

**Expected Output**:
```
Validation failed:

Config file not found. Searched in:
  - /tmp/does-not-exist.yaml

Create a config file at: /tmp/does-not-exist.yaml
```

**Exit Code**: `echo $?` should output `1`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 4.3: GENERACY_CONFIG_PATH with --quiet
**Objective**: Verify env var works with quiet mode

```bash
GENERACY_CONFIG_PATH=/tmp/generacy-env-override/override.yaml generacy validate --quiet
```

**Expected Output**:
```
✓ Valid
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 4.4: GENERACY_CONFIG_PATH with --json
**Objective**: Verify env var works with JSON output

```bash
GENERACY_CONFIG_PATH=/tmp/generacy-env-override/override.yaml generacy validate --json | jq -r '.config.project.id'
```

**Expected Output**:
```
proj_override
```

**Exit Code**: `echo $?` should output `0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Cleanup Test Suite 4
```bash
rm -rf /tmp/generacy-env-test /tmp/generacy-env-override
```

---

## Test Suite 5: Exit Codes Verification

### Test 5.1: Success exit code (valid config)
**Objective**: Verify exit code 0 on success

```bash
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml
echo "Exit code: $?"
```

**Expected Output**: `Exit code: 0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 5.2: Error exit code (schema validation failed)
**Objective**: Verify exit code 1 on schema error

```bash
cat > /tmp/schema-error.yaml << 'EOF'
schemaVersion: "1"
project:
  name: "Missing ID"
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/schema-error.yaml
echo "Exit code: $?"
rm /tmp/schema-error.yaml
```

**Expected Output**: `Exit code: 1`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 5.3: Error exit code (semantic validation failed)
**Objective**: Verify exit code 1 on semantic error

```bash
cat > /tmp/semantic-error.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "bad_format"
  name: "Invalid ID Format"
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/semantic-error.yaml
echo "Exit code: $?"
rm /tmp/semantic-error.yaml
```

**Expected Output**: `Exit code: 1`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 5.4: Error exit code (file not found)
**Objective**: Verify exit code 1 when file missing

```bash
generacy validate /tmp/does-not-exist.yaml
echo "Exit code: $?"
```

**Expected Output**: `Exit code: 1`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 5.5: Error exit code (YAML parse error)
**Objective**: Verify exit code 1 on YAML syntax error

```bash
cat > /tmp/yaml-error.yaml << 'EOF'
schemaVersion: "1"
project: {{{ invalid
EOF

generacy validate /tmp/yaml-error.yaml
echo "Exit code: $?"
rm /tmp/yaml-error.yaml
```

**Expected Output**: `Exit code: 1`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 5.6: Exit code with --json (success)
**Objective**: Verify exit code 0 with JSON output on success

```bash
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml --json > /dev/null
echo "Exit code: $?"
```

**Expected Output**: `Exit code: 0`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

### Test 5.7: Exit code with --json (error)
**Objective**: Verify exit code 1 with JSON output on error

```bash
cat > /tmp/json-error.yaml << 'EOF'
schemaVersion: "1"
project:
  name: "Missing ID"
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/json-error.yaml --json > /dev/null
echo "Exit code: $?"
rm /tmp/json-error.yaml
```

**Expected Output**: `Exit code: 1`

- [ ] Pass
- [ ] Fail (describe issue): _________________

---

## Summary

### Results Overview

**Total Tests**: 30

| Test Suite | Passed | Failed | Notes |
|------------|--------|--------|-------|
| 1. Validate Config in Real Project | ___/4 | ___/4 | |
| 2. Discovery from Nested Directories | ___/4 | ___/4 | |
| 3. Helpful Error Messages | ___/7 | ___/7 | |
| 4. Environment Variable Override | ___/4 | ___/4 | |
| 5. Exit Codes Verification | ___/7 | ___/7 | |
| **TOTAL** | ___/30 | ___/30 | |

### Critical Issues Found

1. _________________
2. _________________
3. _________________

### Minor Issues Found

1. _________________
2. _________________
3. _________________

### Recommendations

- _________________
- _________________
- _________________

### Sign-off

**Tester**: _________________
**Date**: _________________
**Status**: [ ] Passed [ ] Failed [ ] Needs Review
