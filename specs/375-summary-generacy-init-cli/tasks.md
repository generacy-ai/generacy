# Tasks: Refactor generacy init to use cluster-base repos

**Input**: Design documents from `/specs/375-summary-generacy-init-cli/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1][US2] Replace `REPO` and `TARBALL_URL` constants with `VARIANT_REPOS` map in `packages/generacy/src/cli/commands/init/template-fetcher.ts` — add `const VARIANT_REPOS: Record<ClusterVariant, string> = { standard: 'generacy-ai/cluster-base', microservices: 'generacy-ai/cluster-microservices' }` and `const DEFAULT_REF = 'main'`; remove old `REPO` and `TARBALL_URL` constants
- [X] T002 [US1][US2] Update `getCacheDir()` signature in `template-fetcher.ts` — change from `(ref, variant)` to `(repoName, ref)`, update path to `join(homedir(), CACHE_BASE, repoName, ref)`
- [X] T003 [US1][US2] Simplify `mapArchivePath()` in `template-fetcher.ts` — remove `variant` parameter, remove variant prefix stripping logic; only strip the GitHub SHA prefix (`{owner}-{repo}-{sha}/`)
- [X] T004 [US1][US2] Update `fetchClusterTemplates()` in `template-fetcher.ts` — look up repo from `VARIANT_REPOS[variant]`, build URL dynamically, change default ref to `'main'`, update `getCacheDir()` call, remove variant-prefix filter in `extractTarGz` predicate (accept all files), update `mapArchivePath()` call (no variant arg), update error messages to reference specific repo name
- [X] T005 [US1][US2] Update `FetchOptions` JSDoc in `template-fetcher.ts` — change default ref comment from `'develop'` to `'main'`

## Phase 2: Types and Comments

- [X] T006 [P] [US3] Update JSDoc on `templateRef` field in `packages/generacy/src/cli/commands/init/types.ts` — change "cluster-templates repository" to "cluster base repository"
- [X] T007 [P] [US3] Update comments in `packages/generacy/src/cli/commands/init/index.ts` — update step 4 comment "Fetch cluster templates from GitHub" and log message "Failed to fetch cluster templates" to reference base repos; update `--template-ref` option description

## Phase 3: Tests

- [X] T008 [P] [US3] Update `packages/generacy/src/cli/commands/init/__tests__/template-fetcher.test.ts` — update mock tarball URL expectations to `cluster-base`/`cluster-microservices`, remove variant subdirectory prefix from mock archive structures, update cache path expectations to `{repo-name}/{ref}/`, update default ref from `'develop'` to `'main'`, update error message expectations
- [X] T009 [P] [US3] Update `packages/generacy/src/cli/commands/init/__tests__/tar-utils.test.ts` — update any mock archive entries using `cluster-templates` naming (e.g. `generacy-ai-cluster-templates-abc1234/standard/...` → `generacy-ai-cluster-base-abc1234/...`)
- [X] T010 [P] [US3] Update `packages/config/src/__tests__/repos.test.ts` — replace `cluster-templates` with `cluster-base` in the `multiRepoConfig` test fixture

## Phase 4: Documentation & Verification

- [X] T011 [P] [US3] Grep for remaining `cluster-templates` references in `docs/` directory and update any found (docs may already reference base repos)
- [X] T012 [US3] Run `grep -r "cluster-templates" packages/generacy/src/` to verify zero remaining runtime references
- [X] T013 [US3] Run tests with `pnpm test` in `packages/generacy` and `packages/config` to verify all pass

## Dependencies & Execution Order

**Phase 1** (sequential within phase):
- T001 → T002 → T003 → T004 → T005: Core refactor must be done in order since T004 depends on changes from T001–T003

**Phase 2** (parallel, after Phase 1):
- T006 and T007 are independent file edits, can run in parallel
- Both depend on Phase 1 being complete to ensure consistency

**Phase 3** (parallel, after Phase 1):
- T008, T009, T010 touch different test files and can run in parallel
- Must follow Phase 1 so tests align with implementation changes

**Phase 4** (sequential, after Phases 1–3):
- T011 can start independently but logically belongs at the end
- T012 must follow all code changes (verification)
- T013 must be last (full test run)
