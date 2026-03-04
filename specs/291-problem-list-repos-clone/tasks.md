# Tasks: Centralized Repo Config (`.generacy/config.yaml`)

**Input**: `spec.md`, `plan.md`, `clarifications.md`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Create `@generacy-ai/config` shared package

### T001 [DONE] Scaffold `packages/config` package structure
**Files**:
- `packages/config/package.json`
- `packages/config/tsconfig.json`
- `packages/config/src/index.ts`
- Create `package.json` with name `@generacy-ai/config`, deps: `yaml@^2.4.0`, `zod@^3.23.0`; devDeps: `@types/node@^20.14.0`, `typescript@^5.4.5`, `vitest@^4.0.18`
- Copy `tsconfig.json` from `packages/generacy/tsconfig.json` (same `ES2022`/`NodeNext`/`strict` settings)
- Create `src/index.ts` as barrel export (initially empty, populated in subsequent tasks)
- Register in pnpm workspace (already covered by `packages/*` glob in `pnpm-workspace.yaml`)

### T002 [DONE] [P] Define workspace Zod schemas
**File**: `packages/config/src/workspace-schema.ts`
- Define `WorkspaceRepoSchema`: `z.object({ name: z.string().min(1), monitor: z.boolean().default(true) })`
- Define `WorkspaceConfigSchema`: `z.object({ org: z.string().min(1), branch: z.string().min(1).default('develop'), repos: z.array(WorkspaceRepoSchema).min(1) })`
- Export types: `WorkspaceRepo`, `WorkspaceConfig`
- Export schemas for reuse in `GeneracyConfigSchema` (Phase 2)

### T003 [DONE] [P] Implement repo helper functions
**File**: `packages/config/src/repos.ts`
- `getWorkspaceRepos(config: WorkspaceConfig)` → returns `{ owner: string, repo: string }[]` using `config.org` as owner
- `getMonitoredRepos(config: WorkspaceConfig)` → filters `config.repos` for `monitor: true`, returns `{ owner: string, repo: string }[]`
- `getRepoNames(config: WorkspaceConfig)` → returns bare `string[]` of repo names
- `getRepoWorkdir(repoName: string, basePath: string = '/workspaces')` → returns `${basePath}/${repoName}`
- All functions are pure (no I/O), taking `WorkspaceConfig` as input

### T004 [DONE] [P] Implement multi-format repo input parser
**File**: `packages/config/src/parse-repo-input.ts`
- `parseRepoInput(input: string, defaultOrg?: string)` → returns `{ owner: string, repo: string }`
- Support formats: bare name (`generacy`), `owner/repo` (`generacy-ai/generacy`), `github.com/owner/repo`, SSH URL, HTTPS URL
- Bare name requires `defaultOrg` parameter; throw if not provided
- Strip `.git` suffix if present
- `parseRepoList(csv: string, defaultOrg?: string)` → splits on comma, trims, filters empty, calls `parseRepoInput` on each

### T005 [DONE] [P] Implement drift detection utility
**File**: `packages/config/src/drift.ts`
- `detectRepoDrift(configRepos: { owner: string, repo: string }[], envRepos: { owner: string, repo: string }[])` → returns `{ inConfigOnly: string[], inEnvOnly: string[] } | null`
- Set comparison using `owner/repo` as key
- Returns `null` if sets are identical
- Intended for logging warnings, not blocking

### T006 [DONE] [P] Implement `tryLoadWorkspaceConfig()`
**File**: `packages/config/src/loader.ts`
- `tryLoadWorkspaceConfig(configPath: string)` → returns `WorkspaceConfig | null`
- Check `existsSync(configPath)`, return `null` if missing
- Read file, parse YAML, extract `workspace` key from parsed object
- Return `null` if `workspace` key is missing
- Validate with `WorkspaceConfigSchema.parse()` (throws on invalid)
- `findWorkspaceConfigPath(startDir: string, configDirName = '.generacy', configFileName = 'config.yaml')` → walks up directories looking for `{dir}/{configDirName}/{configFileName}`, stops at `.git` root, returns path or `null`

