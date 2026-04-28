# Tasks: Remove cloud-side credential storage and OIDC code

**Input**: Design documents from `/specs/488-context-credentials/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Delete Source Files

- [ ] T001 [P] [US1] Delete `packages/credhelper-daemon/src/auth/jwt-parser.ts`
- [ ] T002 [P] [US1] Delete `packages/credhelper-daemon/src/auth/session-token-store.ts`
- [ ] T003 [P] [US1] Delete `packages/credhelper-daemon/src/backends/generacy-cloud-backend.ts`

## Phase 2: Fix References in Source

- [ ] T004 [US1][US2] Modify `packages/credhelper-daemon/src/backends/factory.ts` — remove `'generacy-cloud'` case, remove `SessionTokenStore` constructor param, update unknown-type error message to reference `env` and `cluster-local`
- [ ] T005 [US1] Modify `packages/credhelper-daemon/src/control-server.ts` — remove 3 auth routes (`PUT /auth/session-token`, `DELETE /auth/session-token`, `GET /auth/session-token/status`) and remove `SessionTokenStore` constructor param
- [ ] T006 [US1] Modify `packages/credhelper-daemon/src/types.ts` — remove `sessionTokenStore` and `generacyCloudApiUrl` from `DaemonConfig` interface
- [ ] T007 [US1] Modify `packages/credhelper-daemon/src/daemon.ts` — remove `sessionTokenStore.loadFromDisk()` call and related wiring
- [ ] T008 [US1] Modify `packages/credhelper-daemon/bin/credhelper-daemon.ts` — remove `JwtParser`/`SessionTokenStore` imports and instantiation

## Phase 3: Delete Test Files and Fix Test References

- [ ] T009 [P] [US1] Delete `packages/credhelper-daemon/__tests__/auth/jwt-parser.test.ts`
- [ ] T010 [P] [US1] Delete `packages/credhelper-daemon/__tests__/auth/session-token-store.test.ts`
- [ ] T011 [P] [US1] Delete `packages/credhelper-daemon/__tests__/backends/generacy-cloud-backend.test.ts`
- [ ] T012 [P] [US1] Delete `packages/credhelper-daemon/__tests__/integration/session-token-flow.test.ts`
- [ ] T013 [US1] Modify `packages/credhelper-daemon/__tests__/backends/factory.test.ts` — remove `generacy-cloud` test cases and `SessionTokenStore` mock
- [ ] T014 [US1] Modify `packages/credhelper-daemon/__tests__/control-server.test.ts` — remove auth endpoint test cases and `SessionTokenStore` mock
- [ ] T015 [US1] Modify `packages/credhelper-daemon/__tests__/integration/config-loading.test.ts` — remove `SessionTokenStore`/`JwtParser` usage

## Phase 4: Cleanup and Verify

- [ ] T016 [US1] Remove `jose` from `packages/credhelper-daemon/package.json` dependencies
- [ ] T017 [US1] Run `pnpm install` to update lockfile
- [ ] T018 [US1] Run `pnpm build` to verify compilation succeeds
- [ ] T019 [US1] Run `pnpm test` to verify all tests pass
- [ ] T020 [US1] Run repo-wide grep to confirm no dangling imports of deleted modules (`generacy-cloud-backend`, `session-token-store`, `jwt-parser`, `SessionTokenStore`, `JwtParser`, `GeneracyCloudBackend`)

## Dependencies & Execution Order

**Phase 1** (file deletions) has no internal dependencies — all three tasks can run in parallel.

**Phase 2** (source modifications) depends on Phase 1 completion. Tasks T004–T008 are logically ordered by dependency depth but can technically be done in any order since they all address dangling references. Recommended order: factory (T004) first since it's the most impactful change (US2 acceptance criteria), then control-server (T005), types (T006), daemon (T007), entry point (T008).

**Phase 3** (test cleanup) depends on Phase 2 completion. Deletions (T009–T012) can run in parallel. Modifications (T013–T015) should follow deletions to avoid confusion.

**Phase 4** (verification) is strictly sequential: remove dep (T016) → install (T017) → build (T018) → test (T019) → grep (T020).

**Parallel opportunities**: T001–T003, T009–T012, and within Phase 2 the modifications are independent files.
