# Test Fixtures Summary

This document provides a complete inventory of all test fixtures created for the generacy config validation system.

## Task Requirements (T020)

✅ Create valid minimal config fixture
✅ Create valid full config fixture
✅ Create invalid configs for error cases
✅ Create directory structure for discovery tests

## Fixture Inventory

### Valid Configurations (9 fixtures)

1. **valid-minimal.yaml** - Bare minimum required fields
2. **valid-full.yaml** - Complete config with all optional fields
3. **valid-schema-version-explicit.yaml** - Minimal with explicit schema version
4. **valid-with-defaults.yaml** - Partial config with defaults section
5. **valid-with-orchestrator.yaml** - Partial config with orchestrator section
6. **valid-dev-only.yaml** - Primary + dev repos (no clone)
7. **valid-clone-only.yaml** - Primary + clone repos (no dev)
8. **valid-empty-optional-arrays.yaml** - Explicitly empty dev/clone arrays
9. **discovery-test/.generacy/config.yaml** - Config for discovery algorithm tests

### Invalid Configurations (13 fixtures)

#### Schema Validation Errors (10 fixtures)

**Project Configuration:**
1. **invalid-project-id.yaml** - Doesn't match `proj_{alphanumeric}` format
2. **invalid-project-id-too-short.yaml** - Less than 12 characters
3. **invalid-project-name-too-long.yaml** - Exceeds 255 characters

**Repository URLs:**
4. **invalid-repo-url-format.yaml** - Includes protocol (https://)
5. **invalid-repo-url-git-suffix.yaml** - Ends with .git

**Defaults:**
6. **invalid-agent-format.yaml** - Not kebab-case format
7. **invalid-empty-base-branch.yaml** - Empty string

**Orchestrator:**
8. **invalid-orchestrator-poll-interval.yaml** - Below 5000ms minimum
9. **invalid-orchestrator-worker-count.yaml** - Exceeds maximum of 20

**Parse Errors:**
10. **invalid-yaml-syntax.yaml** - Malformed YAML syntax

#### Semantic Validation Errors (3 fixtures)

11. **invalid-duplicate-repos.yaml** - Repo in both dev and clone lists
12. **invalid-primary-in-dev.yaml** - Primary repo also in dev list
13. **invalid-primary-in-clone.yaml** - Primary repo also in clone list

### Directory Structure

```
fixtures/
├── README.md                              # Documentation
├── FIXTURES_SUMMARY.md                    # This file
├── valid-*.yaml                           # 8 valid config files
├── invalid-*.yaml                         # 13 invalid config files
└── discovery-test/                        # Discovery algorithm tests
    ├── .generacy/
    │   └── config.yaml                    # Config at root
    ├── nested/
    │   └── deep/                          # Nested test directory
    └── README.md                          # Discovery test docs
```

## Test Coverage Matrix

| Schema Rule | Valid Fixture | Invalid Fixture |
|-------------|--------------|-----------------|
| Minimal required fields | valid-minimal.yaml | - |
| All optional fields | valid-full.yaml | - |
| Schema version default | valid-minimal.yaml | - |
| Schema version explicit | valid-schema-version-explicit.yaml | - |
| Project ID format | valid-minimal.yaml | invalid-project-id.yaml |
| Project ID length | valid-minimal.yaml | invalid-project-id-too-short.yaml |
| Project name length | valid-minimal.yaml | invalid-project-name-too-long.yaml |
| Repository URL format | valid-minimal.yaml | invalid-repo-url-format.yaml |
| Repository .git suffix | valid-minimal.yaml | invalid-repo-url-git-suffix.yaml |
| Agent kebab-case | valid-with-defaults.yaml | invalid-agent-format.yaml |
| Base branch non-empty | valid-with-defaults.yaml | invalid-empty-base-branch.yaml |
| Poll interval minimum | valid-with-orchestrator.yaml | invalid-orchestrator-poll-interval.yaml |
| Worker count range | valid-with-orchestrator.yaml | invalid-orchestrator-worker-count.yaml |
| Dev array optional | valid-clone-only.yaml | - |
| Clone array optional | valid-dev-only.yaml | - |
| Empty arrays valid | valid-empty-optional-arrays.yaml | - |
| No duplicate repos | valid-full.yaml | invalid-duplicate-repos.yaml |
| Primary not in dev | valid-full.yaml | invalid-primary-in-dev.yaml |
| Primary not in clone | valid-full.yaml | invalid-primary-in-clone.yaml |
| YAML parse errors | valid-minimal.yaml | invalid-yaml-syntax.yaml |

## Validation Status

All fixtures have been tested and verified:

✅ Valid fixtures parse successfully
✅ Invalid fixtures throw appropriate errors
✅ Error types match expectations (ConfigSchemaError, ConfigValidationError, ConfigParseError)
✅ Discovery test structure is in place
✅ Documentation is complete

## Usage Examples

See `README.md` in this directory for code examples of how to use these fixtures in tests.
