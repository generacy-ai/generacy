# Feature Specification: Remove Legacy `@generacy-ai/templates` Package

**Branch**: `296-summary-generacy-ai-templates` | **Date**: 2026-03-04 | **Status**: Draft

## Summary

The `@generacy-ai/templates` package (`packages/templates/`) contains a Handlebars-based template rendering system for generating devcontainer files (Dockerfile.hbs, docker-compose.yml.hbs, etc.) during project onboarding. This package has been **fully superseded** by the external [`cluster-templates`](https://github.com/generacy-ai/cluster-templates) repository — the onboarding worker in `generacy-cloud` now fetches devcontainer files directly from that repo via GitHub API.

The `generacy init` CLI command is the only remaining consumer of this package. It uses four functions (`buildSingleRepoContext`, `buildMultiRepoContext`, `renderProject`, `withGeneratedBy`) and one type (`ClusterVariant`). This cleanup removes the package, migrates the `ClusterVariant` type, and replaces the Handlebars rendering pipeline in `generacy init` with direct fetching from `cluster-templates`.

## User Stories

### US1: Developer removes dead code from the monorepo

**As a** monorepo maintainer,
**I want** to remove the unused `@generacy-ai/templates` package,
**So that** the codebase is leaner, easier to understand, and does not ship dead Handlebars dependencies.

**Acceptance Criteria**:
- [ ] `packages/templates/` directory is fully deleted
- [ ] No references to `@generacy-ai/templates` remain in any `package.json`
- [ ] `pnpm install` succeeds without errors after removal
- [ ] `pnpm build` succeeds across all remaining packages
- [ ] All existing tests pass (excluding deleted templates tests)

### US2: CLI init command continues to work without the templates package

**As a** developer running `generacy init`,
**I want** the command to produce the same devcontainer files as before,
**So that** the removal is invisible to end users.

**Acceptance Criteria**:
- [ ] `generacy init` still generates all expected files (devcontainer.json, Dockerfile, docker-compose.yml, .env.template, extensions.json, config.yaml, etc.)
- [ ] Generated files match the output from the `cluster-templates` repo (not the old Handlebars templates)
- [ ] The `--variant` flag (`standard` / `microservices`) still works correctly
- [ ] The `--dry-run` flag still previews files without writing
- [ ] All init-related tests pass or are updated to reflect the new implementation

### US3: ClusterVariant type remains available to CLI code

**As a** developer working on the CLI package,
**I want** the `ClusterVariant` type to be available without importing from a deleted package,
**So that** type safety is maintained with no import errors.

**Acceptance Criteria**:
- [ ] `ClusterVariant` type is defined locally within `packages/generacy/`
- [ ] All existing usages in `types.ts` and `summary.ts` compile without changes (or with updated import paths)
- [ ] No runtime behavior changes from the type migration

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Delete `packages/templates/` directory entirely | P1 | Includes all source, tests, templates (.hbs files), configs |
| FR-002 | Remove `@generacy-ai/templates` from `packages/generacy/package.json` dependencies | P1 | Currently `"workspace:*"` on line 43 |
| FR-003 | Migrate `ClusterVariant` type to `packages/generacy/src/cli/commands/init/types.ts` | P1 | Simple type: `'standard' \| 'microservices'` — no Zod schema needed in CLI |
| FR-004 | Update import in `summary.ts` to use local `ClusterVariant` from `./types.js` | P1 | Currently imports from `@generacy-ai/templates` |
| FR-005 | Replace Handlebars rendering in `init/index.ts` with `cluster-templates` fetching | P1 | Replace `buildSingleRepoContext`, `buildMultiRepoContext`, `renderProject`, `withGeneratedBy` calls |
| FR-006 | Implement a template fetcher that downloads files from `cluster-templates` repo | P1 | Use GitHub API (similar to `generacy-cloud` worker approach) or git clone |
| FR-007 | Support template variable substitution without Handlebars | P2 | Templates from `cluster-templates` may use a simpler substitution format |
| FR-008 | Update or remove init-related tests that depend on templates package | P1 | `summary.test.ts` already has a bug — missing `variant` parameter |
| FR-009 | Verify no other packages in the monorepo import from `@generacy-ai/templates` | P1 | Investigation confirms only `@generacy-ai/generacy` imports it |
| FR-010 | Remove published npm package if applicable | P3 | Check if `@generacy-ai/templates` was ever published; deprecate if so |

## Technical Details

### Current Import Map

The templates package is consumed in exactly 3 files within `packages/generacy/`:

| File | Imports | Usage |
|------|---------|-------|
| `src/cli/commands/init/index.ts` | `buildSingleRepoContext`, `buildMultiRepoContext`, `renderProject`, `withGeneratedBy` | Steps 4-6 of init flow: context building and template rendering |
| `src/cli/commands/init/types.ts` | `ClusterVariant` (type-only) | `InitOptions.variant` field type |
| `src/cli/commands/init/summary.ts` | `ClusterVariant` (type-only) | `VARIANT_LABELS` record key type, `printSummary()` parameter |

### ClusterVariant Migration

The type is trivially inlined:

```typescript
// In packages/generacy/src/cli/commands/init/types.ts
/** Cluster variant: "standard" (DooD) or "microservices" (DinD). */
export type ClusterVariant = 'standard' | 'microservices';
```

No Zod schema (`ClusterVariantSchema`) is needed in the CLI — it was only used internally by the templates package's builder/validator pipeline. The CLI already validates variant values through Commander's `.choices()` constraint.

### Init Command Refactoring

The init flow (steps 4-6 in `init/index.ts`) currently:
1. Builds a `TemplateContext` object via `buildSingleRepoContext` / `buildMultiRepoContext`
2. Marks it with `withGeneratedBy('generacy-cli')`
3. Renders Handlebars templates into a `RenderedFileMap` via `renderProject(context, existingFiles)`

This must be replaced with a new approach that fetches template files from the `cluster-templates` repo and performs any necessary variable substitution. The exact fetching strategy (GitHub API, git archive, or bundled snapshot) is an implementation decision.

### Dependencies Removed

Removing the templates package eliminates these transitive dependencies from the monorepo:
- `handlebars` (^4.7.8)
- `js-yaml` (^4.1.0) — only if not used elsewhere
- Associated `@types/*` dev dependencies

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Package removed | `packages/templates/` no longer exists | `ls packages/templates/` returns error |
| SC-002 | Clean dependency graph | Zero references to `@generacy-ai/templates` in any `package.json` or import statement | `grep -r "@generacy-ai/templates" packages/` returns nothing |
| SC-003 | Build passes | All packages build successfully | `pnpm build` exits 0 |
| SC-004 | Tests pass | All tests pass across the monorepo | `pnpm test` exits 0 |
| SC-005 | Init command functional | `generacy init` produces valid devcontainer files | Manual verification and/or integration test |
| SC-006 | No leftover Handlebars | No Handlebars dependency remains in the monorepo | `grep -r "handlebars" packages/*/package.json` returns nothing |

## Assumptions

- The `cluster-templates` repository contains all templates needed by `generacy init` and is the canonical source going forward
- The `ClusterVariant` type values (`'standard'` and `'microservices'`) are stable and won't change as part of this cleanup
- The `generacy-cloud` worker's template fetching approach (`services/worker/src/lib/cluster-templates.ts`) can serve as a reference implementation for the CLI fetcher
- No external consumers depend on `@generacy-ai/templates` being published to npm (or if published, it can be deprecated)
- The `pnpm-workspace.yaml` uses `packages/*` glob and does not list `packages/templates` explicitly — removal is automatic once the directory is deleted

## Out of Scope

- Modifying the `cluster-templates` repository itself
- Changing the `generacy-cloud` worker's template fetching logic
- Adding new template types or variants beyond the existing `standard` / `microservices`
- Migrating any types other than `ClusterVariant` (all other exported types are internal to the templates package)
- Changing the `generacy init` user-facing interface (flags, prompts, output format)
- Performance optimization of template fetching (can be addressed in a follow-up)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `generacy init` breaks if `cluster-templates` repo is unreachable | Init command fails for users without network | Consider bundling a fallback snapshot or caching fetched templates |
| Other packages silently depend on templates via transitive imports | Build failures after removal | FR-009 verification step; CI build gate |
| Published npm package has external consumers | Breaking change for third parties | Check npm download stats; publish deprecation notice if needed |
| `summary.test.ts` has pre-existing bug (missing `variant` parameter) | Tests may already be failing or incorrectly typed | Fix as part of FR-008 |

## Implementation Order

1. **Migrate `ClusterVariant` type** (FR-003, FR-004) — low risk, unblocks everything
2. **Replace init rendering pipeline** (FR-005, FR-006, FR-007) — the core work
3. **Update tests** (FR-008) — including fixing the pre-existing `summary.test.ts` bug
4. **Delete `packages/templates/`** (FR-001) — only after all imports are removed
5. **Clean up dependency references** (FR-002, FR-009) — final verification
6. **Deprecate npm package** (FR-010) — post-merge follow-up if applicable

---

*Generated by speckit*
