# Implementation Plan: Fix `generacy setup build` Phase 4 for External Projects

**Feature**: Add npm-based fallback for speckit slash command installation when agency source and marketplace are unavailable
**Branch**: `342-summary-generacy-setup-build`
**Status**: Complete

## Summary

Phase 4 of `generacy setup build` installs two speckit components: (1) Claude Code slash command `.md` files and (2) the Agency MCP server. Both installation paths currently require access to the private `generacy-ai/agency` repo — either via GitHub (marketplace) or local clone (file-copy). This breaks external project onboarding.

The fix adds a **third fallback path** in Phase 4 that copies `.md` command files from the globally-installed `@generacy-ai/agency` npm package. This requires a **cross-repo change**: the agency package must include the `.md` files in its npm distribution.

## Technical Context

- **Language**: TypeScript (ESM)
- **Runtime**: Node.js ≥ 20
- **Package manager**: pnpm (monorepo)
- **Framework**: Commander.js (CLI)
- **Test framework**: Vitest
- **Key file**: `packages/generacy/src/cli/commands/setup/build.ts`

## Approach: Option D (Hybrid)

Based on the spec's proposed solutions, **Option D** is the best path forward:

1. **Agency repo change** (prerequisite, separate PR): Include `.md` command files in the `@generacy-ai/agency` npm package at `commands/` (flat structure at package root)
2. **Generacy repo change** (this PR): Add npm-global fallback path in Phase 4

The npm fallback slots between the marketplace install attempt and the existing agency-source file-copy:

```
Phase 4 installation order:
  1. Marketplace plugin install (existing) → requires GitHub access
  2. File-copy from agency source (existing) → requires /workspaces/agency
  3. ★ NEW: File-copy from npm global install → requires `npm install -g @generacy-ai/agency`
  4. Log warning if all paths fail
```

## Project Structure — Files Changed

```
packages/generacy/src/cli/commands/setup/
├── build.ts                    # ← MODIFY: Add npm-global fallback in installClaudeCodeIntegration()
└── build.test.ts               # ← CREATE: Unit tests for the new fallback path
```

## Implementation Details

### Change 1: Add npm-global fallback in `installClaudeCodeIntegration()`

**File**: `packages/generacy/src/cli/commands/setup/build.ts`

The current logic at lines 316-342 is:
```
if (!pluginInstalled && existsSync(config.agencyDir)) {
  // file-copy from agency source
} else if (!pluginInstalled) {
  logger.info('Skipping file-copy fallback — agency source not available');
}
```

Change to a three-tier fallback:
```
if (!pluginInstalled && existsSync(config.agencyDir)) {
  // Existing: file-copy from agency source dir
} else if (!pluginInstalled) {
  // NEW: file-copy from npm global @generacy-ai/agency/commands/
  const globalRoot = execSafe('npm root -g');
  if (globalRoot.ok && globalRoot.stdout) {
    const npmCommandsDir = join(globalRoot.stdout.trim(), '@generacy-ai', 'agency', 'commands');
    if (existsSync(npmCommandsDir)) {
      // copy .md files to ~/.claude/commands/
    }
  }
  if (!pluginInstalled && no files copied) {
    logger.warn('No speckit commands available — marketplace, source, and npm fallbacks all failed');
  }
}
```

Key implementation notes:
- Reuse the existing `execSafe('npm root -g')` pattern already used at line 377 for MCP CLI resolution
- Extract the npm root lookup into a shared helper to avoid duplicate calls
- The `commands/` path assumes the agency package ships `.md` files at `<pkg-root>/commands/` (flat structure — Option A from clarifications Q2)

### Change 2: Extract `resolveNpmGlobalRoot()` helper

To avoid calling `npm root -g` twice (once for commands, once for MCP CLI), extract a small helper:

```typescript
function resolveNpmGlobalRoot(): string | null {
  const result = execSafe('npm root -g');
  if (result.ok && result.stdout) {
    return result.stdout.trim();
  }
  return null;
}
```

Both the command file fallback and the MCP CLI resolution (line 377) will use this.

### Change 3: Unit tests

**File**: `packages/generacy/src/cli/commands/setup/build.test.ts`

Test scenarios:
- npm-global fallback copies `.md` files when agency source is unavailable
- npm-global fallback is skipped when marketplace plugin installs successfully
- npm-global fallback logs warning when `npm root -g` fails
- npm-global fallback logs warning when commands dir doesn't exist in npm package
- Cleanup of old file-copy commands still works after marketplace install

## Dependency: Agency Repo Change

This implementation assumes a prerequisite change in `generacy-ai/agency`:
- Add `"commands"` to the `files` field in `packages/agency/package.json` (or the claude-plugin-agency-spec-kit package)
- Copy/symlink the `.md` files from `packages/claude-plugin-agency-spec-kit/commands/` to `packages/agency/commands/` during the build step
- Publish a new version of `@generacy-ai/agency` to npm

This is tracked as a **cross-repo dependency** and should be completed before testing this PR end-to-end.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Agency npm package doesn't include commands/ yet | Fallback gracefully logs warning, doesn't crash |
| `npm root -g` returns unexpected path | Already validated by existing MCP CLI resolution code |
| Race between marketplace and file-copy commands | Cleanup step (lines 345-362) removes duplicates when marketplace succeeds |

## Testing Strategy

1. **Unit tests**: Mock `existsSync`, `execSafe`, `copyFileSync` to test all fallback paths
2. **Integration test**: Run `generacy setup build` in a container without agency source, verify commands are copied from npm global
3. **Regression**: Verify existing marketplace and source-copy paths still work unchanged
