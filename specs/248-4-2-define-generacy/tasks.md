# Tasks: Define .generacy/config.yaml Schema

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Schema Definition and Validation

### T001 Create Zod schema types
**File**: `packages/generacy/src/config/schema.ts`
- Define `ProjectConfigSchema` with id and name validation
- Define `ReposConfigSchema` with primary, dev, and clone arrays
- Define `DefaultsConfigSchema` with agent and baseBranch
- Define `OrchestratorSettingsSchema` with pollIntervalMs and workerCount
- Define root `GeneracyConfigSchema` with optional schemaVersion
- Export TypeScript types inferred from schemas
- Add validation rules:
  - `project.id`: Regex `/^proj_[a-z0-9]+$/`, min 12 chars
  - `project.name`: Non-empty string, max 255 chars
  - Repository URLs: Format `github.com/{owner}/{repo}`
  - `defaults.agent`: Kebab-case format `/^[a-z0-9]+(-[a-z0-9]+)*$/`
  - `defaults.baseBranch`: Non-empty string
  - `orchestrator.pollIntervalMs`: Min 5000
  - `orchestrator.workerCount`: Min 1, max 20
  - `schemaVersion`: Default to "1" if omitted

### T002 Create custom validators
**File**: `packages/generacy/src/config/validator.ts`
- Implement repository deduplication check
- Check primary repo not in dev list
- Check primary repo not in clone list
- Check no overlap between dev and clone lists
- Return clear error messages with conflicting repo URLs

### T003 Create config module exports
**File**: `packages/generacy/src/config/index.ts`
- Export all schemas from schema.ts
- Export all types from schema.ts
- Export validator functions from validator.ts
- Export loader functions (to be implemented in Phase 2)

---

## Phase 2: Config Discovery and Loading

### T004 Implement config file discovery
**File**: `packages/generacy/src/config/loader.ts`
- Implement `findConfigFile()` function
- Walk up directory tree from startDir
- Check for `.generacy/config.yaml` in each directory
- Stop at repository root (detect `.git/` directory)
- Return config path or null if not found
- Support `GENERACY_CONFIG_PATH` env var override

### T005 Implement config loader
**File**: `packages/generacy/src/config/loader.ts`
- Implement `loadConfig()` function
- Use findConfigFile() for discovery
- Parse YAML content using `yaml` package
- Validate with Zod schemas
- Run custom validators
- Throw errors with helpful messages (file not found, parse errors, validation errors)
- Implement `parseConfig()` helper for YAML string parsing
- Implement `validateConfig()` helper for object validation

### T006 Update config exports with loader
**File**: `packages/generacy/src/config/index.ts`
- Export `loadConfig` function
- Export `findConfigFile` function
- Export `parseConfig` function
- Export `validateConfig` function
- Export `LoadConfigOptions` interface

---

## Phase 3: CLI Integration and Subpath Exports

### T007 Configure package.json subpath exports
**File**: `packages/generacy/package.json`
- Add subpath exports configuration
- Export main entry: `"."` → `./dist/index.js`
- Export config subpath: `"./config"` → `./dist/config/index.js`
- Include TypeScript types in exports
- Ensure build output structure supports subpaths

### T008 Create validate-config CLI command
**File**: `packages/generacy/src/cli/commands/validate.ts`
- Implement `validate-config` command
- Accept optional `--config <path>` flag
- Load config using loadConfig()
- Print success message if valid
- Print error details if invalid
- Exit with code 0 for valid, 1 for invalid
- Handle file not found errors gracefully

### T009 Register validate command in CLI
**File**: `packages/generacy/src/cli/index.ts` (or equivalent)
- Register `validate-config` command
- Wire up command handler
- Add command help text

### T010 Update main package exports
**File**: `packages/generacy/src/index.ts`
- Ensure config module is re-exported for subpath access
- Verify TypeScript types are properly exported
- Add JSDoc comments for public API

---

## Phase 4: Documentation and Examples

### T011 [P] Write config schema documentation
**File**: `packages/generacy/src/config/README.md`
- Document complete schema reference
- Describe each field with type and constraints
- List all validation rules
- Document default values
- Explain discovery algorithm
- Document environment variables
- Include migration notes for schema versioning

### T012 [P] Create example: minimal config
**File**: `packages/generacy/examples/config-minimal.yaml`
- Create minimal valid configuration
- Include only required fields (project + primary repo)
- Add comments explaining required fields

### T013 [P] Create example: single-repo project
**File**: `packages/generacy/examples/config-single-repo.yaml`
- Create single-repo project with all optional fields
- Include defaults and orchestrator settings
- Add comments explaining each section

### T014 [P] Create example: multi-repo project
**File**: `packages/generacy/examples/config-multi-repo.yaml`
- Create multi-repo project with dev and clone lists
- Include multiple repos in each list
- Add comments explaining repo relationships

