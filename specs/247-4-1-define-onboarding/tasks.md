# Tasks: Define Onboarding PR Template Content

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Package Setup & Schema Definition

### T001 Create package directory structure
**Files**:
- `packages/templates/package.json`
- `packages/templates/tsconfig.json`
- `packages/templates/README.md`
- `packages/templates/src/index.ts`
- Create directory structure: `src/`, `tests/unit/`, `tests/integration/`, `tests/fixtures/`, `src/shared/`, `src/single-repo/`, `src/multi-repo/`
- Initialize package.json with dependencies (handlebars 4.7.8, js-yaml, zod 3.23.8)
- Configure tsconfig for library build
- Create placeholder README

### T002 Define Zod schemas and TypeScript types
**File**: `packages/templates/src/schema.ts`
- Define `ProjectContext` schema (id, name)
- Define `ReposContext` schema (isMultiRepo, primary, dev[], clone[])
- Define `DefaultsContext` schema (region, tier)
- Define `OrchestratorContext` schema (workerCount, pollIntervalMs)
- Define `DevContainerContext` schema (baseImage, featureTag)
- Define `MetadataContext` schema (generatedAt, schemaVersion)
- Define root `TemplateContext` schema combining all contexts
- Export TypeScript types from schemas
- Add JSDoc comments for all exported types

### T003 Add package to workspace
**File**: `/workspaces/generacy/package.json` (workspace root)
- Add `packages/templates` to workspace packages array
- Run `pnpm install` to link workspace dependencies

---

## Phase 2: Shared Templates

### T004 [P] Create config.yaml.hbs template
**File**: `packages/templates/src/shared/config.yaml.hbs`
- Add YAML header comment with generation timestamp
- Add project metadata section (id, name)
- Add repos section with conditional logic for dev/clone repos
- Add defaults section (region, tier)
- Add conditional orchestrator section (multi-repo only)
- Add metadata section (generated_at, schema_version)
- Use Handlebars conditionals for multi-repo vs single-repo
- Use `{{#each}}` loops for repo arrays

### T005 [P] Create generacy.env.template.hbs
**File**: `packages/templates/src/shared/generacy.env.template.hbs`
- Add header comment explaining this is a template
- Add GITHUB_TOKEN variable with description
- Add ANTHROPIC_API_KEY variable with description
- Add PROJECT_ID variable with template substitution
- Add REDIS_URL variable with default for local dev
- Add LOG_LEVEL variable with default
- Include comments explaining where to get each value

### T006 [P] Create .gitignore static file
**File**: `packages/templates/src/shared/.gitignore`
- Ignore `generacy.env` (secrets)
- Ignore `.agent-state/` directory
- Add comment explaining purpose
- Static file (no Handlebars templating)

### T007 [P] Create extensions.json.hbs template
**File**: `packages/templates/src/shared/extensions.json.hbs`
- Create recommendations array with Agency extension
- Add Generacy extension to recommendations
- Use JSON formatting (2-space indent)

---

## Phase 3: Single-Repo Templates

### T008 Create single-repo devcontainer.json.hbs
**File**: `packages/templates/src/single-repo/devcontainer.json.hbs`
- Set name from `{{project.name}}`
- Set image from `{{devcontainer.baseImage}}`
- Add features section with Generacy Dev Container Feature reference
- Use `{{devcontainer.featureTag}}` for feature version
- Add customizations.vscode.extensions array
- Include Agency and Generacy extensions
- Format as valid JSON

---

## Phase 4: Multi-Repo Templates

### T009 [P] Create multi-repo devcontainer.json.hbs
**File**: `packages/templates/src/multi-repo/devcontainer.json.hbs`
- Set name from `{{project.name}}`
- Reference docker-compose.yml
- Set service to "orchestrator"
- Add workspaceFolder pointing to primary repo
- Add workspace folder mappings for all repos (dev + clone)
- Use `{{#each repos.dev}}` and `{{#each repos.clone}}` loops
- Add customizations.vscode.extensions array
- Format as valid JSON

### T010 [P] Create docker-compose.yml.hbs
**File**: `packages/templates/src/multi-repo/docker-compose.yml.hbs`
- Define Redis service (ephemeral, no volumes)
- Define orchestrator service with Generacy feature
- Add environment variables from .generacy/generacy.env
- Add workspace volume mounts for all repos
- Define worker service with replicas from `{{orchestrator.workerCount}}`
- Add worker environment variables (REDIS_URL, POLL_INTERVAL_MS)
- Add healthchecks for Redis and orchestrator
- Use `{{#each}}` loops for repo volume mounts
- Format as valid YAML

---

## Phase 5: Rendering Engine

