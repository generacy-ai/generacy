# Tasks: Migrate Contracts Types to Latency

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] Description`
- **[P]**: Can run in parallel (different files, no dependencies)

---

## Phase 1: Audit and Categorization

### T001 [DONE] Generate export inventory for contracts package
**Action**: Count and categorize all exports
- Run `rg "^export" src/ --type ts | wc -l` in contracts repo
- Count exports by directory (common/, orchestration/, telemetry/, etc.)
- Document total export count (~1152 expected)
- Generate per-directory export counts

### T002 [DONE] Create migration manifest JSON
**File**: `/workspaces/generacy/specs/246-1-9-migrate-contracts/migration-manifest.json`
- Define schema with version, timestamp, sources array
- Document each source directory with:
  - path (contracts source)
  - destination (latency or agency target)
  - fileCount
  - exportCount
  - testCount
  - dependencies array
- Include all directories: common/, orchestration/, version-compatibility/, telemetry/, schemas/, etc.

### T003 [DONE] Verify zero active dependencies
**Action**: Search all repos for contracts imports
- Search latency repo: `rg "@generacy-ai/contracts" /workspaces/latency/src/`
- Search agency repo: `rg "@generacy-ai/contracts" /workspaces/agency/src/`
- Search generacy repo: `rg "@generacy-ai/contracts" /workspaces/generacy/src/`
- Search generacy-cloud repo: `rg "@generacy-ai/contracts" /workspaces/generacy-cloud/src/`
- Verify humancy only has `file:` dependency
- Document findings in audit report

### T004 [DONE] Document test coverage baseline
**Files**:
- `/workspaces/generacy/specs/246-1-9-migrate-contracts/test-baseline.json`
- `/workspaces/generacy/specs/246-1-9-migrate-contracts/coverage-baseline.txt`
- Run `pnpm test` in contracts repo
- Generate JSON test report
- Generate coverage report
- Document test-to-source ratio per module
- Identify cross-module test dependencies

### T005 [DONE] Create audit report
**File**: `/workspaces/generacy/specs/246-1-9-migrate-contracts/audit-report.md`
- Summarize export counts by module
- List dependencies (ulid, zod, zod-to-json-schema)
- Document test coverage percentages
- Confirm zero active dependencies
- Note any special migration considerations

---

## Phase 2: Prepare Destination Repositories

### T006 [DONE] [P] Create latency directory structure
**Directories**: `/workspaces/latency/packages/latency/src/`
- Create `common/` directory
- Create `orchestration/` directory
- Create `versioning/` directory
- Create `types/` with subdirectories:
  - `agency-generacy/`
  - `agency-humancy/`
  - `generacy-humancy/`
  - `decision-model/`
  - `extension-comms/`
  - `knowledge-store/`
  - `learning-loop/`
  - `attribution-metrics/`
  - `data-export/`
  - `github-app/`
- Create `api/` with subdirectories:
  - `auth/`
  - `organization/`
  - `subscription/`

### T007 [DONE] [P] Add README files to latency directories
**Files**: Multiple README.md files in latency/src/
- Create `common/README.md` with purpose statement
- Create `orchestration/README.md` with purpose statement
- Create `versioning/README.md` with purpose statement
- Create `types/README.md` with purpose statement
- Create `api/README.md` with purpose statement

### T008 [DONE] [P] Create agency directory structure
**Directories**: `/workspaces/agency/packages/agency/src/`
- Create `tools/naming/` directory
- Create `telemetry/events/` directory
- Create `output/schemas/` directory (if doesn't exist)
- Create `schemas/` directory

### T009 [DONE] [P] Add README files to agency directories
**Files**: Multiple README.md files in agency/src/
- Create `tools/naming/README.md` with purpose statement
- Create `telemetry/events/README.md` with purpose statement
- Create `schemas/README.md` with purpose statement

### T010 [DONE] Update latency package.json dependencies
**File**: `/workspaces/latency/packages/latency/package.json`
- Add `"ulid": "^3.0.2"` to dependencies
- Verify `"zod": "^3.23.8"` is present (or higher version)
- Run `pnpm install` in latency package

### T011 [DONE] Update agency package.json dependencies
**File**: `/workspaces/agency/packages/agency/package.json`
- Verify `"zod"` is present (should be 3.24.1 or compatible)
- Add `"zod-to-json-schema": "^3.23.5"` to dependencies
- Run `pnpm install` in agency package

### T012 [DONE] [P] Verify TypeScript configurations
**Files**:
- `/workspaces/latency/packages/latency/tsconfig.json`
- `/workspaces/agency/packages/agency/tsconfig.json`
- Verify new directories are included in compilation
- Update path aliases if needed
- Check no strict excludes for new directories

---

## Phase 3: Migrate Shared Foundation to Latency

### T013 [DONE] Migrate contracts/common/ to latency
**Source**: `/workspaces/contracts/src/common/`
**Destination**: `/workspaces/latency/packages/latency/src/common/`
- Copy all .ts files from common/ directory
- Copy __tests__ directory if exists
- Migrate files:
  - `ids.ts` (ULID generators)
  - `timestamps.ts` (ISO timestamp utilities)
  - `pagination.ts` (pagination schemas)
  - `errors.ts` (ErrorCode, ErrorResponse)
  - `urgency.ts` (Urgency enum)
  - `config.ts` (BaseConfig schema)
  - `message-envelope.ts` (MessageEnvelope)
  - `version.ts` (SemVer utilities)
  - `capability.ts` (Capability system)
  - `extended-meta.ts` (Plugin metadata)

### T014 [DONE] Fix imports in latency/common/
**Directory**: `/workspaces/latency/packages/latency/src/common/`
- Update relative import paths within common/
- Remove or update .js extensions to match conventions
- Add imports from '@generacy-ai/latency' if needed for cross-module refs
- Verify all imports resolve correctly

### T015 [DONE] Create latency/common/index.ts
**File**: `/workspaces/latency/packages/latency/src/common/index.ts`
- Export all types and utilities from ids.ts
- Export all from timestamps.ts
- Export all from pagination.ts
- Export all from errors.ts
- Export all from urgency.ts
- Export all from config.ts
- Export all from message-envelope.ts
- Export all from version.ts
- Export all from capability.ts
- Export all from extended-meta.ts

### T016 [DONE] Migrate contracts/orchestration/ to latency
**Source**: `/workspaces/contracts/src/orchestration/`
**Destination**: `/workspaces/latency/packages/latency/src/orchestration/`
- Copy all .ts files from orchestration/ directory
- Copy __tests__ directory if exists
- Migrate files:
  - `work-item.ts` (WorkItem schemas)
  - `agent-info.ts` (AgentInfo schemas)
  - `events.ts` (Orchestration events)
  - `status.ts` (Status enums)

### T017 [DONE] Fix imports in latency/orchestration/
**Directory**: `/workspaces/latency/packages/latency/src/orchestration/`
- Update imports from contracts/common to ../common or @generacy-ai/latency
- Update relative import paths within orchestration/
- Verify all imports resolve correctly

### T018 [DONE] Create latency/orchestration/index.ts
**File**: `/workspaces/latency/packages/latency/src/orchestration/index.ts`
- Export all from work-item.ts
- Export all from agent-info.ts
- Export all from events.ts
- Export all from status.ts

### T019 [DONE] Migrate contracts/version-compatibility/ to latency
**Source**: `/workspaces/contracts/src/version-compatibility/`
**Destination**: `/workspaces/latency/packages/latency/src/versioning/`
- Copy all .ts files from version-compatibility/ directory
- Copy __tests__ directory if exists
- Migrate files:
  - `capability-registry.ts`
  - `versioned-schemas.ts`
  - `deprecation-warnings.ts`

### T020 [DONE] Fix imports in latency/versioning/
**Directory**: `/workspaces/latency/packages/latency/src/versioning/`
- Update imports from contracts/common to ../common or @generacy-ai/latency
- Update relative import paths
- Verify all imports resolve correctly

### T021 [DONE] Create latency/versioning/index.ts
**File**: `/workspaces/latency/packages/latency/src/versioning/index.ts`
- Export all from capability-registry.ts
- Export all from versioned-schemas.ts
- Export all from deprecation-warnings.ts

### T022 [DONE] Migrate contracts/agency-generacy/ to latency/types/
**Source**: `/workspaces/contracts/src/agency-generacy/`
**Destination**: `/workspaces/latency/packages/latency/src/types/agency-generacy/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T023 [DONE] Migrate contracts/agency-humancy/ to latency/types/
**Source**: `/workspaces/contracts/src/agency-humancy/`
**Destination**: `/workspaces/latency/packages/latency/src/types/agency-humancy/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T024 [DONE] Migrate contracts/generacy-humancy/ to latency/types/
**Source**: `/workspaces/contracts/src/generacy-humancy/`
**Destination**: `/workspaces/latency/packages/latency/src/types/generacy-humancy/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T025 [DONE] Migrate contracts/schemas/decision-model/ to latency/types/
**Source**: `/workspaces/contracts/src/schemas/decision-model/`
**Destination**: `/workspaces/latency/packages/latency/src/types/decision-model/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T026 [DONE] Migrate contracts/schemas/extension-comms/ to latency/types/
**Source**: `/workspaces/contracts/src/schemas/extension-comms/`
**Destination**: `/workspaces/latency/packages/latency/src/types/extension-comms/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T027 [DONE] Migrate contracts/schemas/knowledge-store/ to latency/types/
**Source**: `/workspaces/contracts/src/schemas/knowledge-store/`
**Destination**: `/workspaces/latency/packages/latency/src/types/knowledge-store/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T028 [DONE] Migrate contracts/schemas/learning-loop/ to latency/types/
**Source**: `/workspaces/contracts/src/schemas/learning-loop/`
**Destination**: `/workspaces/latency/packages/latency/src/types/learning-loop/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T029 [DONE] Migrate contracts/schemas/attribution-metrics/ to latency/types/
**Source**: `/workspaces/contracts/src/schemas/attribution-metrics/`
**Destination**: `/workspaces/latency/packages/latency/src/types/attribution-metrics/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T030 [DONE] Migrate contracts/schemas/data-export/ to latency/types/
**Source**: `/workspaces/contracts/src/schemas/data-export/`
**Destination**: `/workspaces/latency/packages/latency/src/types/data-export/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T031 [DONE] Migrate contracts/schemas/github-app/ to latency/types/
**Source**: `/workspaces/contracts/src/schemas/github-app/`
**Destination**: `/workspaces/latency/packages/latency/src/types/github-app/`
- Copy entire directory structure
- Copy all .ts files
- Copy __tests__ directory if exists

