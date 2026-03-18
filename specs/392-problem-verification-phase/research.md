# Research: Discovery-Based Workflow Verification

## Technology Decision

### Use `build.validate` tool (from agency#323)

**Rationale**: The `build.validate` tool encapsulates all verification logic:
- Package manager auto-detection (pnpm, npm, yarn, bun)
- Script discovery from `package.json` (lint, test, format:check, typecheck, build, etc.)
- Monorepo-aware execution
- Per-script result reporting

**Alternative considered**: Inline shell script with detection logic in the YAML itself (e.g., checking for `pnpm-lock.yaml`, `yarn.lock`, etc.). Rejected because:
- Duplicates logic that `build.validate` already implements
- Harder to maintain across multiple workflow files
- Doesn't discover scripts dynamically

### Single step vs. multiple steps

**Decision**: Single `build.validate` step replaces both `run-tests` and `run-lint`.

**Rationale**: `build.validate` discovers and runs all validation scripts in one invocation. Splitting into multiple calls would defeat the purpose of auto-discovery and could lead to the same hardcoding problem we're solving.

## Implementation Pattern

This is a direct substitution pattern:
1. Remove the existing `verification.check` steps
2. Add a single `build.validate` step
3. Preserve `continueOnError: true` behavior

No new abstractions, helpers, or configuration are needed.

## Current State Analysis

### `speckit-feature.yaml` (Phase 7)
- Already partially mitigates the problem with `--if-present` flags and monorepo detection
- Uses inline shell conditionals to check for `pnpm-workspace.yaml`
- Still hardcodes `pnpm` as the package manager

### `speckit-bugfix.yaml` (Phase 6)
- Fully hardcoded: `pnpm run test` and `pnpm run lint`
- No `--if-present`, no monorepo detection
- Most fragile of the two files
