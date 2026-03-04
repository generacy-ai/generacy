# Feature Specification: Centralize Workspace Repo Lists into `.generacy/config.yaml`

**Branch**: `291-problem-list-repos-clone` | **Date**: 2026-03-04 | **Status**: Draft

## Summary

The list of repos to clone and monitor is defined in **5 separate locations** across 2 repos, using **3 different formats**. Adding or removing a repo requires coordinated edits that easily drift out of sync. This feature centralizes all repo definitions into the existing `.generacy/config.yaml` schema and loader infrastructure, making it the single source of truth while preserving CLI and env var overrides.

### Current State

| Location | Format | Purpose |
|----------|--------|---------|
| `packages/generacy/src/cli/commands/setup/workspace.ts:27` | Bare names (`"generacy"`) | `DEFAULT_REPOS` for `generacy setup workspace` |
| `packages/generacy/src/cli/commands/orchestrator.ts:206` | `owner/repo` from env | Parses `MONITORED_REPOS` for label monitor init |
| `packages/orchestrator/src/config/loader.ts:108` | `owner/repo` from env | Parses `MONITORED_REPOS` / `ORCHESTRATOR_REPOSITORIES` |
| `packages/generacy/src/orchestrator/job-handler.ts:579` | `owner/repo` from env | Maps GitHub repos -> local `/workspaces/` paths |
| `tetrad-development/.devcontainer/agent.env.template` | `owner/repo` csv | Template for `MONITORED_REPOS` env var |

### Existing Infrastructure (Key Discovery)

A `.generacy/config.yaml` schema and loader **already exist** in the codebase:

- **Schema**: `packages/generacy/src/config/schema.ts` -- `GeneracyConfigSchema` with `repos` (primary/dev/clone), `project`, `defaults`, `orchestrator`, `cluster`
- **Loader**: `packages/generacy/src/config/loader.ts` -- `loadConfig()` with directory traversal, `GENERACY_CONFIG_PATH` env var, Zod validation
- **Validator**: `packages/generacy/src/config/validator.ts` -- semantic duplicate checking across repo lists
- **Repo format**: `github.com/{owner}/{repo}` (e.g., `github.com/generacy-ai/generacy`)

The proposed solution **extends** this existing infrastructure rather than creating a parallel system. The workspace setup and orchestrator monitoring concerns are added to the existing schema, and all 5 consumer locations are updated to read from the centralized config via `loadConfig()`.

## User Stories

### US1: Developer Adding a New Repository

**As a** platform developer,
**I want** to add a new repo to the workspace by editing a single config file,
**So that** all commands (workspace setup, orchestrator monitoring, job routing) automatically pick it up without coordinated edits across multiple files.

**Acceptance Criteria**:
- [ ] Adding a repo entry to `.generacy/config.yaml` `repos` section makes it available to `generacy setup workspace`
- [ ] The same entry controls whether the orchestrator monitors the repo (via presence in `dev` list vs `clone` list)
- [ ] The job handler resolves workspace paths from the same config without re-parsing `MONITORED_REPOS`
- [ ] No changes required in `agent.env.template` or any env var to add a repo

### US2: Developer Overriding Repos for Local Development

**As a** developer working on a subset of repos,
**I want** to override the repo list via CLI flags or env vars,
**So that** I can customize my workspace setup without modifying the shared config file.

**Acceptance Criteria**:
- [ ] `generacy setup workspace --repos generacy,humancy` still works and takes priority over config file
- [ ] `REPOS=generacy,humancy generacy setup workspace` still works and takes priority over config file
- [ ] `MONITORED_REPOS=generacy-ai/generacy generacy orchestrator` still works as an override
- [ ] Override priority is: CLI flags > env vars > config file > built-in defaults

### US3: Orchestrator Reading Monitored Repos from Config

**As a** cluster operator,
**I want** the orchestrator to read its monitored repo list from `.generacy/config.yaml`,
**So that** I don't need to keep `MONITORED_REPOS` env var in sync with the workspace setup list.

