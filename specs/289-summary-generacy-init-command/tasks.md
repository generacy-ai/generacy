# Tasks: Integrate cluster-templates into `generacy init`

**Input**: `spec.md`, `plan.md`
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel with other [P] tasks in same phase (different files, no dependencies)
- **[Story]**: Which user story this task serves (US1-US5, or INFRA for cross-cutting)

---

## Phase 1: Template Schema & Context (Foundation)

### T001 [DONE] [INFRA] Add ClusterVariant type and ClusterContext schema to templates package
**File**: `packages/templates/src/schema.ts`
- Add `ClusterVariantSchema = z.enum(['standard', 'microservices'])`
- Add `ClusterVariant` type export
- Add `ClusterContextSchema = z.object({ variant: ClusterVariantSchema.default('standard') })`
- Add `ClusterContext` type export
- Add `cluster: ClusterContextSchema` to `TemplateContextSchema`
- Add optional `variant` field to `SingleRepoInput` and `MultiRepoInput` schemas

### T002 [DONE] [INFRA] Update context builders to accept and propagate variant
**File**: `packages/templates/src/builders.ts`
- Add `variant` parameter to `buildSingleRepoContext()` options
- Add `variant` parameter to `buildMultiRepoContext()` options
- Populate `cluster: { variant: options.variant ?? 'standard' }` in both builders
- Add `withVariant(context, variant)` modifier function (follows existing `withGeneratedBy` pattern)
- Update `quickSingleRepo` and `quickMultiRepo` helpers to accept optional variant

### T003 [DONE] [INFRA] Export new types and helpers from templates package
**File**: `packages/templates/src/index.ts`
- Export `ClusterVariant`, `ClusterContext`, `ClusterVariantSchema`, `ClusterContextSchema` from schema
- Export `withVariant` from builders

### T004 [DONE] [P] [INFRA] Extend CLI config schema with cluster.variant
**File**: `packages/generacy/src/config/schema.ts`
- Add `ClusterConfigSchema = z.object({ variant: z.enum(['standard', 'microservices']).default('standard') })`
- Add `cluster: ClusterConfigSchema.optional()` to `GeneracyConfigSchema`

---

## Phase 2: Cluster Template Files (Content)

### T005 [DONE] [P] [US1] Create standard variant Dockerfile template
**File**: `packages/templates/src/cluster/standard/Dockerfile.hbs`
- Multi-stage Dockerfile based on `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`
- Stage 1: Install GitHub CLI (`gh`)
- Stage 2: Install Generacy CLI + Claude Code
- `COPY --chmod=755` for scripts directory
- No Docker CE installation (standard = DooD)

### T006 [DONE] [P] [US1] Create standard variant docker-compose.yml template
**File**: `packages/templates/src/cluster/standard/docker-compose.yml.hbs`
- `redis` service with health check (`redis-cli ping`)
- `orchestrator` service: builds Dockerfile, `ROLE=orchestrator`, port mapping via `${ORCHESTRATOR_PORT:-3100}`
- `worker` service: `ROLE=worker`, scaled via `${WORKER_COUNT:-3}`
- Environment variables: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY` with `${..:-..}` fallbacks
- Volume mounts for workspace and state persistence
- `generacy` bridge network
- Use Handlebars for `{{project.name}}` in container names

### T007 [DONE] [P] [US1] Create standard variant devcontainer.json template
**File**: `packages/templates/src/cluster/standard/devcontainer.json.hbs`
- `"name": "{{project.name}}"`
- `"dockerComposeFile": "docker-compose.yml"`
- `"service": "orchestrator"`
- `"workspaceFolder"` based on primary repo (via `repoName` helper)
- `customizations.vscode.extensions` with Generacy extensions
- No Generacy Dev Container Feature (Dockerfile handles CLI install)

### T008 [DONE] [P] [US1] Create standard variant .env.template
**File**: `packages/templates/src/cluster/standard/env.template.hbs`
- `GITHUB_TOKEN=` with comment noting `GH_TOKEN` alias
- `ANTHROPIC_API_KEY=` with comment noting `CLAUDE_API_KEY` alias
- `REPO_URL={{repos.primary}}` (Handlebars-substituted default)
- `REPO_BRANCH={{defaults.baseBranch}}` (Handlebars-substituted default)
- `WORKER_COUNT=3`, `ORCHESTRATOR_PORT=3100` as runtime defaults
- `REDIS_URL=redis://redis:6379`

### T009 [DONE] [P] [US2] Create microservices variant Dockerfile template
**File**: `packages/templates/src/cluster/microservices/Dockerfile.hbs`
- Copy standard Dockerfile as base
- Add additional stage for Docker CE installation (`docker-ce`, `docker-ce-cli`, `containerd.io`)
- Include Docker group setup for DinD operation

