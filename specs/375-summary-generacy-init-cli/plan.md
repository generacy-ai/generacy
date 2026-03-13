# Implementation Plan: Refactor generacy init to use cluster-base repos

**Feature**: Migrate `generacy init` CLI from `cluster-templates` to per-variant base repos (`cluster-base` / `cluster-microservices`)
**Branch**: `375-summary-generacy-init-cli`
**Status**: Complete

## Summary

The `generacy init` CLI currently fetches devcontainer files from the monolithic `generacy-ai/cluster-templates` repository, extracting variant-specific subdirectories from a single tarball. The backend (`generacy-cloud`) has already migrated to the per-variant base repos (`cluster-base` and `cluster-microservices`). This feature aligns the CLI with the new architecture so `cluster-templates` can be archived.

The change is largely internal — the output files are identical for end users. The key differences are:
1. **One repo per variant** instead of one repo with variant subdirectories
2. **Flat file layout** — base repos have files at root (e.g., `.devcontainer/Dockerfile`), no variant prefix to strip
3. **Default branch is `main`** instead of `develop`
4. **Cache paths change** to reflect per-repo structure

## Technical Context

- **Language**: TypeScript (ESM, Node.js)
- **Package manager**: pnpm (monorepo)
- **Test framework**: Vitest
- **CLI framework**: Commander.js + @clack/prompts
- **Key dependency**: Custom tar/gzip parser (`tar-utils.ts`) — no external tar library

## Clarification Decisions

Based on codebase analysis and the existing documentation/reference implementation:

| Question | Decision | Rationale |
|----------|----------|-----------|
| Q1: Flag rename | **Option C** — Keep `--template-ref` / `GENERACY_TEMPLATE_REF` as-is | Names are generic enough; avoids breaking existing scripts and CI |
| Q2: Default git ref | **Option B** — Change default to `main` | Docs show `git merge cluster-base/main`; base repos use `main` |
| Q3: File structure | **Option A** — Files under `.devcontainer/` at root | Docs show `.devcontainer/Dockerfile` etc. at repo root; no variant subdirectory |
| Q4: Cache structure | **Option A** — Change to `{repo-name}/{ref}/` | Old cache naturally ignored (different path); no migration needed |
| Q5: Error messages | **Option A** — Use specific repo name | More helpful for debugging; trivial to implement |

## Project Structure

Files to modify (in implementation order):

```
packages/generacy/src/cli/commands/init/
├── template-fetcher.ts          # Core change: repo selection, path mapping, cache
├── types.ts                     # Minor: update JSDoc comments
├── index.ts                     # Minor: update comments referencing cluster-templates
├── __tests__/
│   ├── template-fetcher.test.ts # Update mocks for new repo layout
│   └── tar-utils.test.ts        # Update mock archive entries
packages/config/src/__tests__/
│   └── repos.test.ts            # Update test fixture
docs/docs/getting-started/
├── cluster-setup.md             # Verify (likely already updated)
└── project-setup.md             # Verify (likely already updated)
```

## Implementation Steps

### Step 1: Refactor `template-fetcher.ts` (Core)

**File**: `packages/generacy/src/cli/commands/init/template-fetcher.ts`

1. **Replace single repo constant with variant-to-repo mapping**:
   ```typescript
   const VARIANT_REPOS: Record<ClusterVariant, string> = {
     standard: 'generacy-ai/cluster-base',
     microservices: 'generacy-ai/cluster-microservices',
   };
   ```
   Remove: `const REPO = 'generacy-ai/cluster-templates'` and `const TARBALL_URL = ...`

2. **Update `getCacheDir()`** — change from `{ref}/{variant}` to `{repo-name}/{ref}`:
   ```typescript
   function getCacheDir(repoName: string, ref: string): string {
     return join(homedir(), CACHE_BASE, repoName, ref);
   }
   ```

3. **Simplify `mapArchivePath()`** — no variant prefix to strip:
   ```typescript
   function mapArchivePath(archivePath: string): string | null {
     const firstSlash = archivePath.indexOf('/');
     if (firstSlash === -1) return null;
     const rest = archivePath.slice(firstSlash + 1);
     return rest || null;
   }
   ```
   The GitHub tarball prefix (`{owner}-{repo}-{sha}/`) is still stripped, but there's no variant subdirectory prefix after it.

4. **Update `fetchClusterTemplates()`**:
   - Look up repo from `VARIANT_REPOS[variant]`
   - Build tarball URL dynamically: `https://api.github.com/repos/${repo}/tarball/${ref}`
   - Change default ref from `'develop'` to `'main'`
   - Update cache dir call: `getCacheDir(repoName, ref)` where `repoName` is extracted from repo slug
   - Remove variant-prefix filter in `extractTarGz` predicate — accept all files
   - Update error messages to reference the specific repo name
   - Update JSDoc and log messages

5. **Update `FetchOptions` interface JSDoc** — change default ref comment to `'main'`

### Step 2: Update types and comments

**File**: `packages/generacy/src/cli/commands/init/types.ts`
- Update JSDoc on `templateRef` field if it references `cluster-templates`

**File**: `packages/generacy/src/cli/commands/init/index.ts`
- Update comment on step 4 ("Fetch cluster templates") to reference base repos
- Update any TODO comments referencing `cluster-templates`

### Step 3: Update tests

**File**: `packages/generacy/src/cli/commands/init/__tests__/template-fetcher.test.ts`
- Update mock tarball URL expectations from `cluster-templates` to `cluster-base`/`cluster-microservices`
- Update mock tarball archive structure: remove variant subdirectory prefix (files at root under SHA prefix)
- Update cache path expectations: `{repo-name}/{ref}/` instead of `{ref}/{variant}/`
- Update default ref expectations from `'develop'` to `'main'`
- Update error message expectations to reference specific repo names

**File**: `packages/generacy/src/cli/commands/init/__tests__/tar-utils.test.ts`
- Update any mock archive entries that use the `cluster-templates` naming convention in their paths (e.g., `generacy-ai-cluster-templates-abc1234/standard/...` → `generacy-ai-cluster-base-abc1234/...`)

**File**: `packages/config/src/__tests__/repos.test.ts`
- Replace `cluster-templates` with `cluster-base` in the `multiRepoConfig` test fixture

### Step 4: Verify documentation

**Files**: `docs/docs/getting-started/cluster-setup.md`, `project-setup.md`
- These docs already reference `cluster-base` and `cluster-microservices` (confirmed by reading them)
- Grep for any remaining `cluster-templates` references in docs and update if found

### Step 5: Final verification

- `grep -r "cluster-templates" packages/generacy/src/` returns zero matches
- All tests pass: `pnpm test` in relevant packages

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Base repos have unexpected file structure | Low | Docs and `generacy-cloud` confirm flat structure with `.devcontainer/` at root |
| Cache path change causes re-download for all users | Expected | One-time ~200KB download; acceptable trade-off vs. stale cache risk |
| `--template-ref` default change breaks CI | Low | `develop` branch likely exists on base repos too; users who set explicit refs are unaffected |
| Tarball filter change includes unwanted files | Low | Base repos are purpose-built; all files are relevant |

## Constitution Check

No `.specify/memory/constitution.md` found — no governance constraints to verify against.