**Acceptance Criteria**:
- [ ] Orchestrator startup reads repos from config file when `MONITORED_REPOS` is not set
- [ ] Repos in the `primary` and `dev` lists are treated as monitored (they receive PRs and label sync)
- [ ] `MONITORED_REPOS` env var still works as an override (backward compatible)
- [ ] Orchestrator logs which source was used for repo list (config file vs env var)

### US4: Job Handler Resolving Workdirs from Config

**As a** workflow author,
**I want** the job handler to resolve repo working directories from the centralized config,
**So that** job routing works correctly without depending on `MONITORED_REPOS` env var parsing.

**Acceptance Criteria**:
- [ ] `resolveJobWorkdir()` reads repo-to-path mappings from config when available
- [ ] Falls back to `MONITORED_REPOS` env var parsing if config is not available (backward compat)
- [ ] The `/workspaces/{repoName}` path convention is preserved

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add `workspace` section to `GeneracyConfigSchema` with `org` and `branch` fields | P1 | Extends existing schema in `packages/generacy/src/config/schema.ts` |
| FR-002 | Add helper functions to derive repo lists from config: `getWorkspaceRepos()`, `getMonitoredRepos()`, `getRepoWorkdir()` | P1 | New utility module `packages/generacy/src/config/repos.ts` |
| FR-003 | Update `workspace.ts` to call `loadConfig()` and use `getWorkspaceRepos()` as default, removing `DEFAULT_REPOS` constant | P1 | Keep CLI `--repos` and `REPOS` env overrides |
| FR-004 | Update `orchestrator.ts` label monitor init to use `getMonitoredRepos()` from config as fallback when `MONITORED_REPOS` is not set | P1 | Keep `--monitored-repos` CLI and `MONITORED_REPOS` env overrides |
| FR-005 | Update `loader.ts` (orchestrator config) to populate `repositories` from generacy config when env vars are absent | P2 | Must not break existing orchestrator config loading |
| FR-006 | Update `job-handler.ts` `resolveJobWorkdir()` to read from config instead of re-parsing `MONITORED_REPOS` | P2 | Fall back to env var parsing for backward compat |
| FR-007 | Update `agent.env.template` to document that `MONITORED_REPOS` is an override, not the source of truth | P2 | In tetrad-development repo (companion issue) |
| FR-008 | Add validation: warn if config file repos and `MONITORED_REPOS` env var are both set but differ | P3 | Helps catch drift during migration |
| FR-009 | Ensure `loadConfig()` gracefully handles missing config file in workspace setup context | P1 | During initial clone, config.yaml hasn't been cloned yet |

## Technical Design

### Schema Extension

Extend the existing `GeneracyConfigSchema` in `packages/generacy/src/config/schema.ts`:

```typescript
export const WorkspaceConfigSchema = z.object({
  /** GitHub organization for cloning */
  org: z.string().min(1).default('generacy-ai'),
  /** Default branch to checkout */
  branch: z.string().min(1).default('develop'),
});

// Add to GeneracyConfigSchema:
workspace: WorkspaceConfigSchema.optional(),
```

The existing `ReposConfigSchema` already categorizes repos as `primary`, `dev`, and `clone` using `github.com/owner/repo` format. This categorization naturally maps to the monitoring concern:
- `primary` + `dev` repos = monitored (receive PRs, label sync, webhook setup)
- `clone` repos = read-only (cloned but not monitored)

### Repo List Derivation

New utility at `packages/generacy/src/config/repos.ts`:

```typescript
/** Extract owner and repo name from github.com/owner/repo format */
function parseRepoUrl(url: string): { owner: string; repo: string }

/** All repos to clone (primary + dev + clone) as bare names */
function getWorkspaceRepos(config: GeneracyConfig): string[]

/** Repos to monitor (primary + dev) as {owner, repo} objects */
function getMonitoredRepos(config: GeneracyConfig): Array<{ owner: string; repo: string }>

/** Map owner/repo to /workspaces/{repo} path */
function getRepoWorkdir(config: GeneracyConfig, owner: string, repo: string): string | null
```

### Override Priority (Preserved)

