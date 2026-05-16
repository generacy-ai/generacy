# Tasks: App-Config Secrets Env Renderer

**Input**: Design documents from `/specs/632-summary-after-app-config/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Store Implementation

- [X] T001 [US1] Create `AppConfigSecretEnvStore` class at `packages/control-plane/src/services/app-config-secret-env-store.ts` — mirror `AppConfigEnvStore` pattern with: constructor accepting `ClusterLocalBackend` + `AppConfigFileStore` deps, preferred path `/run/generacy-app-config/secrets.env`, fallback `/tmp/generacy-app-config/secrets.env`, `init()` with fallback chain (#624 pattern), `set(name, value)`, `delete(name)`, `list()`, `getStatus()`, `getInitResult()`, promise-chain mutex `withLock()`, atomic writes (temp+datasync+rename, mode 0640), same `escapeValue()` helper
- [X] T002 [US1] Add `renderAll()` method to `AppConfigSecretEnvStore` — reads `AppConfigFileStore.getMetadata()`, filters `secret === true` entries, calls `ClusterLocalBackend.fetchSecret('app-config/env/${name}')` for each, writes combined file atomically. Best-effort: skip entries that fail to unseal (log warning), return `RenderResult { rendered: string[], failed: string[] }`

## Phase 2: Tests for Core Store

- [X] T003 [P] [US1] Create unit tests at `packages/control-plane/__tests__/services/app-config-secret-env-store.test.ts` — test `init()` ok/fallback/disabled modes, `set()`/`delete()`/`list()` round-trips, `StoreDisabledError` in disabled mode, atomic write format (KEY="escaped_value"), escaping of backslash/quote/newline. Use same tmpdir + vi.spyOn(fs.mkdir) pattern as `app-config-env-store.test.ts`
- [X] T004 [P] [US1] Add `renderAll()` tests — mock `AppConfigFileStore.getMetadata()` to return entries with `secret: true/false`, mock `ClusterLocalBackend.fetchSecret()` (success and throw cases). Assert: only secret entries rendered, partial render on unseal failure, `RenderResult` shape correct, non-secret entries excluded

## Phase 3: Daemon Init + Route Wiring

- [X] T005 [US1] Wire `AppConfigSecretEnvStore` into `packages/control-plane/bin/control-plane.ts` — instantiate after `ClusterLocalBackend` init, call `init()` + `renderAll()` in the init sequence, log structured `{ event: 'store-init', store: 'appConfigSecretEnv', ...result }`, add to `InitResult.stores['appConfigSecretEnv']`, pass to `setAppConfigStores()`
- [X] T006 [US1] Extend `setAppConfigStores()` in `packages/control-plane/src/routes/app-config.ts` — add `secretEnvStore` parameter, store as module-scoped instance with `requireSecretEnvStore()` accessor
- [X] T007 [US1] Modify `handlePutEnv()` in `packages/control-plane/src/routes/app-config.ts` — after writing secret to backend, also call `secretEnvStore.set(name, value)`. Add secret-flag transition logic: read prior metadata, detect flag change (`true→false`: write plaintext env first, delete backend + secrets.env second; `false→true`: write backend + secrets.env first, delete plaintext env second), update metadata last
- [X] T008 [US1] Modify `handleDeleteEnv()` in `packages/control-plane/src/routes/app-config.ts` — when `entry.secret === true`, also call `secretEnvStore.delete(name)` after `backend.deleteSecret()`

## Phase 4: Route + Init Tests

- [X] T009 [P] [US1] Add tests for secret-flag transitions in `packages/control-plane/__tests__/routes/app-config.test.ts` — test PUT with `secret: true` writes to backend + secrets.env, PUT with `secret: false` writes to plaintext env only (no secrets.env touch), PUT transition `true→false` cleans up backend + secrets.env and writes plaintext, PUT transition `false→true` cleans up plaintext and writes to backend + secrets.env, DELETE of secret removes from both backend and secrets.env
- [X] T010 [P] [US1] Add init integration test in `packages/control-plane/__tests__/services/daemon-init.test.ts` (or new file) — verify that after full init sequence with pre-seeded backend secrets and metadata, `secrets.env` file exists with expected content

## Phase 5: Polish

- [X] T011 [US1] Verify non-secret PUTs do NOT touch secrets.env — add negative assertion in route tests: after PUT with `secret: false`, secrets.env content unchanged
- [X] T012 [US1] Verify boot-time render with no secrets produces empty file — edge case test in `renderAll()`: metadata has zero `secret: true` entries, file is written empty or not created

## Dependencies & Execution Order

**Sequential chains**:
- T001 → T002 (renderAll depends on base class)
- T001 + T002 → T005, T006 (init wiring depends on store class)
- T006 → T007, T008 (route changes depend on store injection)
- T007, T008 → T009 (route tests depend on route changes)

**Parallel opportunities**:
- T003 and T004 can run in parallel (independent test files, both depend only on T001/T002)
- T009 and T010 can run in parallel (different test scopes)
- T011 and T012 are lightweight polish tasks, can run after T009

**Phase boundaries**:
- Phase 1 (core) → Phase 2 (core tests) → Phase 3 (wiring) → Phase 4 (wiring tests) → Phase 5 (polish)
- Phase 2 tests can begin as soon as Phase 1 is complete
- Phase 3 tasks T005–T008 are sequential (each builds on prior injection)
