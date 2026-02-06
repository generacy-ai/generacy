# Tasks: @generacy-ai/generacy-plugin-cloud-build

**Input**: Design documents from `/specs/017-plugin-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup & Foundation

- [ ] T001 Create package structure `packages/generacy-plugin-cloud-build/` with package.json
- [ ] T002 [P] Configure tsconfig.json with strict mode and ESM output
- [ ] T003 [P] Configure vitest.config.ts for unit and integration tests
- [ ] T004 Create src/errors.ts with CloudBuildError base class and error subclasses (AuthError, NotFoundError, RateLimitError, TimeoutError)
- [ ] T005 [P] Create src/types/builds.ts with Build, BuildStatus, BuildStep, BuildResults, BuildSource types from data-model.md
- [ ] T006 [P] Create src/types/triggers.ts with BuildTrigger, TriggerConfig, GitHubConfig types from data-model.md
- [ ] T007 [P] Create src/types/artifacts.ts with Artifact, ArtifactsConfig types from data-model.md
- [ ] T008 [P] Create src/types/logs.ts with LogEntry, LogSeverity types from data-model.md
- [ ] T009 Create src/config/types.ts with CloudBuildConfig, RetryConfig interfaces
- [ ] T010 Create src/config/schema.ts with Zod validation schema (CloudBuildConfigSchema) per plan.md

---

## Phase 2: Authentication & Client

- [ ] T011 Create src/auth/types.ts with AuthProvider interface and AuthOptions type
- [ ] T012 Create src/auth/auth-provider.ts implementing auth priority: serviceAccountKey > ADC fallback
- [ ] T013 Create src/utils/retry.ts with exponential backoff + jitter (initialDelay: 1000ms, maxDelay: 30000ms, maxAttempts: 3)
- [ ] T014 [P] Create src/utils/validation.ts with input validators using Zod schemas
- [ ] T015 Create src/client.ts wrapping @google-cloud/cloudbuild with auth integration and error handling
- [ ] T016 Write tests/unit/auth.test.ts for auth provider (serviceAccountKey, ADC fallback, error cases)
- [ ] T017 [P] Write tests/unit/retry.test.ts for retry logic (backoff timing, jitter, max attempts)

---

## Phase 3: Build Operations

- [ ] T018 Create src/operations/builds.ts with BuildOperations class
- [ ] T019 Implement triggerBuild(triggerId, source?) in builds.ts - trigger build from existing trigger
- [ ] T020 Implement runBuild(config) in builds.ts - run build from inline config
- [ ] T021 Implement getBuild(buildId) in builds.ts - fetch single build status
- [ ] T022 Implement listBuilds(filter?) in builds.ts with PaginatedResult return type
- [ ] T023 Implement cancelBuild(buildId) in builds.ts
- [ ] T024 Implement retryBuild(buildId) in builds.ts
- [ ] T025 Add private mapBuild() helper to transform Google Cloud types to plugin types
- [ ] T026 Write tests/unit/builds.test.ts with mocked client for all build operations

---

## Phase 4: Log Streaming

- [ ] T027 Create src/streaming/types.ts with LogStreamOptions interface
- [ ] T028 Create src/streaming/log-stream.ts with LogStream class
- [ ] T029 Implement streamLogs(buildId) as AsyncIterable<LogEntry> with polling in log-stream.ts
- [ ] T030 Add automatic stream completion when build finishes
- [ ] T031 Create src/operations/logs.ts integrating LogStream with configurable polling interval
- [ ] T032 Write tests/unit/logs.test.ts testing async iteration, polling, and stream completion

---

## Phase 5: Artifact Access

- [ ] T033 Create src/operations/artifacts.ts with ArtifactOperations class
- [ ] T034 Implement listArtifacts(buildId) in artifacts.ts using @google-cloud/storage
- [ ] T035 Implement getArtifact(buildId, path) returning Buffer (with 100MB size check)
- [ ] T036 Implement getArtifactStream(buildId, path) returning ReadableStream for large files
- [ ] T037 Write tests/unit/artifacts.test.ts with mocked storage client

---

## Phase 6: Trigger Management

- [ ] T038 Create src/operations/triggers.ts with TriggerOperations class
- [ ] T039 Implement listTriggers() in triggers.ts
- [ ] T040 Implement createTrigger(config) in triggers.ts with input validation
- [ ] T041 Implement updateTrigger(triggerId, config) in triggers.ts
- [ ] T042 Implement deleteTrigger(triggerId) in triggers.ts
- [ ] T043 Write tests/unit/triggers.test.ts with mocked client for CRUD operations

---

## Phase 7: Plugin Integration

- [ ] T044 Create src/plugin.ts with CloudBuildPlugin class aggregating all operations
- [ ] T045 Wire up BuildOperations, LogOperations, ArtifactOperations, TriggerOperations in plugin.ts
- [ ] T046 Add pino logger integration with secret redaction for serviceAccountKey
- [ ] T047 Create src/index.ts with public exports (plugin, types, errors, schemas)
- [ ] T048 Write tests/integration/plugin.test.ts testing full plugin initialization and operation wiring

---

## Phase 8: Documentation & Polish

- [ ] T049 Add JSDoc comments to all public interfaces and methods
- [ ] T050 [P] Create README.md with installation, configuration, and usage examples
- [ ] T051 [P] Validate all acceptance criteria from spec.md (trigger builds, monitoring, logs, artifacts, secrets)
- [ ] T052 Run full test suite and fix any failing tests

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
