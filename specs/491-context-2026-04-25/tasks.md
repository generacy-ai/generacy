# Tasks: Cluster-Local Credhelper Backend

**Input**: Design documents from `/specs/491-context-2026-04-25/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/writable-backend.ts
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Interface & Types

- [ ] T001 [US1] Add `WritableBackendClient` interface to `packages/credhelper/src/types/context.ts` extending `BackendClient` with `setSecret(key: string, value: string): Promise<void>` and `deleteSecret(key: string): Promise<void>`
- [ ] T002 [US1] Export `WritableBackendClient` from `packages/credhelper/src/index.ts`
- [ ] T003 [US1] Re-export `WritableBackendClient` in `packages/credhelper-daemon/src/backends/types.ts`
- [ ] T004 [US3] Add error codes `CREDENTIAL_STORE_CORRUPT` and `CREDENTIAL_STORE_MIGRATION_NEEDED` to `packages/credhelper-daemon/src/errors.ts` with HTTP status mappings (both 500)

## Phase 2: Crypto Module

- [ ] T010 [P] [US1] Create `packages/credhelper-daemon/src/backends/crypto.ts` with `EncryptedEntry` interface, Zod schema, `encrypt(plaintext, masterKey)`, `decrypt(entry, masterKey)`, and `generateMasterKey()` functions using `node:crypto` AES-256-GCM (12-byte random IV, 16-byte auth tag, base64-encoded output)
- [ ] T011 [P] [US1] Create `packages/credhelper-daemon/__tests__/backends/crypto.test.ts` with tests: encrypt/decrypt roundtrip, wrong key fails, tampered ciphertext fails, tampered auth tag fails, different plaintexts produce different ciphertexts (random IV)

## Phase 3: File Store Module

- [ ] T020 [US1] Create `packages/credhelper-daemon/src/backends/file-store.ts` with `CredentialFileStore` class: `CredentialFileEnvelope` interface and Zod schema, `ensureMasterKey()` (create mode 0600 if absent, read if present), `load()` (parse JSON envelope, validate version, fail closed on corrupt/unknown version), `save(entries)` (atomic temp+fsync+rename under fd-based advisory lock)
- [ ] T021 [US1] Create `packages/credhelper-daemon/__tests__/backends/file-store.test.ts` with tests: master key created once and reused, master key file permissions 0600, load returns empty map when file missing, load fails on corrupt JSON (`CREDENTIAL_STORE_CORRUPT`), load fails on unknown version (`CREDENTIAL_STORE_MIGRATION_NEEDED`), atomic write produces valid file, crash simulation (partial write does not corrupt existing file), advisory lock acquire/release

## Phase 4: Backend Implementation

- [ ] T030 [US1] [US2] Create `packages/credhelper-daemon/src/backends/cluster-local-backend.ts` with `ClusterLocalBackend` class implementing `WritableBackendClient`: constructor with `ClusterLocalBackendOptions` (dataPath, keyPath), `init()` to load master key and validate credential file, `fetchSecret(key)` to decrypt from in-memory cache, `setSecret(key, value)` to encrypt and persist under lock, `deleteSecret(key)` to remove and persist under lock
- [ ] T031 [US1] [US2] Create `packages/credhelper-daemon/__tests__/backends/cluster-local-backend.test.ts` with tests: full CRUD roundtrip (set/get/delete), fetchSecret for missing key throws `BACKEND_SECRET_NOT_FOUND`, volume-snapshot scenario (copy credentials.dat without master.key, decrypt fails), overwrite existing credential, delete non-existent key throws, init with empty store succeeds, init with corrupt file fails closed

## Phase 5: Factory & Config Wiring

- [ ] T040 [US1] Add `'cluster-local'` case to `DefaultBackendClientFactory.create()` in `packages/credhelper-daemon/src/backends/factory.ts` constructing `ClusterLocalBackend` with default paths
- [ ] T041 [P] [US1] Export `ClusterLocalBackend` from `packages/credhelper-daemon/src/backends/index.ts`
- [ ] T042 [P] [US1] Update config loader in `packages/credhelper-daemon/src/config.ts` to default `type: 'cluster-local'` when backend config omits explicit type
- [ ] T043 [US1] Add test for `'cluster-local'` type dispatching in `packages/credhelper-daemon/__tests__/backends/factory.test.ts`

## Phase 6: Documentation & Verification

- [ ] T050 [P] Update `packages/credhelper-daemon/README.md` with cluster-local backend section and security note (master key management, recovery model, file permissions)
- [ ] T051 Run full test suite (`pnpm test` in credhelper-daemon) and verify all tests pass
- [ ] T052 Verify no plaintext secrets appear in test output or log statements

## Dependencies & Execution Order

**Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6** (sequential phases)

**Within-phase parallelism**:
- **Phase 2**: T010 (crypto module) and T011 (crypto tests) can run in parallel since tests can be written from the spec contract
- **Phase 5**: T041 (exports) and T042 (config default) can run in parallel — different files, no data dependency. T040 (factory case) should come first, T043 (factory test) depends on T040
- **Phase 6**: T050 (docs) can run in parallel with T051/T052 (verification)

**Key dependencies**:
- T010 (crypto) must complete before T020 (file-store) — file-store uses crypto types
- T020 (file-store) must complete before T030 (backend) — backend depends on file-store
- T030 (backend) must complete before T040 (factory) — factory constructs backend
- T001-T004 (types/errors) must complete before any implementation tasks