### T032 [DONE] Migrate contracts/schemas/platform-api/ to latency/api/
**Source**: `/workspaces/contracts/src/schemas/platform-api/`
**Destination**: `/workspaces/latency/packages/latency/src/api/`
- Copy subdirectories: auth/, organization/, subscription/
- Copy all .ts files from each subdirectory
- Copy __tests__ directories if exist

### T033 Fix imports in all latency/types/ subdirectories
**Directory**: `/workspaces/latency/packages/latency/src/types/`
- Update imports from contracts/common to ../../common or @generacy-ai/latency
- Update cross-references within types/ subdirectories
- Verify all imports resolve correctly
- Update all index.ts files if they exist

### T034 Create latency/types/index.ts
**File**: `/workspaces/latency/packages/latency/src/types/index.ts`
- Export all from agency-generacy/
- Export all from agency-humancy/
- Export all from generacy-humancy/
- Export all from decision-model/
- Export all from extension-comms/
- Export all from knowledge-store/
- Export all from learning-loop/
- Export all from attribution-metrics/
- Export all from data-export/
- Export all from github-app/

### T035 Fix imports in latency/api/ subdirectories
**Directory**: `/workspaces/latency/packages/latency/src/api/`
- Update imports from contracts/common to ../common or @generacy-ai/latency
- Verify all imports resolve correctly
- Update all index.ts files if they exist