### T011 Implement template rendering functions
**File**: `packages/templates/src/renderer.ts`
- Import Handlebars and file system utilities
- Implement `loadTemplate(templatePath: string): string` helper
- Implement `renderTemplate(templatePath: string, context: TemplateContext): Promise<string>`
- Implement `selectTemplates(context: TemplateContext): string[]` logic
- Implement `renderProject(context: TemplateContext): Promise<Map<string, string>>`
- Map template paths to target paths (e.g., `shared/config.yaml.hbs` → `.generacy/config.yaml`)
- Handle static files (copy without rendering)
- Add error handling with clear messages

### T012 Register Handlebars helpers
**File**: `packages/templates/src/renderer.ts`
- Register `repoName` helper (extracts repo name from `owner/repo`)
- Register `json` helper (pretty-prints objects)
- Register `urlEncode` helper (URL-encodes strings)
- Add helper tests in comments/documentation

### T013 Implement extensions.json merge logic
**File**: `packages/templates/src/renderer.ts`
- Implement `renderExtensionsJson(context: TemplateContext, existingContent?: string): Promise<string>`
- Parse existing JSON if provided
- Merge recommendations arrays (use Set to deduplicate)
- Preserve existing properties
- Add Generacy extensions if not present
- Return formatted JSON string

---

## Phase 6: Validation

### T014 Implement pre-render validation
**File**: `packages/templates/src/validators.ts`
- Import Zod schemas from schema.ts
- Implement `validateContext(context: unknown): TemplateContext`
- Use Zod `.parse()` with try-catch
- Transform Zod errors into readable messages
- Return validated context or throw descriptive error

### T015 [P] Implement post-render validation
**File**: `packages/templates/src/validators.ts`
- Implement `validateRenderedConfig(yaml: string): void`
- Parse YAML and check required fields (project.id, repos)
- Implement `validateRenderedDevContainer(json: string): void`
- Parse JSON and check required fields (name, image/dockerComposeFile)
- Throw errors with line numbers if parsing fails
- Add helpful error messages for common mistakes

---

## Phase 7: Context Builder Helpers

### T016 Implement context builder utilities
**File**: `packages/templates/src/builders.ts`
- Implement `buildSingleRepoContext(options): TemplateContext`
- Implement `buildMultiRepoContext(options): TemplateContext`
- Apply defaults (baseImage: ubuntu, releaseStream: stable)
- Generate metadata (timestamp, schema version)
- Validate built context with validateContext()
- Export builder functions

---

## Phase 8: Public API

### T017 Export public API
**File**: `packages/templates/src/index.ts`
- Export `renderProject` from renderer.ts
- Export `renderTemplate` from renderer.ts
- Export `renderExtensionsJson` from renderer.ts
- Export `validateContext` from validators.ts
- Export all types from schema.ts
- Export context builders from builders.ts
- Add JSDoc comments for all exports
- Document parameter types and return values

---

## Phase 9: Testing

### T018 Create test fixtures
**Files**:
- `packages/templates/tests/fixtures/single-repo-context.json`
- `packages/templates/tests/fixtures/multi-repo-context.json`
- `packages/templates/tests/fixtures/invalid-context.json`
- `packages/templates/tests/fixtures/existing-extensions.json`
- Create realistic context objects for testing
- Include edge cases (minimal repos, many repos)
- Create invalid contexts for validation testing
- Create existing extensions.json for merge testing

### T019 Write renderer unit tests
**File**: `packages/templates/tests/unit/renderer.test.ts`
- Test `renderTemplate` with each template file
- Test Handlebars helper functions (repoName, json, urlEncode)
- Test template selection logic (single vs multi-repo)
- Test error handling for missing templates
- Test static file copying (.gitignore)
- Target: 80%+ coverage of renderer.ts

### T020 Write validator unit tests
**File**: `packages/templates/tests/unit/validators.test.ts`
- Test `validateContext` with valid contexts
- Test `validateContext` with invalid contexts (missing fields)
- Test `validateContext` error messages are helpful
- Test `validateRenderedConfig` with valid/invalid YAML
- Test `validateRenderedDevContainer` with valid/invalid JSON
- Target: 80%+ coverage of validators.ts

### T021 Write builder unit tests
**File**: `packages/templates/tests/unit/builders.test.ts`
- Test `buildSingleRepoContext` with minimal options
- Test `buildMultiRepoContext` with all options
- Test default value application
- Test metadata generation (timestamp format)
- Verify built contexts pass validation

### T022 Write integration tests
**File**: `packages/templates/tests/integration/render-project.test.ts`
- Test `renderProject` for single-repo project
- Verify correct number of files generated
- Verify file paths are correct
- Test `renderProject` for multi-repo project
- Verify docker-compose.yml included for multi-repo
- Test extensions.json merge with existing file
- Verify all generated files parse correctly (YAML/JSON)
- Test error propagation from validation failures

### T023 Write snapshot tests
**File**: `packages/templates/tests/integration/snapshots.test.ts`
- Create snapshot for config.yaml (single-repo)
- Create snapshot for config.yaml (multi-repo)
- Create snapshot for devcontainer.json (single-repo)
- Create snapshot for devcontainer.json (multi-repo)
- Create snapshot for docker-compose.yml
- Create snapshot for generacy.env.template
- Configure Jest/Vitest snapshot testing
- Commit initial snapshots to version control

