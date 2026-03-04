# Research: Technical Decisions

## Decision 1: Shared Package vs. In-Package Utility

**Decision**: Create a new `@generacy-ai/config` shared package.

**Context**: The `generacy` package depends on `orchestrator` (`@generacy-ai/orchestrator: workspace:*`). Adding an import from `orchestrator` back to `generacy` for config utilities would create a circular dependency.

**Rationale**:
- Both `generacy` and `orchestrator` need the workspace config schema and helper functions
- A shared package breaks the cycle: `generacy → @generacy-ai/config` and `orchestrator → @generacy-ai/config`
- The config schema, loader, validator, and repo helpers form a cohesive module (~200 LOC)
- The monorepo already has 13 packages; adding one more follows the established pattern

**Alternatives Rejected**:
- **Inline duplication**: Small initial surface area but guaranteed drift over time
- **Dynamic imports**: Fragile at build time, complicates type checking
- **Restructure dependency graph**: Too invasive for this change

## Decision 2: Scope of the Shared Package

**Decision**: Extract only workspace-related config code to `@generacy-ai/config`. Leave the existing `packages/generacy/src/config/` in place.

**Context**: The existing config module in generacy handles project config, repo config (primary/dev/clone), defaults, orchestrator settings, cluster config. The new workspace section is additive.

**Rationale**:
- Moving all existing config code to a shared package would be a large, risky refactor
- The workspace section is the only part both packages need
- The generacy config module already has a subpath export (`@generacy-ai/generacy/config`) — a shared package avoids confusion about which config to import
- Smaller blast radius: only workspace schema + helpers move to the shared package

**What goes in `@generacy-ai/config`**:
- `WorkspaceConfigSchema`, `WorkspaceRepoSchema` (Zod schemas)
- `getWorkspaceRepos()`, `getMonitoredRepos()`, `getRepoWorkdir()` (helpers)
- `tryLoadConfig()` (graceful loader wrapper)
- `parseRepoInput()` (multi-format repo parsing — reuses patterns from `repo-utils.ts`)
- Drift detection utility (`detectRepoDrift()`)

**What stays in `packages/generacy/src/config/`**:
- `GeneracyConfigSchema` (imports `WorkspaceConfigSchema` from `@generacy-ai/config`)
- `loadConfig()`, `findConfigFile()`, `parseConfig()` (existing generacy-specific loader)
- `validateSemantics()`, `validateNoDuplicateRepos()` (existing validators)
- Error classes (`ConfigNotFoundError`, etc.)

## Decision 3: Config File Location Strategy

**Decision**: Read `.generacy/config.yaml` from the workspace root (tetrad-development), not from every repo.

**Context**: The config file lives in `tetrad-development/.generacy/config.yaml`. Other repos may also have their own `.generacy/config.yaml` for project-specific config. The workspace section is only meaningful in the primary repo's config.

**Rationale**:
- Workspace setup needs to locate the config after cloning tetrad-development
- The orchestrator and job-handler run inside devcontainers where tetrad-development is at `/workspaces/tetrad-development`
- Using a known path (`/workspaces/tetrad-development/.generacy/config.yaml`) is simpler and more reliable than directory-walking

**Implementation**:
- Helpers accept a `GeneracyConfig` object (already loaded) — they don't load the file themselves
- Each consumer loads config using its own strategy (existing `loadConfig()` or `tryLoadConfig()`)
- For workspace setup's two-phase clone, config is loaded from `{workdir}/tetrad-development/.generacy/config.yaml` after the first clone

## Decision 4: `parseRepoInput()` Multi-Format Parsing

**Decision**: Reuse regex patterns from `repo-utils.ts` in a new `parseRepoInput()` function that also handles bare repo names.

**Context**: The existing `parseRepoUrl()` in `repo-utils.ts` handles `owner/repo`, `github.com/owner/repo`, SSH, and HTTPS formats. But it doesn't handle bare names like `generacy`. The CLI `--repos` flag currently accepts bare names. After this change, it should accept all formats.

**Implementation**:
```typescript
// In @generacy-ai/config
function parseRepoInput(input: string, defaultOrg?: string): { owner: string; repo: string } {
  const trimmed = input.trim();

  // Try full formats first (owner/repo, github.com/owner/repo, etc.)
  // If no slash found, treat as bare name with defaultOrg
  if (!trimmed.includes('/') && !trimmed.includes(':')) {
    if (!defaultOrg) throw new Error(`Bare repo name "${trimmed}" requires a default org`);
    return { owner: defaultOrg, repo: trimmed };
  }

  // Delegate to existing patterns for owner/repo, github.com/owner/repo, SSH, HTTPS
  return parseRepoUrl(trimmed); // reused regex logic
}
```

**Note**: The existing `parseRepoUrl()` stays in `repo-utils.ts` since it depends on `execSafe()` (git detection). The regex patterns are duplicated in `@generacy-ai/config` (small surface area, no external deps needed).

## Decision 5: Two-Phase Clone in Workspace Setup

**Decision**: Clone/locate the primary repo first, read config, then clone remaining repos.

**Context**: The workspace setup command currently clones all repos from `DEFAULT_REPOS` in one pass. After this change, there is no hardcoded repo list. The command must read `.generacy/config.yaml` from the primary repo to know what else to clone.

**Implementation Flow**:
1. Determine primary repo (CLI arg, env var, or default `tetrad-development`)
2. Check if primary repo already exists at `{workdir}/{primaryRepo}`
3. If not, clone it (using `GITHUB_ORG` / config org / default `generacy-ai`)
4. Load `.generacy/config.yaml` from the cloned primary repo
5. If config has no `workspace` section, fail with clear error
6. Clone remaining repos from `workspace.repos`

**Existing code already handles step ordering**: `workspace.ts:268-273` already moves `tetrad-development` to the front of the clone list. This change formalizes that behavior.

## Decision 6: Drift Detection

**Decision**: Log a warning when `MONITORED_REPOS` env var is set and differs from config file repos.

**Implementation**:
```typescript
function detectRepoDrift(
  configRepos: { owner: string; repo: string }[],
  envRepos: string, // raw MONITORED_REPOS value
): string | null {
  const configSet = new Set(configRepos.map(r => `${r.owner}/${r.repo}`));
  const envSet = new Set(
    envRepos.split(',').map(r => r.trim()).filter(Boolean)
  );

  if (configSet.size === envSet.size && [...configSet].every(r => envSet.has(r))) {
    return null; // No drift
  }

  return 'MONITORED_REPOS env var differs from config file repos — env var takes priority';
}
```

This is a pure set comparison — order doesn't matter, format is normalized to `owner/repo`.

## Decision 7: Test Strategy

**Decision**: Unit tests for helpers + integration tests for override priority chain.

**Unit tests** (in `@generacy-ai/config`):
- `parseRepoInput()` — bare name, owner/repo, github.com/owner/repo, SSH, HTTPS, invalid
- `getWorkspaceRepos()` — normal config, empty repos, missing workspace section
- `getMonitoredRepos()` — filter by `monitor: true`
- `getRepoWorkdir()` — default basePath, custom basePath, repo not in config
- `tryLoadConfig()` — config exists, config missing (returns null)
- `detectRepoDrift()` — matching sets, differing sets, subset, superset

**Integration tests** (in each consumer):
- Workspace setup: CLI > env > config > no fallback
- Orchestrator: CLI > env > config > exit
- Job handler: config-based workdir resolution