### T036 Create latency/api/index.ts
**File**: `/workspaces/latency/packages/latency/src/api/index.ts`
- Export all from auth/
- Export all from organization/
- Export all from subscription/

### T037 Update latency main index.ts
**File**: `/workspaces/latency/packages/latency/src/index.ts`
- Keep existing exports (composition, facets, runtime)
- Add: `export * from './common/index.js';`
- Add: `export * from './orchestration/index.js';`
- Add: `export * from './versioning/index.js';`
- Add: `export * from './types/index.js';`
- Add: `export * from './api/index.js';`

### T038 Run latency tests
**Action**: Test migrated code in latency
- Run `pnpm test` in latency package
- Verify all tests pass
- Fix any test import issues
- Document any test failures for investigation

### T039 Run latency typecheck
**Action**: Verify no TypeScript errors
- Run `pnpm typecheck` or `tsc --noEmit` in latency package
- Fix any type errors
- Verify all imports resolve
- Document any unresolved issues

### T040 Build latency package
**Action**: Verify clean build
- Run `pnpm build` in latency package
- Verify build succeeds with exit code 0
- Check no build warnings related to migrated code
- Verify output files are generated correctly

---

## Phase 4: Migrate Tool Schemas to Agency

### T041 Migrate contracts/schemas/tool-naming/ to agency
**Source**: `/workspaces/contracts/src/schemas/tool-naming/`
**Destination**: `/workspaces/agency/packages/agency/src/tools/naming/`
- Copy all .ts files
- Copy __tests__ directory if exists
- Migrate files:
  - `tool-name.schema.ts`
  - `tool-prefix.schema.ts`
  - `parser.ts`
  - `index.ts` (or create if missing)