### T007 [DONE] Update `packages/config/src/index.ts` barrel exports
**File**: `packages/config/src/index.ts`
- Re-export all public types and functions from `workspace-schema.ts`, `repos.ts`, `parse-repo-input.ts`, `drift.ts`, `loader.ts`
- This is the public API surface of the package

---

## Phase 2: Unit tests for `@generacy-ai/config`

### T008 [DONE] [P] Write workspace schema tests
**File**: `packages/config/src/__tests__/workspace-schema.test.ts`
- Valid config with all fields
- Default values: `monitor` defaults to `true`, `branch` defaults to `'develop'`
- Reject empty `org`, empty `repos` array, empty repo `name`
- Type inference checks

### T009 [DONE] [P] Write repo helper tests
**File**: `packages/config/src/__tests__/repos.test.ts`
- `getWorkspaceRepos` returns correct `{ owner, repo }[]` with org prefix
- `getMonitoredRepos` filters correctly (mix of `monitor: true` and `false`)
- `getRepoNames` returns bare names
- `getRepoWorkdir` returns correct path with default and custom `basePath`

### T010 [DONE] [P] Write parse-repo-input tests
**File**: `packages/config/src/__tests__/parse-repo-input.test.ts`
- Bare name with `defaultOrg` → `{ owner, repo }`
- Bare name without `defaultOrg` → throws
- `owner/repo` format
- `github.com/owner/repo` format
- HTTPS URL with `.git` suffix → stripped
- SSH URL format
- `parseRepoList` with comma-separated input, whitespace, empty entries
- Invalid inputs (empty string, just `/`)

### T011 [DONE] [P] Write drift detection tests
**File**: `packages/config/src/__tests__/drift.test.ts`
- Identical sets → returns `null`
- Extra repo in config → `inConfigOnly` populated
- Extra repo in env → `inEnvOnly` populated
- Both differ → both arrays populated
- Empty inputs

### T012 [DONE] [P] Write loader tests
**File**: `packages/config/src/__tests__/loader.test.ts`
- `tryLoadWorkspaceConfig` with valid YAML file → returns `WorkspaceConfig`
- Missing file → returns `null`
- YAML without `workspace` key → returns `null`
- Invalid workspace section → throws (Zod validation)
- `findWorkspaceConfigPath` walks up to `.git` root
- `findWorkspaceConfigPath` returns `null` when not found

---

## Phase 3: Integrate workspace schema into generacy config

### T013 [DONE] Add `@generacy-ai/config` dependency to generacy package
**File**: `packages/generacy/package.json`
- Add `"@generacy-ai/config": "workspace:*"` to `dependencies` (line 41 area)
- Run `pnpm install` to link the workspace package

### T014 [DONE] Add `workspace` field to `GeneracyConfigSchema`
**File**: `packages/generacy/src/config/schema.ts`
- Import `WorkspaceConfigSchema` from `@generacy-ai/config`
- Add `workspace: WorkspaceConfigSchema.optional()` to `GeneracyConfigSchema` (after `cluster` field, ~line 176)
- This is optional so existing configs without `workspace` remain valid

### T015 [DONE] Add workspace schema tests to generacy config tests
**File**: `packages/generacy/src/config/__tests__/schema.test.ts`
- Add test: config with valid `workspace` section passes validation
- Add test: config without `workspace` section still passes (optional field)
- Add test: config with invalid `workspace` section fails with Zod errors

---

## Phase 4: Update `generacy setup workspace`