```
1. CLI flags (--repos, --monitored-repos)
2. Environment variables (REPOS, MONITORED_REPOS)
3. .generacy/config.yaml file
4. Built-in defaults (BOOTSTRAP_REPOS for workspace setup only)
```

### Bootstrap Problem (FR-009)

During initial `generacy setup workspace`, the config file hasn't been cloned yet (it lives in `tetrad-development`). The approach:

1. `generacy setup workspace` checks if config file exists via `findConfigFile()`
2. If not found, uses `BOOTSTRAP_REPOS` as hardcoded fallback (renamed from `DEFAULT_REPOS`)
3. After cloning, subsequent commands use the config file
4. Log a message: "Config file not found, using bootstrap repo list"

### Files Changed

| File | Change |
|------|--------|
| `packages/generacy/src/config/schema.ts` | Add `WorkspaceConfigSchema`, extend `GeneracyConfigSchema` with `workspace` field |
| `packages/generacy/src/config/repos.ts` | **New**: helper functions for deriving repo lists from config |
| `packages/generacy/src/config/index.ts` | Re-export new helpers |
| `packages/generacy/src/cli/commands/setup/workspace.ts` | Replace `DEFAULT_REPOS` with config-based lookup; rename remainder to `BOOTSTRAP_REPOS` |
| `packages/generacy/src/cli/commands/orchestrator.ts` | Use `getMonitoredRepos()` as fallback when `MONITORED_REPOS` is not set |
| `packages/orchestrator/src/config/loader.ts` | Import and use generacy config as fallback for `repositories` |
| `packages/generacy/src/orchestrator/job-handler.ts` | Use `getRepoWorkdir()` from config; fall back to env var parsing |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Locations defining repo lists | Reduced from 5 to 1 (config file) + 1 (bootstrap fallback) | Code audit |
| SC-002 | Repo format consistency | All consumers derive from single `github.com/owner/repo` source | Code audit |
| SC-003 | Files to edit when adding a repo | 1 file (`.generacy/config.yaml`) | Manual verification |
| SC-004 | Backward compatibility | All existing env var and CLI overrides continue to work | Integration tests |
| SC-005 | Existing tests pass | 100% of current test suite | CI pipeline |
| SC-006 | Bootstrap scenario | `generacy setup workspace` succeeds without config file present | Manual test in fresh devcontainer |

## Assumptions

- The `.generacy/config.yaml` file will exist in the tetrad-development repo (created by companion issue)
- The existing config loader infrastructure (`loadConfig`, `findConfigFile`, `validateConfig`) is stable and ready for production use
- The `repos` section of the config schema (`primary`/`dev`/`clone`) is the correct model -- monitoring status is derived from repo category rather than a per-repo `monitor` flag
- The `github.com/owner/repo` URL format from the existing schema is the canonical format; bare names and `owner/repo` are derived from it
- `tetrad-development` is always the primary repo and is always cloned first (making the config file available for subsequent commands)

## Out of Scope

- **Creating the actual `.generacy/config.yaml` file** in tetrad-development -- tracked by companion issue
- **Removing `MONITORED_REPOS` env var support** -- retained for backward compat and override use
- **Orchestrator-specific `orchestrator.yaml`** config file unification -- separate concern
- **Auto-detection of new repos** -- repos must be explicitly listed in config
- **Cross-repo config sync** -- each workspace has its own config; no syncing between workspaces
- **Migration tooling** -- no automated migration from env vars to config file; documentation is sufficient
- **Config file versioning/migration** -- `schemaVersion` field exists but migration logic is out of scope

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Bootstrap chicken-and-egg: config file not available during initial workspace setup | `generacy setup workspace` fails | Keep `BOOTSTRAP_REPOS` fallback; detect missing config gracefully |
| Breaking change if config file is required but missing | Orchestrator, job handler fail to start | Make config file optional with graceful fallback to existing env var behavior |
| Orchestrator package importing from generacy config package | Circular dependency | `repos.ts` utility is pure functions with no side effects; can be extracted to shared package if needed |
| Config file format diverges from issue proposal | Confusion for implementers | Spec documents the reconciliation: use existing `repos` schema categories, not issue's `workspace.repos[].monitor` flag |

---

*Generated by speckit*
