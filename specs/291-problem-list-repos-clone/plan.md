# Implementation Plan: Centralized Repo Config

## Summary

Eliminate 5 separate repo-list definitions by creating a single source of truth in `.generacy/config.yaml`. A new `@generacy-ai/config` shared package provides the workspace schema and repo helper functions. Four consumers are updated to read from config instead of hardcoded constants or raw env-var parsing.

## Technical Context

- **Language**: TypeScript (ES2022, NodeNext modules)
- **Monorepo**: pnpm workspaces (`packages/*`)
- **Validation**: Zod v3.23+
- **Config format**: YAML (via `yaml` v2.4+)
- **Test framework**: Vitest
- **Key packages affected**: `@generacy-ai/generacy`, `@generacy-ai/orchestrator`

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  .generacy/config.yaml  (tetrad-development repo)   │
│  ┌─────────────────────────────────────────────────┐ │
│  │ workspace:                                      │ │
│  │   org: generacy-ai                              │ │
│  │   branch: develop                               │ │
│  │   repos:                                        │ │
│  │     - name: tetrad-development                  │ │
│  │       monitor: true                             │ │
│  │     - name: generacy                            │ │
│  │       monitor: true                             │ │
│  │     ...                                         │ │
│  └─────────────────────────────────────────────────┘ │
└───────────────────────┬─────────────────────────────┘
                        │
            ┌───────────▼───────────┐
            │  @generacy-ai/config  │
            │  (new shared package) │
            │                       │
            │  - WorkspaceSchema    │
            │  - getWorkspaceRepos  │
            │  - getMonitoredRepos  │
            │  - getRepoWorkdir    │
            │  - parseRepoInput    │
            │  - tryLoadConfig     │
            │  - detectRepoDrift   │
            └───┬───────────┬──────┘
                │           │
    ┌───────────▼──┐   ┌────▼────────────┐
    │  generacy    │   │  orchestrator   │
    │  (CLI)       │   │  (API server)   │
    │              │   │                 │
    │ workspace.ts │   │ loader.ts       │
    │ orchestr..ts │   └─────────────────┘
    │ job-handler  │
    └──────────────┘
```

## Implementation Phases

---

### Phase 1: Create `@generacy-ai/config` shared package

**Goal**: Establish the shared package with workspace schema and helpers.

#### Step 1.1: Scaffold package structure

Create `packages/config/` with standard monorepo package layout:

```
packages/config/
├── src/
│   ├── index.ts              # Public exports
│   ├── workspace-schema.ts   # Zod schemas for workspace section
│   ├── repos.ts              # Helper functions (getWorkspaceRepos, etc.)
│   ├── parse-repo-input.ts   # Multi-format repo input parser
│   └── drift.ts              # Drift detection utility
├── __tests__/
│   ├── workspace-schema.test.ts
│   ├── repos.test.ts
│   ├── parse-repo-input.test.ts
│   └── drift.test.ts
├── package.json
└── tsconfig.json
```

**Files to create**:
- `packages/config/package.json` — `@generacy-ai/config`, deps: `yaml`, `zod`
- `packages/config/tsconfig.json` — copy from existing package, standard config

#### Step 1.2: Define workspace schemas

**File**: `packages/config/src/workspace-schema.ts`

```typescript
import { z } from 'zod';

export const WorkspaceRepoSchema = z.object({
  name: z.string().min(1),
  monitor: z.boolean().default(true),
});

export type WorkspaceRepo = z.infer<typeof WorkspaceRepoSchema>;