### T010 [DONE] [P] [US2] Create microservices variant docker-compose.yml template
**File**: `packages/templates/src/cluster/microservices/docker-compose.yml.hbs`
- Copy standard docker-compose.yml as base
- Add `privileged: true` to worker service
- Add `ENABLE_DIND=true` environment variable to worker service

### T011 [DONE] [P] [US2] Create microservices variant devcontainer.json template
**File**: `packages/templates/src/cluster/microservices/devcontainer.json.hbs`
- Same structure as standard variant devcontainer.json
- May reference microservices-specific extensions if needed

### T012 [DONE] [P] [US2] Create microservices variant .env.template
**File**: `packages/templates/src/cluster/microservices/env.template.hbs`
- Copy standard env.template as base
- Add `ENABLE_DIND=true`

### T013 [DONE] [P] [US1] Create shared entrypoint-orchestrator.sh script
**File**: `packages/templates/src/cluster/shared/scripts/entrypoint-orchestrator.sh`
- Static file (no Handlebars)
- Source `setup-credentials.sh`
- Start orchestrator process
- Proper shebang and error handling (`set -e`)

### T014 [DONE] [P] [US1] Create shared entrypoint-worker.sh script
**File**: `packages/templates/src/cluster/shared/scripts/entrypoint-worker.sh`
- Static file (no Handlebars)
- Source `setup-credentials.sh`
- Conditionally source `setup-docker-dind.sh` if `ENABLE_DIND=true`
- Start worker process

### T015 [DONE] [P] [US1] Create shared setup-credentials.sh script
**File**: `packages/templates/src/cluster/shared/scripts/setup-credentials.sh`
- Static file (no Handlebars)
- Handle `${GITHUB_TOKEN:-$GH_TOKEN}` fallback
- Handle `${ANTHROPIC_API_KEY:-$CLAUDE_API_KEY}` fallback
- Configure `gh auth` and git credentials

### T016 [DONE] [P] [US2] Create setup-docker-dind.sh script
**File**: `packages/templates/src/cluster/shared/scripts/setup-docker-dind.sh`
- Static file (no Handlebars)
- Start `dockerd` daemon
- Wait for Docker socket availability
- Only included for microservices variant

### T017 [DONE] [INFRA] Update templates package.json files field
**File**: `packages/templates/package.json`
- Add `src/cluster` to the `files` array so cluster templates ship with the package

---

## Phase 3: Template Selection & Rendering Engine

### T018 [DONE] [US1] [US2] Rewrite selectTemplates() for variant-based routing
**File**: `packages/templates/src/renderer.ts`
- Keep shared templates (config.yaml, generacy.env.template, gitignore, extensions.json) unchanged
- Replace `isMultiRepo`-based devcontainer/compose selection with `context.cluster.variant` routing
- Add cluster variant Handlebars templates: `cluster/{variant}/Dockerfile.hbs`, `docker-compose.yml.hbs`, `devcontainer.json.hbs`, `env.template.hbs`
- Add shared static scripts: `entrypoint-orchestrator.sh`, `entrypoint-worker.sh`, `setup-credentials.sh`
- Conditionally add `setup-docker-dind.sh` when `variant === 'microservices'`
- Mark script files with `isStatic: true` to skip Handlebars rendering
- Old `single-repo/` and `multi-repo/` paths are no longer selected (effectively deprecated)

### T019 [DONE] [US1] Update config.yaml template to include cluster section
**File**: `packages/templates/src/shared/config.yaml.hbs`
- Add `cluster:` section with `variant: {{cluster.variant}}` after existing sections

---

## Phase 4: CLI Integration

### T020 [DONE] [US3] Add variant field to InitOptions type
**File**: `packages/generacy/src/cli/commands/init/types.ts`
- Add `variant: 'standard' | 'microservices'` to `InitOptions` interface

### T021 [DONE] [US3] Add --variant CLI flag to init command
**File**: `packages/generacy/src/cli/commands/init/index.ts`
- Add `.addOption(new Option('--variant <variant>', 'Cluster variant').choices(['standard', 'microservices']))` to command definition
- No default value on the Option (resolution in resolver.ts)

### T022 [DONE] [US1] [US3] [US4] Update option resolver with variant resolution
**File**: `packages/generacy/src/cli/commands/init/resolver.ts`
- In `extractFlags()`: extract `variant` from CLI flags
- In `loadExistingDefaults()`: read `config.cluster?.variant` from existing config
- In `resolveOptions()`: apply priority chain (flag > config > prompt > default)
- With `--yes` and no variant: default to `'standard'`
- With `--yes` and existing config: preserve config value (prevents silent downgrade)
- Add `variant: merged.variant ?? 'standard'` to final resolved options

