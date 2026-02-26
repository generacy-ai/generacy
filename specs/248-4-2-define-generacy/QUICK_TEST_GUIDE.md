# Quick Test Guide

**Quick reference for manually testing the `generacy validate` command.**

## Setup

```bash
# Build the CLI
cd /workspaces/generacy/packages/generacy
pnpm build

# Create alias (optional, for convenience)
alias generacy="node /workspaces/generacy/packages/generacy/bin/generacy.js"
```

## Quick Smoke Tests

### 1. Basic Validation (30 seconds)

```bash
# Test with minimal config
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml

# Expected: ✓ Configuration is valid

# Test with full config
generacy validate /workspaces/generacy/packages/generacy/examples/config-full.yaml

# Expected: Shows all fields (dev repos, clone repos, defaults, orchestrator)
```

### 2. Auto-Discovery (1 minute)

```bash
# Create test directory
mkdir -p /tmp/test-discovery/nested/dir
cd /tmp/test-discovery
mkdir .generacy
cp /workspaces/generacy/packages/generacy/examples/config-minimal.yaml .generacy/config.yaml
git init

# Test from root
generacy validate --quiet
# Expected: ✓ Valid

# Test from nested directory
cd nested/dir
generacy validate --quiet
# Expected: ✓ Valid (found in parent)

# Cleanup
rm -rf /tmp/test-discovery
```

### 3. Error Messages (2 minutes)

```bash
# Test missing required field
cat > /tmp/test-error.yaml << 'EOF'
schemaVersion: "1"
project:
  name: "Missing ID"
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/test-error.yaml
# Expected: Error message showing "project.id: Required"

# Test invalid format
cat > /tmp/test-error.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "bad_format"
  name: "Test"
repos:
  primary: "https://github.com/test/repo"
EOF

generacy validate /tmp/test-error.yaml
# Expected: Error about project ID format AND repo URL format

rm /tmp/test-error.yaml
```

### 4. Exit Codes (30 seconds)

```bash
# Success
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml > /dev/null 2>&1
echo $?
# Expected: 0

# Failure
generacy validate /tmp/does-not-exist.yaml > /dev/null 2>&1
echo $?
# Expected: 1
```

### 5. Output Modes (30 seconds)

```bash
# Quiet mode
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml --quiet
# Expected: ✓ Valid

# JSON mode
generacy validate /workspaces/generacy/packages/generacy/examples/config-minimal.yaml --json | jq .valid
# Expected: true
```

## Common Issues to Check

### Issue: Project ID too short
```bash
# This will FAIL (project ID must be >= 12 chars)
cat > /tmp/short-id.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_abc"
  name: "Test"
repos:
  primary: "github.com/test/repo"
EOF

generacy validate /tmp/short-id.yaml
# Expected: Error about minimum 12 characters

rm /tmp/short-id.yaml
```

### Issue: Repository with protocol
```bash
# This will FAIL (no https://)
cat > /tmp/bad-repo.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_test12345"
  name: "Test"
repos:
  primary: "https://github.com/test/repo"
EOF

generacy validate /tmp/bad-repo.yaml
# Expected: Error about repository format

rm /tmp/bad-repo.yaml
```

### Issue: Out of range values
```bash
# This will FAIL (workerCount max is 20)
cat > /tmp/bad-workers.yaml << 'EOF'
schemaVersion: "1"
project:
  id: "proj_test12345"
  name: "Test"
repos:
  primary: "github.com/test/repo"
orchestrator:
  workerCount: 25
EOF

generacy validate /tmp/bad-workers.yaml
# Expected: Error about max 20 workers

rm /tmp/bad-workers.yaml
```

## Known Issues

### GENERACY_CONFIG_PATH Not Working in Auto-Discovery

```bash
# This DOES NOT work currently (known bug)
export GENERACY_CONFIG_PATH=/path/to/config.yaml
generacy validate
# Bug: Ignores env var, tries to auto-discover

# Workaround: Use explicit path
generacy validate $GENERACY_CONFIG_PATH
# This works
```

## Full Test Run

To run the complete test suite:

```bash
# See MANUAL_TEST_SCRIPT.md for the full test suite
cat /workspaces/generacy/specs/248-4-2-define-generacy/MANUAL_TEST_SCRIPT.md
```

## Test Results

See `TEST_RESULTS.md` for complete automated test results.