export const WorkspaceConfigSchema = z.object({
  org: z.string().min(1),
  branch: z.string().min(1).default('develop'),
  repos: z.array(WorkspaceRepoSchema).min(1),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
```

#### Step 1.3: Implement repo helpers

**File**: `packages/config/src/repos.ts`

Functions to implement:
- `getWorkspaceRepos(config)` — returns `RepoInfo[]` from `workspace.repos` with `owner` from `workspace.org`
- `getMonitoredRepos(config)` — filters for `monitor: true`, returns `{ owner, repo }[]`
- `getRepoWorkdir(config, owner, repo, basePath = '/workspaces')` — maps to local path
- `getWorkspaceOrg(config)` — returns `workspace.org`
- `getWorkspaceBranch(config)` — returns `workspace.branch`

All functions accept a `WorkspaceConfig` (not the full `GeneracyConfig`), keeping the shared package independent of generacy-specific config.

#### Step 1.4: Implement `parseRepoInput()`

**File**: `packages/config/src/parse-repo-input.ts`

Multi-format parser: bare name → `owner/repo` → `github.com/owner/repo` → SSH → HTTPS. Returns `{ owner, repo }`. Bare names require a `defaultOrg` parameter.

Regex patterns are duplicated from `repo-utils.ts` to avoid importing generacy internals.

#### Step 1.5: Implement drift detection

**File**: `packages/config/src/drift.ts`

`detectRepoDrift(configRepos, envReposStr)` — set comparison, returns warning message or `null`.

#### Step 1.6: Implement `tryLoadConfig()`

**File**: `packages/config/src/index.ts` (or separate file)

Wrapper that catches `ConfigNotFoundError` and returns `null`. This depends on the generacy config loader, but since `@generacy-ai/config` should not depend on generacy, the approach is:
- Export a `tryLoad` helper that takes a loader function and wraps it in try/catch
- Each consumer provides its own loader; the shared package provides the wrapping pattern

Alternatively, since both consumers can do a simple file check + YAML parse, `tryLoadConfig` can be self-contained:

```typescript
export function tryLoadWorkspaceConfig(configPath: string): WorkspaceConfig | null {
  if (!existsSync(configPath)) return null;
  const content = readFileSync(configPath, 'utf-8');
  const parsed = parseYaml(content);
  const workspace = (parsed as Record<string, unknown>)?.workspace;
  if (!workspace) return null;
  return WorkspaceConfigSchema.parse(workspace);
}
```

#### Step 1.7: Write unit tests

Test all helpers with edge cases: missing workspace section, empty repos, bare names, multi-format parsing, drift detection.

**Estimated files**: 8 new files

---

### Phase 2: Integrate workspace schema into generacy config

**Goal**: Add `workspace` field to `GeneracyConfigSchema` and update the generacy config module.

#### Step 2.1: Add workspace to GeneracyConfigSchema

**File**: `packages/generacy/src/config/schema.ts`

- Import `WorkspaceConfigSchema` from `@generacy-ai/config`
- Add `workspace: WorkspaceConfigSchema.optional()` to `GeneracyConfigSchema`
- Add dependency: `@generacy-ai/config: workspace:*` to `packages/generacy/package.json`

#### Step 2.2: Update existing config examples

**File**: `packages/generacy/examples/config-full.yaml` (if it exists — the glob returned empty, so examples may be in a different location or not yet created)

Add a `workspace:` section to any existing example configs.

#### Step 2.3: Update config tests

**File**: `packages/generacy/src/config/__tests__/schema.test.ts`

Add test cases for configs with and without `workspace` section.

**Estimated files**: 2-3 modified files

---

### Phase 3: Update `generacy setup workspace`

**Goal**: Replace `DEFAULT_REPOS` with two-phase clone from config.

#### Step 3.1: Implement two-phase clone logic

**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`

Changes to `resolveWorkspaceConfig()`:
1. Remove `DEFAULT_REPOS` constant
2. After CLI/env override check, attempt to load config:
   - Determine primary repo name (default: `tetrad-development`)
   - Check if primary repo exists at `{workdir}/{primaryRepo}`
   - If exists, load `.generacy/config.yaml` from it
   - If `workspace` section exists, use `getWorkspaceRepos()` for repo list
   - If not exists and no CLI/env override, return only the primary repo name (will clone it first)
3. After initial clone, re-resolve config if needed (two-phase)

Changes to the `action` handler:
1. Clone tetrad-development (or primary repo) first
2. If no repos were resolved from config initially, load config from freshly cloned repo
3. Clone remaining repos from config
4. Use `getWorkspaceOrg()` and `getWorkspaceBranch()` as defaults (overridable by env/CLI)

#### Step 3.2: Update multi-format CLI parsing

Use `parseRepoInput()` from `@generacy-ai/config` when parsing `--repos` CLI flag, so it accepts bare names, `owner/repo`, and `github.com/owner/repo`.

#### Step 3.3: Log resolved repo count and source

After resolving repos, log: `"Cloning {N} repos from {source}"` where source is "CLI flag", "REPOS env var", or "config file".

#### Step 3.4: Write integration tests

Test the override priority chain: CLI > env > config > error (no fallback).

**Estimated files**: 1 modified, 1 new test file

---

### Phase 4: Update orchestrator startup (`orchestrator.ts`)

**Goal**: Read monitored repos from config file with env/CLI as overrides.

#### Step 4.1: Update `setupLabelMonitor()`

**File**: `packages/generacy/src/cli/commands/orchestrator.ts`

Changes around lines 206-222:
1. Add `@generacy-ai/config` import
2. After checking CLI flag and `MONITORED_REPOS` env var, try loading config as fallback:
   - Use `tryLoadWorkspaceConfig()` to find `.generacy/config.yaml`
   - Use `getMonitoredRepos()` to extract monitored repos from config
3. Add drift detection: if both env and config are present, log warning if they differ
4. Log resolved repo count and source

#### Step 4.2: Add `@generacy-ai/config` dependency

Already added in Phase 2 for the generacy package.

**Estimated files**: 1 modified

---

### Phase 5: Update orchestrator config loader (`loader.ts`)

**Goal**: Support reading repositories from centralized config.

#### Step 5.1: Add config file fallback for repositories

**File**: `packages/orchestrator/src/config/loader.ts`

Changes around lines 107-115 (`loadFromEnv`):
1. Add `@generacy-ai/config` import
2. If `MONITORED_REPOS` / `ORCHESTRATOR_REPOSITORIES` env vars are not set, try loading from `.generacy/config.yaml`
3. Use `tryLoadWorkspaceConfig()` → `getMonitoredRepos()` as fallback source for `config.repositories`
4. Add drift detection if both sources are present

#### Step 5.2: Add `@generacy-ai/config` dependency

**File**: `packages/orchestrator/package.json`

Add `"@generacy-ai/config": "workspace:*"` to dependencies.

#### Step 5.3: Write integration test

Test that the loader falls back to config file when env vars are absent.

**Estimated files**: 2 modified, 1 new test file

---

### Phase 6: Update job handler (`job-handler.ts`)

**Goal**: Use config-based workdir resolution instead of re-parsing `MONITORED_REPOS`.

#### Step 6.1: Update `resolveJobWorkdir()`

**File**: `packages/generacy/src/orchestrator/job-handler.ts`

Changes around lines 572-598:
1. Import `tryLoadWorkspaceConfig`, `getRepoWorkdir` from `@generacy-ai/config`
2. Replace inline `MONITORED_REPOS` parsing with config-based lookup:
   - First check `MONITORED_REPOS` env var (backward compat, override)
   - If not set, try loading workspace config
   - Use `getRepoWorkdir()` with configurable base path
3. Pass basePath through (default `/workspaces`, from constructor or class property)

**Option**: Cache the loaded workspace config in the `JobHandler` instance to avoid re-reading the YAML file on every job.

**Estimated files**: 1 modified

---

### Phase 7: Update documentation and templates

**Goal**: Update `agent.env.template` and add documentation.

#### Step 7.1: Update `agent.env.template`

**File**: `tetrad-development/.devcontainer/agent.env.template` (companion repo)

- Add comment: `# MONITORED_REPOS overrides .generacy/config.yaml — leave empty to use config file`
- This is tracked in the companion issue but noted here for completeness

#### Step 7.2: Update existing examples

Add `workspace:` section to any existing config examples in the generacy repo.

**Estimated files**: 0-2 modified (depending on companion issue scope)

---

### Phase 8: Testing and validation

**Goal**: Ensure all tests pass and backward compatibility is maintained.

#### Step 8.1: Unit tests for `@generacy-ai/config`

All helper functions, schema validation, edge cases.

#### Step 8.2: Integration tests for override priority

Each consumer: verify CLI > env > config > error/empty behavior.

#### Step 8.3: Run existing test suites

Ensure no regressions in existing config, orchestrator, and workspace tests.

#### Step 8.4: Build validation

Run `pnpm build` across all packages to ensure TypeScript compilation succeeds with new dependency.

---

## Key Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Circular dependency | New `@generacy-ai/config` shared package | Both packages need workspace schema; avoids cycle |
| Package scope | Workspace config only (not full config extraction) | Minimizes blast radius; existing config stays put |
| Config loading | `tryLoadWorkspaceConfig()` returns `null` | Three consumers need graceful missing-config handling |
| CLI format | Multi-format via `parseRepoInput()` | Reuses existing regex patterns; zero friction for users |
| Bootstrap | Two-phase clone (no hardcoded fallback list) | Config file is sole source of truth per Q6 answer |
| Drift detection | Set comparison, log warning | Simple, non-blocking; env var takes priority per Q5 |
| Repo workdir | Configurable `basePath` parameter | Respects existing `--workdir` flag per Q4 |

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Config file missing during fresh setup | Two-phase clone: clone primary repo first, then read config |
| Breaking existing env-var workflows | Env vars remain highest-priority override; config is fallback |
| Schema validation rejects existing configs | `workspace` is optional; existing configs without it still pass |
| Build order issues with new package | pnpm workspaces handle build order automatically via `workspace:*` |
| Regression in orchestrator startup | Integration tests verify env-var path still works identically |

## File Change Summary

### New Files (Phase 1)
| File | Description |
|------|-------------|
| `packages/config/package.json` | Shared config package manifest |
| `packages/config/tsconfig.json` | TypeScript config |
| `packages/config/src/index.ts` | Public exports |
| `packages/config/src/workspace-schema.ts` | Zod schemas for workspace section |
| `packages/config/src/repos.ts` | Repo helper functions |
| `packages/config/src/parse-repo-input.ts` | Multi-format repo input parser |
| `packages/config/src/drift.ts` | Drift detection utility |
| `packages/config/__tests__/workspace-schema.test.ts` | Schema tests |
| `packages/config/__tests__/repos.test.ts` | Helper tests |
| `packages/config/__tests__/parse-repo-input.test.ts` | Parser tests |
| `packages/config/__tests__/drift.test.ts` | Drift tests |

### Modified Files (Phases 2-7)
| File | Change |
|------|--------|
| `packages/generacy/package.json` | Add `@generacy-ai/config` dependency |
| `packages/orchestrator/package.json` | Add `@generacy-ai/config` dependency |
| `packages/generacy/src/config/schema.ts` | Add `workspace` field to `GeneracyConfigSchema` |
| `packages/generacy/src/config/__tests__/schema.test.ts` | Add workspace test cases |
| `packages/generacy/src/cli/commands/setup/workspace.ts` | Remove `DEFAULT_REPOS`, two-phase clone, multi-format parsing |
| `packages/generacy/src/cli/commands/orchestrator.ts` | Config fallback for monitored repos, drift detection |
| `packages/orchestrator/src/config/loader.ts` | Config fallback for repositories |
| `packages/generacy/src/orchestrator/job-handler.ts` | Config-based workdir resolution |

### Deleted Code
| Location | What |
|----------|------|
| `workspace.ts:27-36` | `DEFAULT_REPOS` constant |
