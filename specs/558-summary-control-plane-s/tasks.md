# Tasks: Credential Persistence in Control-Plane

**Input**: Design documents from `/specs/558-summary-control-plane-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Extract Storage Modules to `@generacy-ai/credhelper`

- [X] T001 [US1] Create `packages/credhelper/src/backends/` directory and extract `crypto.ts` from `packages/credhelper-daemon/src/backends/crypto.ts` — copy `encrypt()`, `decrypt()`, `generateMasterKey()`, `EncryptedEntry` interface
- [X] T002 [US1] Extract `file-store.ts` from `packages/credhelper-daemon/src/backends/file-store.ts` — copy `CredentialFileStore` class, update import of `crypto.ts` to co-located path
- [X] T003 [US1] Create `StorageError` class in `packages/credhelper/src/backends/errors.ts` — codes: `SECRET_NOT_FOUND`, `STORE_CORRUPT`, `STORE_MIGRATION_NEEDED`, `KEY_UNAVAILABLE`
- [X] T004 [US1] Extract `cluster-local-backend.ts` from `packages/credhelper-daemon/src/backends/cluster-local-backend.ts` — copy `ClusterLocalBackend` class, replace `CredhelperError` with `StorageError`, update imports to co-located paths
- [X] T005 [US1] Add barrel exports in `packages/credhelper/src/index.ts` — export `ClusterLocalBackend`, `CredentialFileStore`, `encrypt`, `decrypt`, `generateMasterKey`, `StorageError`, `EncryptedEntry`
- [X] T006 [P] [US1] Replace `packages/credhelper-daemon/src/backends/crypto.ts` with re-export from `@generacy-ai/credhelper`
- [X] T007 [P] [US1] Replace `packages/credhelper-daemon/src/backends/file-store.ts` with re-export from `@generacy-ai/credhelper`
- [X] T008 [P] [US1] Replace `packages/credhelper-daemon/src/backends/cluster-local-backend.ts` with re-export from `@generacy-ai/credhelper`
- [X] T009 [US1] Verify credhelper-daemon existing tests still pass after re-export replacement

## Phase 2: Implement Credential Writer Service

- [X] T010 [US1] Create `packages/control-plane/src/services/credential-writer.ts` — implement `writeCredential(options)` following `default-role-writer.ts` pattern: init backend, write secret, write YAML metadata, emit relay event
- [X] T011 [US1] Implement YAML metadata logic in `credential-writer.ts` — read `.agency/credentials.yaml`, merge entry `{ type, backend: 'cluster-local', status: 'active', updatedAt }`, atomic write (temp+rename)
- [X] T012 [US1] Implement relay event emission in `credential-writer.ts` — call `getRelayPushEvent()` with channel `cluster.credentials` and payload `{ credentialId, type, status: 'written' }`

## Phase 3: Wire Route Handlers

- [X] T013 [US1] Modify `packages/control-plane/src/routes/credentials.ts` `handlePutCredential` — parse body, validate with `PutCredentialBodySchema` (`{ type: z.string().min(1), value: z.string().min(1) }`), call `writeCredential()`, return 200 or 500 with `failedAt`
- [X] T014 [US1] Modify `packages/control-plane/src/routes/credentials.ts` `handleGetCredential` — read `.agency/credentials.yaml`, look up entry by credentialId param, return metadata `{ id, type, backend, status, updatedAt }` or 404
- [X] T015 [US1] Wire `ClusterLocalBackend` eager initialization in control-plane startup (`bin/control-plane.ts` or server entry) — call `init()` before listen, fail-fast on missing master key

## Phase 4: Tests

- [X] T016 [P] [US1] Unit test: `packages/credhelper/src/backends/__tests__/crypto.test.ts` — encrypt/decrypt round-trip with known key, verify different IVs per call
- [X] T017 [P] [US1] Unit test: `packages/credhelper/src/backends/__tests__/file-store.test.ts` — load/save with temp directory, atomic write verification, master key auto-generation
- [X] T018 [P] [US1] Unit test: `packages/credhelper/src/backends/__tests__/cluster-local-backend.test.ts` — setSecret/fetchSecret/deleteSecret with temp paths, idempotent overwrite
- [X] T019 [US1] Unit test: `packages/control-plane/__tests__/services/credential-writer.test.ts` — mock backend + mock fs, verify write sequence (secret → metadata → event), partial failure returns correct `failedAt`
- [X] T020 [US1] Unit test: `packages/control-plane/__tests__/routes/credentials.test.ts` — mock credential-writer, verify request parsing, Zod validation errors, 200/400/500 responses
- [X] T021 [US1] Integration test: PUT then GET round-trip returns metadata
- [X] T022 [US1] Integration test: PUT same credentialId twice — second overwrites cleanly (idempotency)

## Dependencies & Execution Order

**Sequential constraints:**
- T001 → T002 → T004 (file-store depends on crypto, backend depends on both)
- T003 can run in parallel with T001-T002 (independent error class)
- T005 depends on T001-T004 (barrel exports need all modules)
- T006, T007, T008 can run in parallel after T005 (independent re-export files)
- T009 depends on T006-T008 (verify re-exports don't break tests)
- T010-T012 depend on T005 (credential-writer imports from `@generacy-ai/credhelper`)
- T013-T015 depend on T010-T012 (route handlers call credential-writer)
- T016, T017, T018 can run in parallel after T005 (test extracted modules)
- T019-T020 depend on T010-T013 (test the service and route implementations)
- T021-T022 depend on T013-T015 (integration tests need full wiring)

**Parallel opportunities:**
- Phase 1: T003 parallel with T001-T002; T006/T007/T008 parallel with each other
- Phase 4: T016/T017/T018 parallel with each other; can start as soon as Phase 1 completes
