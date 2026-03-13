# Research: Refactor generacy init to use cluster-base repos

## Technology Decisions

### 1. Variant-to-Repo Mapping (Static Map)

**Decision**: Use a simple `Record<ClusterVariant, string>` constant mapping variants to repo slugs.

**Rationale**: Only two variants exist (`standard`, `microservices`) and the spec explicitly scopes out adding new variants. A static map is simpler than a config file or registry lookup. This mirrors the `generacy-cloud` worker approach in `services/worker/src/lib/config.ts`.

**Alternatives considered**:
- Dynamic lookup from a config API — over-engineered for two values; adds network dependency
- Config file (`repos.yaml`) — adds a file to maintain with no benefit for two entries
- CLI flag for arbitrary repo — violates the variant abstraction; users shouldn't need to know repo names

### 2. Default Branch: `main` instead of `develop`

**Decision**: Change the default ref from `'develop'` to `'main'`.

**Rationale**: The `cluster-base` and `cluster-microservices` repos use `main` as their default branch. This is confirmed by the cluster-setup documentation which shows `git merge cluster-base/main`. The original `cluster-templates` repo used `develop`, but that convention doesn't carry over.

**Risk**: Users who have `GENERACY_TEMPLATE_REF=develop` set explicitly will continue using `develop` (if the branch exists on the base repos). The env var override is preserved.

### 3. Cache Path: `{repo-name}/{ref}/` Structure

**Decision**: Change cache layout from `~/.generacy/template-cache/{ref}/{variant}/` to `~/.generacy/template-cache/{repo-name}/{ref}/`.

**Rationale**:
- Old cache entries are naturally ignored (different path) — no migration code needed
- Repo name is more semantically correct than variant name for the cache key, since each repo is an independent artifact source
- Aligns with how GitHub identifies repositories

**Alternatives considered**:
- Keep `{ref}/{variant}/` — works functionally but obscures the 1:1 variant→repo relationship
- Add cache cleanup of old entries — unnecessary complexity; old cache files are small and harmless

### 4. No Tarball Filter (Accept All Files)

**Decision**: Remove the variant-prefix filter from `extractTarGz()` — extract all files from the tarball.

**Rationale**: Base repos are single-purpose repositories containing only the files for one variant. Unlike `cluster-templates` which had multiple variant subdirectories requiring filtering, base repos have all relevant files at root level. Every file in the tarball belongs in the output.

**Risk mitigation**: If base repos ever add non-devcontainer files (README, CI config), those would be included. This is acceptable — the repos are specifically maintained for this purpose.

### 5. Keep `--template-ref` Flag Name

**Decision**: Keep the existing `--template-ref` flag and `GENERACY_TEMPLATE_REF` env var without renaming.

**Rationale**:
- "Template" is generic enough — it still describes the purpose (fetching template files)
- Renaming adds a breaking change with no functional benefit
- Avoids needing deprecation warnings, alias handling, or documentation for the rename
- The flag is rarely used directly (most users accept the default)

## Implementation Patterns

### Pattern: Repository Selection

```typescript
// Before: Single hardcoded repo
const REPO = 'generacy-ai/cluster-templates';

// After: Variant-keyed map
const VARIANT_REPOS: Record<ClusterVariant, string> = {
  standard: 'generacy-ai/cluster-base',
  microservices: 'generacy-ai/cluster-microservices',
};
```

### Pattern: Simplified Path Mapping

```typescript
// Before: Strip GitHub prefix AND variant subdirectory
// generacy-ai-cluster-templates-abc1234/standard/.devcontainer/Dockerfile
//   → .devcontainer/Dockerfile

// After: Strip GitHub prefix only (no variant subdirectory exists)
// generacy-ai-cluster-base-abc1234/.devcontainer/Dockerfile
//   → .devcontainer/Dockerfile
```

The `mapArchivePath()` function becomes simpler — it only needs to remove the first path segment (GitHub's `{owner}-{repo}-{sha}/` prefix).

### Pattern: Dynamic URL Construction

```typescript
// Before: Static URL template
const TARBALL_URL = `https://api.github.com/repos/${REPO}/tarball`;
const url = `${TARBALL_URL}/${ref}`;

// After: Built per-call from variant
const repo = VARIANT_REPOS[variant];
const url = `https://api.github.com/repos/${repo}/tarball/${ref}`;
```

## Key References

- **Spec**: `specs/375-summary-generacy-init-cli/spec.md`
- **Current implementation**: `packages/generacy/src/cli/commands/init/template-fetcher.ts`
- **Reference implementation**: `generacy-cloud` worker at `services/worker/src/lib/cluster-base.ts` (separate repo)
- **Migration plan**: `tetrad-development/docs/cluster-base-migration-plan.md`
- **Cluster docs**: `docs/docs/getting-started/cluster-setup.md` (already references base repos)
