# Tasks: @generacy-ai/generacy-plugin-cloud-build

**Input**: Design documents from `/specs/017-plugin-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup & Foundation

- [x] T001 Create package structure `packages/generacy-plugin-cloud-build/` with package.json
- [x] T002 [P] Configure tsconfig.json with strict mode and ESM output
- [x] T003 [P] Configure vitest.config.ts for unit and integration tests
- [x] T004 Create src/errors.ts with CloudBuildError base class and error subclasses (AuthError, NotFoundError, RateLimitError, TimeoutError)
- [x] T005 [P] Create src/types/builds.ts with Build, BuildStatus, BuildStep, BuildResults, BuildSource types from data-model.md
- [x] T006 [P] Create src/types/triggers.ts with BuildTrigger, TriggerConfig, GitHubConfig types from data-model.md
- [x] T007 [P] Create src/types/artifacts.ts with Artifact, ArtifactsConfig types from data-model.md
- [x] T008 [P] Create src/types/logs.ts with LogEntry, LogSeverity types from data-model.md
- [x] T009 Create src/config/types.ts with CloudBuildConfig, RetryConfig interfaces
- [x] T010 Create src/config/schema.ts with Zod validation schema (CloudBuildConfigSchema) per plan.md

---

## Phase 2: Authentication & Client

- [x] T011 Create src/auth/types.ts with AuthProvider interface and AuthOptions type
- [x] T012 Create src/auth/auth-provider.ts implementing auth priority: serviceAccountKey > ADC fallback
- [x] T013 Create src/utils/retry.ts with exponential backoff + jitter (initialDelay: 1000ms, maxDelay: 30000ms, maxAttempts: 3)
- [x] T014 [P] Create src/utils/validation.ts with input validators using Zod schemas
- [x] T015 Create src/client.ts wrapping @google-cloud/cloudbuild with auth integration and error handling
- [x] T016 Write tests/unit/auth.test.ts for auth provider (serviceAccountKey, ADC fallback, error cases)
- [x] T017 [P] Write tests/unit/retry.test.ts for retry logic (backoff timing, jitter, max attempts)

---

## Phase 3: Build Operations

- [x] T018 Create src/operations/builds.ts with BuildOperations class
- [x] T019 Implement triggerBuild(triggerId, source?) in builds.ts - trigger build from existing trigger
- [x] T020 Implement runBuild(config) in builds.ts - run build from inline config
- [x] T021 Implement getBuild(buildId) in builds.ts - fetch single build status
- [x] T022 Implement listBuilds(filter?) in builds.ts with PaginatedResult return type
- [x] T023 Implement cancelBuild(buildId) in builds.ts
- [x] T024 Implement retryBuild(buildId) in builds.ts
- [x] T025 Add private mapBuild() helper to transform Google Cloud types to plugin types
- [x] T026 Write tests/unit/builds.test.ts with mocked client for all build operations

---

## Phase 4: Log Streaming

- [x] T027 Create src/streaming/types.ts with LogStreamOptions interface
- [x] T028 Create src/streaming/log-stream.ts with LogStream class
- [x] T029 Implement streamLogs(buildId) as AsyncIterable<LogEntry> with polling in log-stream.ts
- [x] T030 Add automatic stream completion when build finishes
- [x] T031 Create src/operations/logs.ts integrating LogStream with configurable polling interval
- [x] T032 Write tests/unit/logs.test.ts testing async iteration, polling, and stream completion

---

## Phase 5: Artifact Access

- [x] T033 Create src/operations/artifacts.ts with ArtifactOperations class
- [x] T034 Implement listArtifacts(buildId) in artifacts.ts using @google-cloud/storage
- [x] T035 Implement getArtifact(buildId, path) returning Buffer (with 100MB size check)
- [x] T036 Implement getArtifactStream(buildId, path) returning ReadableStream for large files
- [x] T037 Write tests/unit/artifacts.test.ts with mocked storage client

---

## Phase 6: Trigger Management

- [x] T038 Create src/operations/triggers.ts with TriggerOperations class
- [x] T039 Implement listTriggers() in triggers.ts
- [x] T040 Implement createTrigger(config) in triggers.ts with input validation
- [x] T041 Implement updateTrigger(triggerId, config) in triggers.ts
- [x] T042 Implement deleteTrigger(triggerId) in triggers.ts
- [x] T043 Write tests/unit/triggers.test.ts with mocked client for CRUD operations

---

## Phase 7: Plugin Integration

- [x] T044 Create src/plugin.ts with CloudBuildPlugin class aggregating all operations
- [x] T045 Wire up BuildOperations, LogOperations, ArtifactOperations, TriggerOperations in plugin.ts
- [x] T046 Add pino logger integration with secret redaction for serviceAccountKey
- [x] T047 Create src/index.ts with public exports (plugin, types, errors, schemas)
- [x] T048 Write tests/integration/plugin.test.ts testing full plugin initialization and operation wiring

---

## Phase 8: Documentation & Polish

- [x] T049 Add JSDoc comments to all public interfaces and methods
- [x] T050 [P] Create README.md with installation, configuration, and usage examples
- [x] T051 [P] Validate all acceptance criteria from spec.md (trigger builds, monitoring, logs, artifacts, secrets)
- [x] T052 Run full test suite and fix any failing tests

---

## Dependencies & Execution Order

### Sequential Dependencies
1. **T001** (package.json) must complete before T002, T003, T004-T010
2. **T004** (errors) must complete before T015 (client uses errors)
3. **T005-T008** (types) must complete before T009-T010 (config references types)
4. **T009-T010** (config) must complete before T011-T012 (auth uses config)
5. **T012** (auth-provider) and **T013** (retry) must complete before T015 (client)
6. **T015** (client) must complete before T018-T024 (build operations use client)
7. **T018-T025** (builds) must complete before T044 (plugin aggregates operations)
8. All Phase 3-6 operations must complete before **T044** (plugin integration)

### Parallel Opportunities
- **T002, T003**: Independent config files after package.json
- **T005, T006, T007, T008**: Independent type files
- **T014, T016, T017**: Tests can run in parallel with implementation
- **T050, T051**: Documentation and validation parallel in final phase

### Phase Boundaries
- Phase 1 → Phase 2: Setup complete before auth/client
- Phase 2 → Phase 3-6: Client ready before operations
- Phase 3-6 → Phase 7: All operations complete before integration
- Phase 7 → Phase 8: Integration complete before polish
