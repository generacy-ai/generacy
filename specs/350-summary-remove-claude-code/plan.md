# Implementation Plan: Remove Claude Marketplace Plugin Install

**Feature**: Replace Claude Code marketplace plugin installation with npm package-based speckit command copying in `generacy setup build` Phase 4
**Branch**: `350-summary-remove-claude-code`
**Status**: Complete

## Summary

Simplify Phase 4 of `generacy setup build` by removing the unreliable Claude marketplace plugin registration/install mechanism and replacing it with direct file copying from the `@generacy-ai/agency-plugin-spec-kit` npm package. The new implementation uses a two-tier resolution strategy: local workspace `node_modules` first, then npm global root.

## Technical Context

**Language/Version**: TypeScript (Node.js)
**Primary Dependencies**: commander, pino (logger), node:fs, node:os, node:path
**Storage**: File system (`~/.claude/commands/`, `~/.claude.json`)
**Testing**: vitest (existing test suite at `src/__tests__/setup/build.test.ts`)
**Target Platform**: Linux (devcontainers, CI)
**Project Type**: CLI package within pnpm monorepo
**Constraints**: Must work in both tetrad-development workspace and external container environments

## Project Structure

### Documentation (this feature)

```text
specs/350-summary-remove-claude-code/
├── spec.md              # Feature specification (read-only)
├── clarifications.md    # No clarifications needed
├── plan.md              # This file
├── research.md          # Technology decisions
├── data-model.md        # Resolution strategy model
└── quickstart.md        # Testing guide
```

### Source Code (files to modify)

```text
packages/generacy/src/cli/commands/setup/build.ts   # Primary target — Phase 4 rewrite
packages/generacy/src/__tests__/setup/build.test.ts  # Update tests for new behavior
```

## Implementation Approach

### What to Remove

1. **Marketplace registration logic** (lines ~290-313 of `build.ts`)
   - `claude plugin marketplace list` check
   - `claude plugin marketplace add` calls (both local and remote variants)
   - `marketplaceRegistered` flag and branching

2. **Marketplace plugin install** (lines ~315-326)
   - `claude plugin install agency-spec-kit@generacy-marketplace` call
   - `pluginInstalled` flag and branching

3. **Old file-copy cleanup logic** (lines ~379-397)
   - The cleanup that removes old file-copy commands when marketplace succeeds — no longer needed since file copy is now the only mechanism

4. **`SPECKIT_COMMAND_FILES` constant** (lines ~254-264)
   - No longer needed for cleanup; discovery is now dynamic via `readdirSync`

### What to Add/Keep

1. **Two-tier npm package resolution** — new primary mechanism:
   - **Tier 1 (local)**: Resolve `@generacy-ai/agency-plugin-spec-kit` in local workspace `node_modules` using `require.resolve` or path probing
   - **Tier 2 (global)**: Fall back to `resolveNpmGlobalRoot()` + `@generacy-ai/agency-plugin-spec-kit/commands/`
   - Log which tier was used

2. **Command file copy**: Copy all `.md` files from resolved `commands/` directory to `~/.claude/commands/`

3. **Agency MCP server configuration** (lines ~399-452): Keep unchanged — this is independent of command installation

### Simplified Flow

```
Phase 4: installClaudeCodeIntegration()
├── Step 1: Resolve @generacy-ai/agency-plugin-spec-kit package
│   ├── Try local workspace node_modules
│   └── Try npm global root
├── Step 2: Copy .md command files to ~/.claude/commands/
│   └── Log count and resolution path used
├── Step 3: Configure Agency MCP server in ~/.claude.json (unchanged)
└── Done
```

### Resolution Strategy Detail

```typescript
// Tier 1: Local workspace resolution
// Check: {workspaceRoot}/node_modules/@generacy-ai/agency-plugin-spec-kit/commands/
// Also check: {agencyDir}/node_modules/@generacy-ai/agency-plugin-spec-kit/commands/

// Tier 2: npm global resolution
// Check: {npm root -g}/@generacy-ai/agency-plugin-spec-kit/commands/
```

The key change from the current implementation is using `@generacy-ai/agency-plugin-spec-kit` (the npm package name) instead of `@generacy-ai/agency/commands/` or the `claude-plugin-agency-spec-kit` source directory.

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| npm package not yet updated to bundle commands | Commands won't copy | Dependency noted in spec; clear error message when package not found |
| `require.resolve` fails in some Node environments | Tier 1 fails | Fall back to path probing + Tier 2 global resolution |
| Existing users have marketplace-installed commands | Potential duplicates | File copy overwrites existing files; marketplace commands live elsewhere |