### T042 Fix imports in agency/tools/naming/
**Directory**: `/workspaces/agency/packages/agency/src/tools/naming/`
- Update imports from contracts to @generacy-ai/latency or local paths
- Update relative import paths
- Verify all imports resolve correctly

### T043 Update agency/tools/index.ts
**File**: `/workspaces/agency/packages/agency/src/tools/index.ts`
- Keep existing exports (registry, validation)
- Add: `export * from './naming/index.js';`

### T044 Migrate contracts/telemetry/ to agency
**Source**: `/workspaces/contracts/src/telemetry/`
**Destination**: `/workspaces/agency/packages/agency/src/telemetry/events/`
- Copy all .ts files
- Copy __tests__ directory if exists
- Migrate files:
  - `tool-call-event.ts`
  - `tool-stats.ts`
  - `error-category.ts`
  - `time-window.ts`
  - `anonymous-tool-metric.ts`

### T045 Fix imports in agency/telemetry/events/
**Directory**: `/workspaces/agency/packages/agency/src/telemetry/events/`
- Update imports from contracts/common to @generacy-ai/latency
- Update relative import paths
- Verify all imports resolve correctly

### T046 Create agency/telemetry/events/index.ts
**File**: `/workspaces/agency/packages/agency/src/telemetry/events/index.ts`
- Export all from tool-call-event.ts
- Export all from tool-stats.ts
- Export all from error-category.ts
- Export all from time-window.ts
- Export all from anonymous-tool-metric.ts

### T047 Migrate contracts/schemas/tool-result/ to agency
**Source**: `/workspaces/contracts/src/schemas/tool-result/`
**Destination**: `/workspaces/agency/packages/agency/src/output/schemas.ts`
- Copy TerseToolResultSchema and related types
- Merge with existing output/terse/ if applicable
- Create schemas.ts if it doesn't exist
- Preserve any existing output schemas

### T048 Fix imports in agency/output/schemas.ts
**File**: `/workspaces/agency/packages/agency/src/output/schemas.ts`
- Update imports from contracts to @generacy-ai/latency
- Verify integration with existing TerseOutput class
- Update relative import paths

### T049 Migrate contracts/generated/ to agency/schemas/
**Source**: `/workspaces/contracts/src/generated/`
**Destination**: `/workspaces/agency/packages/agency/src/schemas/`
- Copy tool-result.schema.json
- Copy any other generated schema files
- Migrate generation script if exists
- Update script paths to run from agency location

### T050 Create agency/schemas/index.ts if needed
**File**: `/workspaces/agency/packages/agency/src/schemas/index.ts`
- Export references to schema files if needed for programmatic access
- Document schema usage

