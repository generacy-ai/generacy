# Tasks: Knowledge Store Management

**Input**: Design documents from `/specs/024-knowledge-store-management/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Setup

- [ ] T001 Initialize `packages/knowledge-store/` with `package.json` (name: `@generacy-ai/knowledge-store`, type: module, dependencies: zod, devDependencies: typescript, vitest, @types/node)
- [ ] T002 [P] Create `tsconfig.json` with strict mode, ESM output, and Node16 module resolution
- [ ] T003 [P] Create `vitest.config.ts` with TypeScript support and test file patterns

## Phase 2: Core Types

- [ ] T010 [P] Create `src/types/knowledge.ts` with Philosophy, Principle, Pattern, UserContext, and IndividualKnowledge interfaces (per data-model.md)
- [ ] T011 [P] Create `src/types/storage.ts` with StorageProvider interface and VersionInfo type
- [ ] T012 [P] Create `src/types/portability.ts` with PortabilityLevel, ExportedKnowledge, ImportResult, and ImportConflict types
- [ ] T013 Create `src/types/index.ts` to re-export all types

## Phase 3: Utilities

- [ ] T020 [P] Create `src/utils/id.ts` with `generateId()` function using `crypto.randomUUID()`
- [ ] T021 [P] Create `src/utils/timestamps.ts` with `now()` returning ISO 8601 string
- [ ] T022 Create `src/utils/index.ts` to re-export utilities

## Phase 4: Validation

- [ ] T030 [US1] Create `src/validation/schemas.ts` with Zod schemas for Philosophy, Principle, Pattern, UserContext, Evidence, Value, Belief
- [ ] T031 [US1] Create `src/validation/validator.ts` with `validatePrinciple()`, `validatePhilosophy()`, `validatePattern()`, `validateContext()` functions
- [ ] T032 [P] Create `tests/validation/schemas.test.ts` with unit tests for all schemas (valid/invalid cases)

## Phase 5: Storage Provider

- [ ] T040 [US1] Create `src/storage/StorageProvider.ts` with abstract interface definition
- [ ] T041 [US1] Create `src/storage/LocalFileStorage.ts` implementing StorageProvider with atomic writes (temp file + rename pattern)
- [ ] T042 [US1] Create `src/storage/VersionedStorage.ts` wrapper that adds versioning to any StorageProvider (full snapshot strategy)
- [ ] T043 Create `tests/storage/LocalFileStorage.test.ts` with unit tests for CRUD operations, atomic writes, and error handling
- [ ] T044 [P] Create `tests/storage/VersionedStorage.test.ts` with unit tests for version creation, retrieval, and listing

## Phase 6: Domain Managers

- [ ] T050 [US1] Create `src/manager/PhilosophyManager.ts` with get/update operations, versioning integration
- [ ] T051 [US1] Create `src/manager/PrincipleManager.ts` with CRUD, domain filtering, deprecation, and versioning
- [ ] T052 [US1] Create `src/manager/PatternManager.ts` with CRUD, status filtering, and promotion to principle
- [ ] T053 [US1] Create `src/manager/ContextManager.ts` with get/update operations (no versioning needed)
- [ ] T054 Create `tests/manager/PhilosophyManager.test.ts` with unit tests
- [ ] T055 [P] Create `tests/manager/PrincipleManager.test.ts` with unit tests including domain filtering and deprecation
- [ ] T056 [P] Create `tests/manager/PatternManager.test.ts` with unit tests including promotion flow
- [ ] T057 [P] Create `tests/manager/ContextManager.test.ts` with unit tests

## Phase 7: Knowledge Store Manager

- [ ] T060 [US1] Create `src/manager/KnowledgeStoreManager.ts` facade class implementing full interface (delegates to domain managers)
- [ ] T061 [US1] Implement `getKnowledge()` aggregation method in KnowledgeStoreManager
- [ ] T062 [US1] Implement `getHistory()` and `revertTo()` versioning methods in KnowledgeStoreManager
- [ ] T063 Create `tests/manager/KnowledgeStoreManager.test.ts` with integration tests for full API

## Phase 8: Import/Export

- [ ] T070 [US2] Create `src/portability/redaction.ts` with transform functions for full/redacted/abstracted levels
- [ ] T071 [US2] Create `src/portability/Exporter.ts` with `exportKnowledge()` supporting three portability levels
- [ ] T072 [US2] Create `src/portability/Importer.ts` with `importKnowledge()`, merge strategy, and conflict detection (auto-resolve simple, flag complex)
- [ ] T073 Create `tests/portability/Exporter.test.ts` with tests for all three export levels
- [ ] T074 [P] Create `tests/portability/Importer.test.ts` with tests for merge, conflict detection, and resolution

## Phase 9: Integrity & Audit

- [ ] T080 [US1] Add integrity check methods to KnowledgeStoreManager: `validateIntegrity()` for consistency, `detectCircularConflicts()` for principles
- [ ] T081 [US1] Implement audit trail in LocalFileStorage: log all changes to `audit.json` with timestamp, action, and details

## Phase 10: Public API

- [ ] T090 Create `src/index.ts` with `createKnowledgeStore()` factory function and public type exports
- [ ] T091 Update `package.json` with exports field pointing to `src/index.ts`

## Phase 11: Final Integration

- [ ] T100 Create `tests/integration/full-workflow.test.ts` testing complete user workflow: create knowledge, add principles, export, import to new user
- [ ] T101 Run full test suite (`npm test`) and fix any failures
- [ ] T102 Run linter (`npm run lint`) and fix any issues

---

## Dependencies & Execution Order

### Sequential Dependencies
```
T001 → T002, T003 (package.json first)
T010-T012 → T013 (types before index)
T020-T021 → T022 (utils before index)
T030 → T031 (schemas before validator)
T040 → T041 → T042 (interface → implementation → wrapper)
T041, T042 → T043, T044 (implementations before tests)
T050-T053 → T054-T057 (managers before their tests)
T050-T053 → T060 (domain managers before facade)
T060-T062 → T063 (facade before integration tests)
T070 → T071, T072 (redaction before export/import)
T071, T072 → T073, T074 (implementations before tests)
T090 → T091 (index before package exports)
T100 → T101 → T102 (integration tests → test suite → lint)
```

### Parallel Opportunities
- **Phase 1**: T002, T003 can run in parallel after T001
- **Phase 2**: T010, T011, T012 can all run in parallel
- **Phase 3**: T020, T021 can run in parallel
- **Phase 4**: T032 can run in parallel with other Phase 4 work
- **Phase 5**: T044 can run in parallel with T043
- **Phase 6**: T054-T057 tests can run in parallel
- **Phase 8**: T074 can run in parallel with T073

### Phase Boundaries
- Phase 2 requires Phase 1 complete
- Phase 4 requires Phase 2 complete (types needed for schemas)
- Phase 5 requires Phase 2, Phase 4 complete (types and validation)
- Phase 6 requires Phase 5 complete (storage provider)
- Phase 7 requires Phase 6 complete (domain managers)
- Phase 8 requires Phase 7 complete (full manager API)
- Phase 10 requires Phase 8 complete (all features)
- Phase 11 requires Phase 10 complete (public API)
