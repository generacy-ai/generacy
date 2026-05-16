# Implementation Plan: Fix control-plane daemon cluster.yaml path resolution

**Feature**: Control-plane daemon resolves cluster.yaml relative to CWD, missing the project subdir
**Branch**: `630-summary-control-plane-daemon`
**Status**: Complete

## Summary

The `getGeneracyDir()` function in `packages/control-plane/src/routes/app-config.ts` uses a 2-tier fallback that fails in production: `GENERACY_PROJECT_DIR` (not set) → CWD-relative (resolves to `/workspaces/.generacy`, which doesn't exist). The fix implements a 4-tier discovery strategy with caching.

## Technical Context

**Language/Version**: TypeScript, Node.js >=22, ESM
**Primary Dependencies**: `node:fs/promises`, `node:path`, `yaml`, `zod`
**Storage**: Filesystem (cluster.yaml in `.generacy/` dir)
**Testing**: Vitest (unit tests)
**Target Platform**: Linux container (cluster-base image)
**Project Type**: Monorepo package (`packages/control-plane`)

## Project Structure

### Documentation (this feature)

```text
specs/630-summary-control-plane-daemon/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Technical research
├── data-model.md        # Type definitions
└── quickstart.md        # Usage/testing guide
```

### Source Code Changes

```text
packages/control-plane/
├── src/
│   ├── routes/
│   │   └── app-config.ts          # MODIFY: replace getGeneracyDir() with 4-tier discovery
│   └── services/
│       └── project-dir-resolver.ts # NEW: extracted path resolution with caching + glob
└── tests/
    └── unit/
        └── project-dir-resolver.test.ts  # NEW: unit tests for all 4 tiers
```

## Implementation Approach

### 1. Extract `resolveProjectDir()` into a dedicated service module

Create `packages/control-plane/src/services/project-dir-resolver.ts` with the 4-tier fallback:

1. **Tier 1**: `GENERACY_PROJECT_DIR` env var → return `${value}/.generacy`
2. **Tier 2**: `WORKSPACE_DIR` env var → return `${WORKSPACE_DIR}/.generacy`
3. **Tier 3**: Glob `/workspaces/*/.generacy/cluster.yaml` → pick single match, extract parent
4. **Tier 4**: CWD-relative `.generacy` → backwards-compatible last resort

Key behaviors:
- Result is **cached** after first resolution (FR-005)
- Each fallback tier emits a `console.warn` or structured log
- Multiple glob matches → warning + fall back to Tier 4
- Zero glob matches → fall back to Tier 4
- Glob uses `node:fs/promises` `readdir` + filter (no external glob dep needed)

### 2. Modify `app-config.ts` to use the new resolver

Replace the inline `getGeneracyDir()` (lines 42-46) with a call to `resolveProjectDir()`. The `readManifest()` function and all other callers of `getGeneracyDir()` benefit automatically.

### 3. Unit tests

Test all 4 tiers in isolation using env var manipulation and filesystem mocks/temp dirs.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Extract to separate module | Testable in isolation; single responsibility |
| Cache at module level | FR-005; path won't change during daemon lifetime |
| Use `readdir` not `glob` | Avoid adding `glob` dep for a single shallow scan |
| Log on every fallback | SC-003; operators can diagnose path issues |
| No external dependencies | Aligns with control-plane's `node:http`-only pattern |

## Risks

| Risk | Mitigation |
|------|-----------|
| Glob scan slow on large `/workspaces/` | Single shallow readdir + stat; bounded by workspace count |
| Race between daemon start and project clone | Tier 4 CWD fallback is harmless; daemon returns `null` until yaml exists |
| `WORKSPACE_DIR` not set | Just falls through to Tier 3; logged |