### T051 Update agency main index.ts
**File**: `/workspaces/agency/packages/agency/src/index.ts`
- Keep existing exports
- Add: `export * from './tools/naming/index.js';`
- Add: `export * from './telemetry/events/index.js';`
- Add: `export * from './output/schemas.js';`

### T052 Update agency/telemetry/index.ts
**File**: `/workspaces/agency/packages/agency/src/telemetry/index.ts`
- Keep existing exports (interceptor, etc.)
- Add: `export * from './events/index.js';`

### T053 Run agency tests
**Action**: Test migrated code in agency
- Run `pnpm test` in agency package
- Verify all tests pass
- Fix any test import issues
- Document any test failures for investigation

### T054 Run agency typecheck
**Action**: Verify no TypeScript errors
- Run `pnpm typecheck` or `tsc --noEmit` in agency package
- Fix any type errors
- Verify all imports resolve (including @generacy-ai/latency)
- Document any unresolved issues

### T055 Build agency package
**Action**: Verify clean build
- Run `pnpm build` in agency package
- Verify build succeeds with exit code 0
- Check no build warnings related to migrated code
- Verify output files are generated correctly

---

## Phase 5: Verification and Cleanup

### T056 [P] Run cross-repository integration tests - latency
**Action**: Full latency build and test
- Change to latency root directory
- Run `pnpm build`
- Run `pnpm test`
- Verify all tests pass
- Document any issues

### T057 [P] Run cross-repository integration tests - agency
**Action**: Full agency build and test
- Change to agency root directory
- Run `pnpm build` (depends on latency via link:)
- Run `pnpm test`
- Verify all tests pass
- Document any issues

### T058 [P] Run cross-repository integration tests - generacy
**Action**: Verify generacy still builds
- Change to generacy root directory
- Run `pnpm build`
- Run `pnpm test`
- Verify no regressions from latency/agency changes
- Document any issues

### T059 Verify export completeness
**Action**: Compare export counts
- Run export verification script
- Count exports in contracts: `rg "^export" /workspaces/contracts/src --type ts | wc -l`
- Count exports in latency: `rg "^export" /workspaces/latency/packages/latency/src --type ts | wc -l`
- Count exports in agency: `rg "^export" /workspaces/agency/packages/agency/src --type ts | wc -l`
- Verify total matches expected ~1152
- Document any discrepancies

### T060 Test latency exports programmatically
**Action**: Verify exports are accessible
- Run: `node -e "import('@generacy-ai/latency').then(m => console.log(Object.keys(m)))"`
- Verify key exports are present
- Test sample imports in a test file

### T061 Test agency exports programmatically
**Action**: Verify exports are accessible
- Run: `node -e "import('@generacy-ai/agency').then(m => console.log(Object.keys(m)))"`
- Verify key exports are present
- Test sample imports in a test file

### T062 Update latency README
**File**: `/workspaces/latency/packages/latency/README.md`
- Document new modules section:
  - Common (foundation types)
  - Orchestration (work distribution)
  - Types (cross-component contracts)
  - Versioning (capability negotiation)
  - API (platform API contracts)
- Update package description
- Add usage examples for key exports

### T063 Update agency README
**File**: `/workspaces/agency/packages/agency/README.md`
- Document enhanced modules:
  - Tools (with naming conventions)
  - Telemetry (with event tracking)
  - Output (with enhanced schemas)
- Update package description
- Add usage examples for new exports

### T064 Create contracts migration guide
**File**: `/workspaces/generacy/specs/246-1-9-migrate-contracts/contracts-migration-guide.md`
- Document what changed
- Create import mapping table (old → new)
- Provide before/after code examples
- Create full export migration map
- Add troubleshooting section

### T065 Create export verification script
**File**: `/workspaces/generacy/specs/246-1-9-migrate-contracts/verify-exports.sh`
- Script to compare export counts
- Show before/after breakdown
- Exit with error if mismatch exceeds tolerance
- Make script executable

### T066 Create import update script
**File**: `/workspaces/generacy/specs/246-1-9-migrate-contracts/update-contracts-imports.sh`
- Script to update imports from contracts to latency/agency
- Handle all common patterns
- Include usage instructions
- Make script executable