### T016 [DONE] Replace `DEFAULT_REPOS` with config-based resolution
**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`
- Import `tryLoadWorkspaceConfig`, `getRepoNames`, `getWorkspaceRepos`, `findWorkspaceConfigPath` from `@generacy-ai/config`
- Remove `DEFAULT_REPOS` constant (lines 27-36)
- Update `resolveWorkspaceConfig()` (lines 51-80):
  - Keep CLI (`cliRepos`) and env (`envRepos`) as highest priority (unchanged)
  - When neither CLI nor env provides repos, try loading config:
    - Look for config at `{workdir}/tetrad-development/.generacy/config.yaml`
    - If found, use `getRepoNames(config)` for repo list
    - Also use `config.org` for `githubOrg` and `config.branch` for `branch` (as defaults, still overridable by env)
  - If config not found and no overrides, return only `['tetrad-development']` (bootstrap phase)
- Log the repo source: `"CLI flag"`, `"REPOS env var"`, `"config file"`, or `"bootstrap (config not found)"`

### T017 [DONE] Implement two-phase clone logic
**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`
- Update the `action` handler (lines 245-302):
  - After initial clone loop, if repos were bootstrapped (only tetrad-development):
    - Re-attempt config resolution from freshly cloned `{workdir}/tetrad-development/.generacy/config.yaml`
    - If config found, clone remaining repos from config
    - Re-run dependency installation for newly cloned repos
  - Preserve existing tetrad-development-first ordering logic (lines 267-273)
  - Log: `"Phase 2: Found config, cloning {N} additional repos"`

### T018 [DONE] [P] Use `parseRepoInput` for CLI `--repos` flag
**File**: `packages/generacy/src/cli/commands/setup/workspace.ts`
- Import `parseRepoList` from `@generacy-ai/config`
- When parsing `cliRepos` or `envRepos`, use `parseRepoList()` to support multi-format input (bare names, `owner/repo`, URLs)
- Extract repo names for the `repos` field and set `githubOrg` from parsed owner if consistent

---

## Phase 5: Update orchestrator startup (`orchestrator.ts`)

### T019 [DONE] Add config file fallback for monitored repos in `setupLabelMonitor()`
**File**: `packages/generacy/src/cli/commands/orchestrator.ts`
- Import `tryLoadWorkspaceConfig`, `getMonitoredRepos`, `findWorkspaceConfigPath`, `detectRepoDrift` from `@generacy-ai/config`
- Update repository resolution block (lines 206-227):
  - Keep existing CLI flag and `MONITORED_REPOS` env var as primary sources (unchanged)
  - Add fallback: if `reposStr` is empty, try loading workspace config:
    - Use `findWorkspaceConfigPath()` starting from `process.cwd()`
    - If found, use `getMonitoredRepos(config)` for `repositories`
  - If env var is set AND config exists, run `detectRepoDrift()` and log warning if they differ
  - Log the resolved repo count and source

---

## Phase 6: Update orchestrator config loader (`loader.ts`)

### T020 [DONE] Add `@generacy-ai/config` dependency to orchestrator package
**File**: `packages/orchestrator/package.json`
- Add `"@generacy-ai/config": "workspace:*"` to `dependencies`

### T021 [DONE] Add config file fallback for repositories in `loadFromEnv()`
**File**: `packages/orchestrator/src/config/loader.ts`
- Import `tryLoadWorkspaceConfig`, `getMonitoredRepos`, `findWorkspaceConfigPath` from `@generacy-ai/config`
- Update repository config block (lines 107-115):
  - Keep existing `MONITORED_REPOS` / `ORCHESTRATOR_REPOSITORIES` env vars as primary (unchanged)
  - Add `else` branch: if neither env var is set, try loading workspace config:
    - Use `findWorkspaceConfigPath()` from `process.cwd()`
    - If found, use `getMonitoredRepos(config)` for `config.repositories`
  - This is strictly a fallback — env vars always win

---

## Phase 7: Update job handler (`job-handler.ts`)

### T022 [DONE] Replace inline `MONITORED_REPOS` parsing with config-based lookup
**File**: `packages/generacy/src/orchestrator/job-handler.ts`
- Import `tryLoadWorkspaceConfig`, `getRepoWorkdir`, `findWorkspaceConfigPath`, `getRepoNames` from `@generacy-ai/config`
- Update `resolveJobWorkdir()` (lines 572-598):
  - Keep `MONITORED_REPOS` env var check as first source (backward compat)
  - Add fallback: if `MONITORED_REPOS` is empty/unset, try loading workspace config:
    - Use `findWorkspaceConfigPath()` from `this.workdir` or `process.cwd()`
    - If found, check if `owner/repo` matches any config repo
    - Use `getRepoWorkdir(repoName, basePath)` where `basePath` comes from `this.workdir` parent or `/workspaces`
  - Optional: cache loaded config on the `JobHandler` instance to avoid re-reading YAML on every job

