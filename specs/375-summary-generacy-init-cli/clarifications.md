# Clarifications: Refactor generacy init to use cluster-base repos

## Batch 1 — 2026-03-13

### Q1: Flag Rename Strategy
**Context**: The spec says to "Rename `--template-ref` to something more appropriate (e.g., `--base-ref`) or keep it for backwards compatibility with a deprecation notice." This is an explicit either/or that needs a decision before implementation, as it affects the CLI interface, types, and env var naming.
**Question**: Should we rename `--template-ref` to `--base-ref` (clean break), or keep `--template-ref` with a deprecation warning? Additionally, should the `GENERACY_TEMPLATE_REF` environment variable (currently used as a fallback) be renamed to match?
**Options**:
- A: Rename to `--base-ref` and `GENERACY_BASE_REF` (clean break, no backwards compat)
- B: Keep `--template-ref` / `GENERACY_TEMPLATE_REF` with deprecation warnings, add `--base-ref` / `GENERACY_BASE_REF` as new aliases
- C: Keep `--template-ref` / `GENERACY_TEMPLATE_REF` as-is with no rename (names are generic enough)

**Answer**: *Pending*

### Q2: Default Git Ref for Base Repos
**Context**: The current implementation defaults to `'develop'` when no ref is specified (via `templateRef ?? process.env.GENERACY_TEMPLATE_REF ?? 'develop'`). The new `cluster-base` and `cluster-microservices` repos may use a different default branch (e.g., `main`). Using the wrong default would cause 404 errors.
**Question**: What is the default branch for the `cluster-base` and `cluster-microservices` repos — is it `develop` (same as current default) or `main`?
**Options**:
- A: `develop` (no change needed)
- B: `main` (update the default)

**Answer**: *Pending*

### Q3: Base Repo File Structure Confirmation
**Context**: The spec assumes "base repos have flat structures — no variant subdirectories." The current `mapArchivePath()` strips both the GitHub hash prefix (`{owner}-{repo}-{sha}/`) AND the variant subdirectory prefix (`standard/`). For the new repos, we need to know the exact structure to correctly implement path mapping. The critical question is whether files like `Dockerfile` sit at the repo root or under a `.devcontainer/` directory at the root.
**Question**: In the base repos, are devcontainer files under a `.devcontainer/` directory at the repo root (e.g., `repo-root/.devcontainer/Dockerfile`), or are they truly at the repo root with no parent directory (e.g., `repo-root/Dockerfile`)?
**Options**:
- A: Under `.devcontainer/` at root (e.g., `.devcontainer/Dockerfile`, `.devcontainer/docker-compose.yml`)
- B: Directly at root (e.g., `Dockerfile`, `docker-compose.yml` at top level)
- C: Mixed — some files at root, some in subdirectories

**Answer**: *Pending*

### Q4: Cache Structure and Migration
**Context**: The current cache path is `~/.generacy/template-cache/{ref}/{variant}/`. Since the new approach uses different repos per variant, the cache semantics change — each (variant, ref) pair now maps to a different source repo. Users upgrading the CLI will have stale cache entries from the old structure that could serve incorrect content if the path scheme doesn't change.
**Question**: Should the cache path structure change to reflect the new repo-per-variant model (e.g., `~/.generacy/template-cache/{repo-name}/{ref}/`), and should the CLI clean up or invalidate old cache entries on first run after upgrade?
**Options**:
- A: Change cache path to `{repo-name}/{ref}/` — old cache naturally ignored (different path)
- B: Keep `{ref}/{variant}/` structure — cache content will be correct since variant determines the repo
- C: Change cache path AND add one-time cleanup of old cache directory

**Answer**: *Pending*

### Q5: Error Message Updates
**Context**: Current error messages reference "cluster-templates" (e.g., "Template ref '{ref}' not found in cluster-templates repository"). With per-variant repos, errors should ideally reference the specific repo that failed. The spec doesn't mention updating error messages.
**Question**: Should error messages be updated to reference the specific repo name (e.g., "not found in cluster-base repository") based on which variant was selected, or use a generic term?
**Options**:
- A: Use specific repo name per variant (e.g., "cluster-base" or "cluster-microservices")
- B: Use generic term (e.g., "base repository" or "cluster repository")

**Answer**: *Pending*