### T024 Configure test runner and coverage
**Files**:
- `packages/templates/package.json`
- `packages/templates/vitest.config.ts` or `jest.config.js`
- Add test scripts to package.json (`test`, `test:watch`, `test:coverage`)
- Configure coverage thresholds (80% minimum)
- Configure test path patterns
- Set up TypeScript support for tests
- Add test dependencies (@types/jest or vitest)

---

## Phase 10: Documentation

### T025 Write package README
**File**: `packages/templates/README.md`
- Add package overview and purpose
- Document installation (`npm install @generacy-ai/templates`)
- Add usage examples for CLI scenario
- Add usage examples for cloud service scenario
- Document template context schema
- Document public API functions
- Add troubleshooting section
- List template files and their purposes
- Document Handlebars helpers
- Add contributing guidelines

### T026 Add inline documentation
**Files**:
- `packages/templates/src/schema.ts`
- `packages/templates/src/renderer.ts`
- `packages/templates/src/validators.ts`
- `packages/templates/src/builders.ts`
- Add JSDoc comments to all exported functions
- Document parameters with `@param` tags
- Document return values with `@returns` tags
- Add `@throws` tags for error cases
- Include usage examples in JSDoc `@example` tags

---

## Phase 11: Build and Publish Setup

### T027 Configure package build
**Files**:
- `packages/templates/package.json`
- `packages/templates/tsconfig.json`
- Configure TypeScript build output (dist/)
- Set package exports in package.json (main, types)
- Configure files array (include dist/, templates/, exclude tests/)
- Add build script (`tsc`)
- Add prepublish script
- Configure source maps

### T028 Add package metadata
**File**: `packages/templates/package.json`
- Set package name: `@generacy-ai/templates`
- Set version: `0.1.0`
- Add description
- Add repository URL
- Add keywords (generacy, templates, devcontainer, onboarding)
- Add license (MIT)
- Add author/contributors
- Set publishConfig for npm registry

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 (T001-T003) must complete before all other phases
- Phase 2-4 (T004-T010) can run in parallel after Phase 1
- Phase 5-6 (T011-T015) depend on Phase 1 (schema) and Phase 2-4 (templates exist)
- Phase 7 (T016) depends on Phase 1 (schema) and Phase 6 (validation)
- Phase 8 (T017) depends on Phases 5-7 (all implementation complete)
- Phase 9 (T018-T024) depends on Phases 1-8 (testing requires implementation)
- Phase 10 (T025-T026) can start after Phase 5-7 (document what exists)
- Phase 11 (T027-T028) can run in parallel with Phase 10

**Parallel opportunities within phases**:
- **Phase 2**: T004, T005, T006, T007 can all run in parallel (different files)
- **Phase 4**: T009 and T010 can run in parallel (different files)
- **Phase 6**: T014 and T015 can run in parallel (independent functions)
- **Phase 9**: T019, T020, T021 can run in parallel after T018 (different test files)
- **Phase 10**: T025 and T026 can run in parallel (different documentation types)
- **Phase 11**: T027 and T028 can run in parallel (different config concerns)

**Critical path**:
```
T001 → T002 → T004-T010 (parallel) → T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019-T023 (parallel) → T024 → T025 → T027 → Ready for consumption
```

**Estimated timeline**: 5 days
- Day 1: Phase 1 (T001-T003)
- Day 2: Phase 2-3 (T004-T008)
- Day 3: Phase 4 (T009-T010)
- Day 4: Phase 5-6 (T011-T015)
- Day 5: Phase 7-9 (T016-T024), Phase 10-11 (T025-T028)

---

## Success Criteria Checklist

- [ ] All 28 tasks completed
- [ ] Test coverage ≥80% across all source files
- [ ] All tests passing in local environment
- [ ] Package builds without errors (`pnpm build`)
- [ ] Generated templates validate against schemas
- [ ] Single-repo context generates 5 files
- [ ] Multi-repo context generates 6 files
- [ ] Extensions.json merge preserves existing recommendations
- [ ] No `{{undefined}}` in any rendered output
- [ ] README includes usage examples for CLI and cloud service
- [ ] All exported functions have JSDoc comments
- [ ] Package ready for npm publish (phase complete, not actually published)

---

## Notes

- **Template storage location**: `generacy/packages/templates/` (not a separate repo)
- **Package name**: `@generacy-ai/templates` (scoped to generacy-ai org)
- **Testing framework**: Use existing Generacy project standard (likely Vitest)
- **Downstream consumers**: CLI (`generacy init`) and cloud service (PR generation)
- **Dev Container Feature reference**: This package can be developed/tested before feature is published (use `:preview` tag for testing)
- **Coordination needed**: Issue #248 (config.yaml schema) should be reviewed for alignment with config.yaml.hbs template
