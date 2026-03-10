# Implementation Plan: Skip source builds for external projects

**Feature**: Build phase should skip source builds for external projects
**Branch**: `335-problem-generacy-setup-build`
**Status**: Complete

## Summary

Make `generacy setup build` succeed in external project environments where source repos (`/workspaces/agency`, `/workspaces/latency`, `/workspaces/generacy`) are not present. The build command already has directory-existence guards in Phases 2 and 3, but the logging is misleading (uses `warn` for an expected skip) and Phase 4 runs unnecessarily noisy fallback logic. The fix adds environment detection, improves log messages, and ensures a clean exit for external projects.

The `setup-speckit.sh` script referenced in the issue no longer exists — it was replaced by the devcontainer feature `install.sh` which installs packages from npm (FR-004 is already resolved).

## Technical Context

- **Language**: TypeScript 5.x (Node.js ≥20)
- **CLI framework**: Commander.js
- **Testing**: Vitest with mocked fs/child_process
- **Primary file**: `packages/generacy/src/cli/commands/setup/build.ts`
- **Test file**: `packages/generacy/src/__tests__/setup/build.test.ts`

## Current State Analysis

The code already has partial handling:
- `buildAgency()` (Phase 2): Returns early if `/workspaces/agency` doesn't exist → logs at `warn` level
- `buildGeneracy()` (Phase 3): Returns early if `/workspaces/generacy` doesn't exist → logs at `warn` level
- `installClaudeCodeIntegration()` (Phase 4): Tries marketplace install, falls back to file copy from agency repo, configures MCP — all with graceful degradation but noisy warnings

## Changes Required

### 1. Add environment detection helper

Add an `isExternalProject()` helper that checks whether we're in a multi-repo dev environment or an external project:

```typescript
function isExternalProject(config: BuildConfig): boolean {
  return !existsSync(config.agencyDir) && !existsSync(config.latencyDir);
}
```

This is used to provide clearer log messages and skip Phase 4 MCP configuration.

### 2. Improve Phase 2 skip logging (build.ts lines 128-133)

Change from `warn` to `info` when agency dir is missing, with a message indicating installed packages are being used:

```typescript
// Before
logger.warn({ dir: config.agencyDir }, 'Agency directory not found, skipping');

// After
logger.info('Skipping source build for agency/latency — using installed packages');
```

### 3. Improve Phase 3 skip logging (build.ts lines 203-208)

Same treatment:

```typescript
// Before
logger.warn({ dir: config.generacyDir }, 'Generacy directory not found, skipping');

// After
logger.info('Skipping source build for generacy — using installed packages');
```

### 4. Guard Phase 4 MCP configuration for external projects

In `installClaudeCodeIntegration()`, Phase 4 should still attempt marketplace plugin install (it works without source repos), but skip the file-copy fallback and MCP server configuration when agency isn't built from source. The marketplace install path is the primary mechanism for external projects.

In the main action handler, Phase 4 should still run (for marketplace install) but the function should be aware of whether agency was built from source.

### 5. Update Phase 4 fallback behavior

When agency dir doesn't exist:
- Still attempt marketplace plugin install (this is independent of source builds)
- Skip the file-copy fallback (no source to copy from)
- Skip MCP server configuration with an `info` message instead of `warn`

### 6. Update tests

Update `build.test.ts` to:
- Verify new log messages when source dirs are missing
- Verify info-level (not warn-level) logging for expected skips
- Add test case for "external project" scenario: no source repos, marketplace install succeeds, build exits 0
- Update existing tests that assert warn-level messages for missing dirs

## Project Structure

```
packages/generacy/src/cli/commands/setup/build.ts   # Main implementation (modify)
packages/generacy/src/__tests__/setup/build.test.ts  # Tests (modify)
```

## Risk Assessment

- **Low risk**: Changes are additive guards around existing skip logic
- **No breaking changes**: Multi-repo dev workflow is unchanged when source dirs exist
- **Backwards compatible**: Existing CLI flags (`--skip-agency`, `--skip-generacy`) continue to work