### T023 [DONE] [US1] [US4] Add variant selection prompt
**File**: `packages/generacy/src/cli/commands/init/prompts.ts`
- Add variant to `ExistingDefaults` interface: `variant?: 'standard' | 'microservices'`
- Insert variant selection prompt before project name prompt using `p.select()`
- Options: "Standard (DooD)" with hint, "Microservices (DinD)" with hint
- Use existing variant from config as `initialValue` on re-init
- Skip prompt if variant already resolved from flags
- Update `loadExistingConfigDefaults()` to read `config.cluster?.variant`

### T024 [DONE] [US1] [US2] Pass variant through to context builders in init action
**File**: `packages/generacy/src/cli/commands/init/index.ts`
- Pass `variant: initOptions.variant` to `buildSingleRepoContext()` and `buildMultiRepoContext()`
- Ensure `context.cluster.variant` is populated for template selection

### T025 [DONE] [US1] Add chmod for shell scripts in writer
**File**: `packages/generacy/src/cli/commands/init/writer.ts`
- Import `chmodSync` from `node:fs`
- After `writeFileSync()`, check if `relativePath.endsWith('.sh')` and apply `chmodSync(fullPath, 0o755)`

### T026 [DONE] [US1] Update summary output with variant and .env.template next step
**File**: `packages/generacy/src/cli/commands/init/summary.ts`
- Update `printNextSteps()` to include step for copying `.devcontainer/.env.template` to `.devcontainer/.env`

### T027 [DONE] [US4] Add migration detection for old-format devcontainer.json
**File**: `packages/generacy/src/cli/commands/init/index.ts`
- Between conflict check and resolution steps, detect if existing `devcontainer.json` has `image` key but no `dockerComposeFile`
- Log `p.log.warn()` recommending overwrite to adopt new cluster format
- Wrap in try/catch for invalid JSON

---

## Phase 5: Validator Updates

### T028 [DONE] [P] [INFRA] Relax devcontainer.json validator for docker-compose templates
**File**: `packages/templates/src/validators.ts`
- Update `validateRenderedDevContainer()` to not require Generacy Dev Container Feature when `dockerComposeFile` is present
- Keep feature check for legacy non-compose devcontainer.json (if features section exists and no dockerComposeFile)