---

## Phase 8: Integration tests

### T023 [DONE] [P] Write integration test for workspace command override priority
**File**: `packages/generacy/src/cli/commands/setup/__tests__/workspace.test.ts`
- Test: CLI `--repos` flag overrides everything
- Test: `REPOS` env var overrides config file
- Test: Config file is used when no CLI/env override
- Test: Bootstrap mode (no config, no overrides) → only `tetrad-development`
- Test: Two-phase clone triggers when config found after bootstrap
- Use temp directories with mock `.generacy/config.yaml` files

### T024 [DONE] [P] Write integration test for orchestrator monitored repos resolution
**File**: `packages/generacy/src/cli/commands/__tests__/orchestrator-repos.test.ts`
- Test: `MONITORED_REPOS` env var takes priority over config
- Test: Config file used as fallback when env var is empty
- Test: Drift detection logs warning when env and config differ
- Test: Error when no repos resolved from any source

### T025 [DONE] [P] Write integration test for orchestrator loader config fallback
**File**: `packages/orchestrator/src/config/__tests__/loader-workspace.test.ts`
- Test: `MONITORED_REPOS` env var still works as before
- Test: Config file fallback populates `config.repositories`
- Test: No config file, no env var → `repositories` remains empty/undefined

---

## Phase 9: Build validation and cleanup

### T026 [DONE] Run `pnpm install` and verify workspace linking
- Run `pnpm install` to link the new `@generacy-ai/config` workspace package
- Verify all three packages resolve the dependency correctly

### T027 [DONE] Run `pnpm build` across all packages
- Run `pnpm -r build` to verify TypeScript compilation succeeds
- Fix any type errors from new imports or schema changes

### T028 Run full test suite
- Run `pnpm -r test` across all packages
- Verify no regressions in existing tests
- Verify all new tests pass

### T029 [DONE] Update `agent.env.template` documentation (companion repo)
**File**: `tetrad-development/.devcontainer/agent.env.template` *(companion repo — may be out of scope)*
- Add comment: `# MONITORED_REPOS overrides .generacy/config.yaml — leave empty to use config file`
- Document that the config file is the source of truth
- Note: this may be tracked in a separate companion issue

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001-T007) must complete before Phase 2 (T008-T012)
- Phase 1 must complete before Phase 3 (T013-T015)
- Phase 3 must complete before Phase 4 (T016-T018)
- Phase 1 must complete before Phase 5 (T019)
- Phase 1 + T020 must complete before Phase 6 (T021)
- Phase 3 must complete before Phase 7 (T022)
- Phases 4-7 must complete before Phase 8 (T023-T025)
- Phases 4-8 must complete before Phase 9 (T026-T028)

**Parallel opportunities within phases**:
- Phase 1: T002, T003, T004, T005, T006 can all run in parallel after T001
- Phase 2: T008, T009, T010, T011, T012 are fully independent
- Phase 3: T013 must precede T014; T015 depends on T014
- Phase 4: T018 can run in parallel with T016/T017
- Phases 5, 6, 7: Can run in parallel with each other (after Phase 3)
- Phase 8: T023, T024, T025 are fully independent

**Critical path**:
```
T001 → T002 → T007 → T013 → T014 → T016 → T017 → T023 → T026 → T027 → T028
```

**Estimated scope**:
- New files: ~16 (package scaffold + source + tests)
- Modified files: ~8 (package.json × 2, schema.ts, workspace.ts, orchestrator.ts, loader.ts, job-handler.ts, existing tests)
- Deleted code: `DEFAULT_REPOS` constant (~10 lines)