---

## Phase 5: Testing

### T015 [P] Write schema validation unit tests
**File**: `packages/generacy/src/config/__tests__/schema.test.ts`
- Test valid config parsing (all fields)
- Test valid config parsing (minimal fields)
- Test invalid project ID format
- Test invalid agent name format
- Test invalid repository URL format
- Test out-of-range orchestrator settings
- Test schema version defaulting to "1"
- Test empty/omitted dev and clone arrays
- Test project name max length validation
- Test pollIntervalMs minimum value
- Test workerCount range validation

### T016 [P] Write validator unit tests
**File**: `packages/generacy/src/config/__tests__/validator.test.ts`
- Test duplicate: primary in dev list
- Test duplicate: primary in clone list
- Test duplicate: dev in clone list
- Test duplicate: same repo in all three lists
- Test valid: no duplicates across lists
- Test valid: same owner, different repos
- Test error messages include conflicting URLs

### T017 [P] Write loader unit tests
**File**: `packages/generacy/src/config/__tests__/loader.test.ts`
- Test find config in current directory
- Test find config in parent directory
- Test find config in grandparent directory
- Test stop at repository root (.git/)
- Test config not found error
- Test invalid YAML error with line number
- Test validation error formatting
- Test `GENERACY_CONFIG_PATH` env var override
- Test `loadConfig` with explicit configPath option
- Test helpful error messages for common mistakes

### T018 [P] Write CLI command tests
**File**: `packages/generacy/src/cli/__tests__/validate.test.ts`
- Test valid config returns exit code 0
- Test invalid config returns exit code 1
- Test config not found returns exit code 1
- Test error messages printed to stderr
- Test success message printed to stdout
- Test `--config` flag override

### T019 [P] Write subpath export integration tests
**File**: `packages/generacy/__tests__/exports.test.ts`
- Test import from `@generacy-ai/generacy/config`
- Test TypeScript types available
- Test loadConfig function exported
- Test schemas exported
- Test validator functions exported
- Test types can be used in type annotations

### T020 Create test fixtures
**Files**:
- `packages/generacy/src/config/__tests__/fixtures/valid-minimal.yaml`
- `packages/generacy/src/config/__tests__/fixtures/valid-full.yaml`
- `packages/generacy/src/config/__tests__/fixtures/invalid-duplicate-repos.yaml`
- `packages/generacy/src/config/__tests__/fixtures/invalid-project-id.yaml`
- `packages/generacy/src/config/__tests__/fixtures/invalid-yaml-syntax.yaml`
- Create valid minimal config fixture
- Create valid full config fixture
- Create invalid configs for error cases
- Create directory structure for discovery tests

---

## Phase 6: Integration and Verification

### T021 Verify package builds correctly
**Commands**:
- `pnpm build` in packages/generacy
- `tsc --noEmit` to check types
- Test coverage: `pnpm test --coverage`
- Verify dist/ output structure matches exports

### T022 Manual CLI testing
**Tasks**:
- Test `generacy validate-config` in real project
- Test discovery from nested directories
- Test error messages are helpful
- Test environment variable override
- Verify exit codes

### T023 Document integration for downstream packages
**File**: `packages/generacy/src/config/README.md` (update)
- Add section on using config from orchestrator
- Add section on using config from VS Code extension
- Include TypeScript import examples
- Document subpath import patterns

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (loader needs schemas)
- Phase 2 must complete before Phase 3 (CLI needs loader)
- Phase 3 must complete before Phase 4 (examples reference schema)
- Phase 5 can start after Phase 2 completes (tests can be written in parallel with Phase 3-4)
- Phase 6 requires all previous phases complete

**Parallel opportunities within phases**:
- Phase 1: T001, T002, T003 are sequential (T003 depends on T001+T002)
- Phase 2: T004, T005, T006 are sequential
- Phase 3: T007, T008, T009, T010 are sequential
- Phase 4: T011, T012, T013, T014 can all run in parallel [P]
- Phase 5: T015, T016, T017, T018, T019 can all run in parallel [P] after T020

**Critical path**:
T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010 → T015-T020 → T021 → T022 → T023

**Estimated effort**:
- Phase 1: 1-2 hours
- Phase 2: 1-2 hours
- Phase 3: 1 hour
- Phase 4: 30-60 minutes
- Phase 5: 2-3 hours
- Phase 6: 30 minutes
- **Total**: 6-9 hours

---

## Test Coverage Requirements

**Minimum coverage targets**:
- Schema validation: >95% (critical path)
- Config loader: >90% (important logic)
- CLI commands: >80% (user-facing)
- Overall package: >90%

**Critical test scenarios**:
1. Valid configs (minimal and full)
2. All validation rules enforced
3. Discovery algorithm correctness
4. Error message quality
5. Subpath exports work correctly
6. CLI exit codes correct