### T029 [DONE] [P] [INFRA] Add .env.template validator
**File**: `packages/templates/src/validators.ts`
- Add `validateRenderedEnvTemplate(content)` function
- Check content is not empty
- Check for required variables: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`
- Wire into `validateAllRenderedFiles()`: dispatch when path ends with `.env.template` and is under `.devcontainer`

### T030 [DONE] [P] [INFRA] Verify static shell scripts don't trigger undefined variable check
**File**: `packages/templates/src/validators.ts`
- Confirm `findUndefinedVariables()` regex targets `{{ }}` Handlebars syntax, not `${ }` bash syntax
- If shell scripts are ever run through `validateAllRenderedFiles()`, add `.sh` exclusion as safety
- Static files should skip Handlebars rendering entirely, so no changes expected

---

## Phase 6: Testing

### T031 [DONE] [P] [INFRA] Add unit tests for variant context building
**File**: `packages/templates/tests/unit/builders.test.ts` (extend existing)
- Test `buildSingleRepoContext()` with `variant: 'standard'` produces `context.cluster.variant === 'standard'`
- Test `buildSingleRepoContext()` with `variant: 'microservices'` produces correct variant
- Test `buildMultiRepoContext()` with both variants
- Test default variant is `'standard'` when not specified
- Test `withVariant()` modifier overrides existing variant

### T032 [DONE] [P] [INFRA] Add unit tests for variant-based template selection
**File**: `packages/templates/tests/unit/renderer.test.ts` (extend existing)
- Test `selectTemplates()` with standard variant returns correct template paths (`cluster/standard/*`)
- Test `selectTemplates()` with microservices variant includes DinD script
- Test `selectTemplates()` always includes shared templates (config, gitignore, extensions, env)
- Test `selectTemplates()` does NOT return old `single-repo/` or `multi-repo/` paths
- Test standard variant does NOT include `setup-docker-dind.sh`

### T033 [P] [US1] [US2] Add integration tests for cluster template rendering
**File**: `packages/templates/tests/integration/render-project.test.ts` (extend existing)
- Test `renderProject()` with standard variant generates all expected files (Dockerfile, compose, devcontainer.json, .env.template, 3 scripts)
- Test `renderProject()` with microservices variant generates additional DinD script (4 scripts total)
- Test variable substitution in Dockerfile produces valid Dockerfile syntax
- Test variable substitution in docker-compose.yml produces valid YAML
- Test variable substitution in devcontainer.json produces valid JSON with correct project name
- Test variable substitution in .env.template includes repo URL and branch
- Test static scripts are copied verbatim (no Handlebars processing)
- Test `validateAllRenderedFiles()` passes on both variant outputs

### T034 [P] [US1] [US2] Add snapshot tests for cluster template output
**File**: `packages/templates/tests/integration/snapshots.test.ts` (extend existing)
- Add snapshot for standard variant full output (all files)
- Add snapshot for microservices variant full output (all files)
- Ensure snapshots capture variable substitution results

### T035 [P] [US3] [US4] Add CLI variant resolution tests
**File**: `packages/generacy/src/cli/commands/init/__tests__/variant.test.ts` (new)
- Test `--variant standard` flag is extracted correctly by `extractFlags()`
- Test `--variant microservices` flag is extracted correctly
- Test invalid variant value (e.g., `--variant custom`) produces error from Commander.js choices validation
- Test variant resolution priority: flag > config > prompt > default
- Test `--yes` with no existing config defaults to `'standard'`
- Test `--yes` with existing microservices config preserves `'microservices'`
- Test `--variant` flag overrides config value
- Test variant appears in resolved `InitOptions`

### T036 [P] [INFRA] Add test fixtures for cluster variant contexts
**Files**:
- `packages/templates/tests/fixtures/standard-cluster-context.json`
- `packages/templates/tests/fixtures/microservices-cluster-context.json`
- Include all required `TemplateContext` fields with `cluster.variant` set appropriately

### T037 [INFRA] Update existing test snapshots that break from template changes
**Files**: various snapshot files under `packages/templates/tests/`
- Update any existing snapshots that reference old `single-repo/` or `multi-repo/` template paths
- Update context builder test expectations to include `cluster` field
- Ensure all existing tests pass with the new schema (no regressions)

### T038 [US5] Verify dry-run works with cluster template files
**File**: `packages/generacy/src/cli/__tests__/init.test.ts` (extend existing integration test)
- Test `generacy init --dry-run --yes --variant standard` lists all cluster template files
- Test `generacy init --dry-run --yes --variant microservices` includes DinD script in listing
- Test no files are written to disk
- Test "Would create" prefix on all cluster template file paths

---

## Phase 7: Cleanup & Documentation

### T039 [P] [INFRA] Deprecate old single-repo and multi-repo template directories
**Files**:
- `packages/templates/src/single-repo/devcontainer.json.hbs`
- `packages/templates/src/multi-repo/devcontainer.json.hbs`
- `packages/templates/src/multi-repo/docker-compose.yml.hbs`
- Add deprecation comment at top of each file: `{{!-- DEPRECATED: Replaced by cluster templates. Will be removed in a future version. --}}`
- Files remain in codebase but are no longer selected by `selectTemplates()`

### T040 [P] [INFRA] Run full test suite and fix any regressions
**Command**: `pnpm test`
- Run all tests in both `packages/templates` and `packages/generacy`
- Fix any failures from schema changes, template selection changes, or validator updates
- Ensure zero regressions (SC-004)

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001-T004) must complete before Phase 2 and Phase 3
- Phase 2 (T005-T017) must complete before Phase 3 (T018-T019)
- Phase 3 (T018-T019) must complete before Phase 4 (T020-T027)
- Phase 5 (T028-T030) can run in parallel with Phase 4
- Phase 6 (T031-T038) depends on Phase 4 + Phase 5
- Phase 7 (T039-T040) depends on all previous phases

**Parallel opportunities within phases**:
- Phase 1: T001 → T002 → T003 (sequential); T004 is parallel with T001-T003
- Phase 2: T005-T017 are all parallel (independent files)
- Phase 3: T018 → T019 (sequential, T019 depends on context shape from T018)
- Phase 4: T020 first, then T021-T027 can be partially parallelized:
  - T020 (types) must precede T021-T024
  - T021 (flag) and T023 (prompt) are parallel
  - T022 (resolver) depends on T020, T021, T023
  - T024 (context building) depends on T022
  - T025, T026, T027 are parallel with each other and with T022-T024
- Phase 5: T028, T029, T030 are all parallel
- Phase 6: T031-T036 are all parallel; T037 depends on T031-T036; T038 depends on all impl
- Phase 7: T039 and T040 are parallel; T040 is the final gate

**Critical path**:
T001 → T002 → T003 → T005-T017 (parallel) → T018 → T020 → T022 → T024 → T037 → T040