### T067 Document humancy migration path
**File**: `/workspaces/generacy/specs/246-1-9-migrate-contracts/humancy-migration-notes.md`
- Document current state of humancy dependency
- List required changes for when humancy is un-deferred
- Reference migration guide and update script
- Include step-by-step checklist

### T068 Update contracts README with archive notice
**File**: `/workspaces/contracts/README.md`
- Add prominent [ARCHIVED] tag to title
- Document archive date (2026-02-24)
- Explain where types have migrated to
- Link to migration guide
- Preserve historical purpose section

### T069 Search for contracts references in documentation
**Action**: Find and update stale docs
- Run: `rg "@generacy-ai/contracts" -g "*.md" --type markdown`
- Search all workspace repos
- Create list of files that need updates
- Update references to point to latency/agency

### T070 Update stale documentation references
**Files**: Various .md files across repos
- Update import examples to use latency/agency
- Update package references
- Link to migration guide where appropriate
- Verify code examples are accurate

### T071 Commit latency changes
**Repo**: /workspaces/latency
- Stage all migrated files
- Create comprehensive commit message
- Reference issue 246-1-9-migrate-contracts
- Include co-authored-by tag
- Push to branch

### T072 Commit agency changes
**Repo**: /workspaces/agency
- Stage all migrated files
- Create comprehensive commit message
- Reference issue 246-1-9-migrate-contracts
- Include co-authored-by tag
- Push to branch

### T073 Commit contracts archive notice
**Repo**: /workspaces/contracts
- Stage README.md changes
- Commit with message: "docs: archive notice - types migrated to latency and agency"
- Push to contracts repo

### T074 Archive contracts repository on GitHub
**Action**: Archive via GitHub
- Run: `gh repo archive generacy-ai/contracts --yes`
- Verify archive status on GitHub UI
- Confirm repository is read-only
- Document completion

### T075 Final verification checklist
**Action**: Complete pre-archive checklist
- ✅ All repos build successfully
- ✅ All tests pass in latency and agency
- ✅ Export counts verified and match
- ✅ Documentation updated (READMEs, migration guide)
- ✅ Scripts created and tested
- ✅ Humancy migration path documented
- ✅ Contracts README updated with archive notice

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 2 (need audit results to inform setup)
- Phase 2 must complete before Phase 3 (need directory structures)
- Phase 3 must complete before Phase 4 (agency imports from latency)
- Phase 5 depends on Phases 3 & 4 (verification requires migrations complete)

**Parallel opportunities within phases**:

**Phase 1**: T001-T004 can run in parallel (independent analysis tasks), T005 depends on all
**Phase 2**: T006-T009 and T010-T012 can run in parallel (different repos)
**Phase 3**: T022-T032 can run in parallel after T013-T021 complete (cross-component migrations)
**Phase 4**: T041-T049 are mostly sequential due to shared imports, but testing T053-T055 can be interleaved
**Phase 5**: T056-T058 can run in parallel, T062-T064 can run in parallel

**Critical path**:
```
T001 → T002 → T005 (Audit complete)
  ↓
T006 → T010 (Latency prep)
T008 → T011 (Agency prep)
  ↓
T013 → T014 → T015 (Common)
  ↓
T016 → T017 → T018 (Orchestration)
  ↓
T019 → T020 → T021 (Versioning)
  ↓
T022-T032 (Cross-component types)
  ↓
T033 → T034 → T037 (Latency integration)
  ↓
T038 → T039 → T040 (Latency verification)
  ↓
T041 → T042 → T043 (Tool naming to agency)
  ↓
T044 → T045 → T046 (Telemetry to agency)
  ↓
T047 → T051 (Agency integration)
  ↓
T053 → T054 → T055 (Agency verification)
  ↓
T056-T061 (Cross-repo verification)
  ↓
T062-T070 (Documentation)
  ↓
T071 → T072 → T073 → T074 (Commits and archive)
  ↓
T075 (Final checklist)
```

**Estimated Duration**: 11 days (~2 weeks)
- Phase 1: 2 days
- Phase 2: 2 days
- Phase 3: 3 days
- Phase 4: 2 days
- Phase 5: 2 days
