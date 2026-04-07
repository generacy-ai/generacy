# Feature Specification: Refactor generacy init to use cluster-base repos

Migrate the `generacy init` CLI command from the monolithic `cluster-templates` repository to the new per-variant base repos (`cluster-base` and `cluster-microservices`).

**Branch**: `375-summary-generacy-init-cli` | **Date**: 2026-03-13 | **Status**: Draft

## Summary

The `generacy init` CLI command still fetches devcontainer files from the `generacy-ai/cluster-templates` repository. The backend (`generacy-cloud`) has already been migrated to use the forkable base repos (`cluster-base` and `cluster-microservices`). The CLI needs to follow suit so we can archive `cluster-templates`.

## Background

The migration plan is documented in [tetrad-development/docs/cluster-base-migration-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-base-migration-plan.md). The `generacy-cloud` worker already fetches from `cluster-base`/`cluster-microservices` via the Git Trees API (see `services/worker/src/lib/cluster-base.ts` and `services/worker/src/lib/config.ts`).

## Changes Required

### 1. Refactor template-fetcher.ts

**`packages/generacy/src/cli/commands/init/template-fetcher.ts`**

- Replace the hardcoded `REPO = 'generacy-ai/cluster-templates'` with variant-based repo selection:
  - `standard` → `generacy-ai/cluster-base`
  - `microservices` → `generacy-ai/cluster-microservices`
- Instead of downloading a tarball and extracting a variant subdirectory, fetch the full repo contents (the base repos have flat structures — no variant subdirectories)
- Update the archive path mapping in `mapArchivePath()` — base repos don't have a `standard/` or `microservices/` prefix; files are at the root
- Update cache paths accordingly

### 2. Update CLI flags

**`packages/generacy/src/cli/commands/init/index.ts`**

- Rename `--template-ref` to something more appropriate (e.g., `--base-ref`) or keep it for backwards compatibility with a deprecation notice
- Update help text and comments that reference `cluster-templates`

### 3. Update init types

**`packages/generacy/src/cli/commands/init/types.ts`**

- Update `InitOptions` field names/comments if `templateRef` / `refreshTemplates` are renamed

### 4. Update tests

- **`packages/generacy/src/cli/commands/init/__tests__/template-fetcher.test.ts`** — Update mock tarball structures to match base repo layout (no variant subdirectory prefix)
- **`packages/generacy/src/cli/commands/init/__tests__/tar-utils.test.ts`** — Update mock archive entries if they reference the `cluster-templates` structure
- **`packages/config/src/__tests__/repos.test.ts`** — Replace `cluster-templates` with `cluster-base` in the test fixture `multiRepoConfig`

### 5. Update external-facing documentation

- **`docs/docs/getting-started/cluster-setup.md`** — Verify references are already updated (may already point to base repos)
- **`docs/docs/getting-started/project-setup.md`** — Same
- Any other docs referencing `cluster-templates` should be updated

## User Stories

### US1: Developer initializing a standard cluster

**As a** developer setting up a new project,
**I want** `generacy init --variant standard` to fetch devcontainer files from the `cluster-base` repo,
**So that** my project is initialized from the correct, actively maintained source repo.

**Acceptance Criteria**:
- [ ] Running `generacy init --variant standard` downloads from `generacy-ai/cluster-base`
- [ ] The resulting devcontainer files are identical to the current output (no user-facing change in file content)

### US2: Developer initializing a microservices cluster

**As a** developer setting up a microservices project,
**I want** `generacy init --variant microservices` to fetch devcontainer files from the `cluster-microservices` repo,
**So that** my microservices project is initialized from the dedicated base repo.

**Acceptance Criteria**:
- [ ] Running `generacy init --variant microservices` downloads from `generacy-ai/cluster-microservices`
- [ ] The resulting devcontainer files are correct for the microservices variant

### US3: Platform team archiving cluster-templates

**As a** platform engineer,
**I want** all runtime references to `cluster-templates` removed from the generacy CLI,
**So that** we can safely archive the `cluster-templates` repository without breaking the CLI.

**Acceptance Criteria**:
- [ ] No runtime code in the `generacy` package references `cluster-templates`
- [ ] Template caching still works correctly with the new repo structure

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Map variant `standard` to repo `generacy-ai/cluster-base` | P1 | Replaces single-repo + subdirectory approach |
| FR-002 | Map variant `microservices` to repo `generacy-ai/cluster-microservices` | P1 | Same pattern as FR-001 |
| FR-003 | Fetch full repo tarball (flat structure, no variant subdirectory prefix) | P1 | Base repos have files at root |
| FR-004 | Update `mapArchivePath()` to handle root-level files | P1 | No `standard/` or `microservices/` prefix to strip |
| FR-005 | Update template cache paths for per-variant repos | P2 | Ensure cache invalidation works across repo change |
| FR-006 | Deprecate or rename `--template-ref` flag | P2 | Consider backwards compat |
| FR-007 | Update all test mocks to match new repo layout | P1 | No variant subdirectory in mock tarballs |
| FR-008 | Update documentation referencing `cluster-templates` | P2 | Docs may already be updated |

## Acceptance Criteria

- [ ] `generacy init --variant standard` fetches from `cluster-base` repo
- [ ] `generacy init --variant microservices` fetches from `cluster-microservices` repo
- [ ] Template caching still works correctly with the new repo structure
- [ ] All existing tests pass with updated mocks
- [ ] No remaining runtime references to `cluster-templates` in the generacy package

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | All init tests pass | 100% green | `pnpm test` in packages/generacy |
| SC-002 | No runtime references to cluster-templates | 0 references | `grep -r cluster-templates packages/generacy/src` returns nothing |
| SC-003 | Init command produces correct output | Files match base repo content | Manual verification of `generacy init` output |

## Assumptions

- The `cluster-base` and `cluster-microservices` repos have a flat file structure (no variant subdirectories)
- The base repos serve the same devcontainer files that were previously in the `cluster-templates` variant subdirectories
- The `generacy-cloud` worker migration (already complete) can serve as reference implementation

## Out of Scope

- Migrating `generacy-cloud` worker code (already done)
- Changes to the base repo contents themselves
- Adding new variants beyond `standard` and `microservices`
- Changes to the forking/cloning workflow that happens after init

---

*Generated by speckit*
