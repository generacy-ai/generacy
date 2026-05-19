# Tasks: Wire Credhelper Daemon Config Loader (Phase 6)

**Input**: Design documents from `/specs/477-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1][US3] Wire real `loadConfig()` into daemon binary
  - File: `packages/credhelper-daemon/bin/credhelper-daemon.ts`
  - Import `loadConfig`, `ConfigValidationError` from `@generacy-ai/credhelper`
  - Import `resolve` from `node:path`
  - Add `CREDHELPER_AGENCY_DIR` env var resolution (default: `resolve(process.cwd(), '.agency')`)
  - Call `loadConfig({ agencyDir })` before daemon construction
  - Replace stub `configLoader` (lines 38-47) with real adapter:
    - `loadRole(id)` → `config.roles.get(id)` with `CredhelperError('ROLE_NOT_FOUND')` on miss
    - `loadCredential(id)` → `config.credentials.credentials.find(c => c.id === id)` with `CredhelperError('CREDENTIAL_NOT_FOUND')` on miss
    - `loadBackend(id)` → `config.backends.backends.find(b => b.id === id)` with `CredhelperError('BACKEND_UNREACHABLE')` on miss
  - Import `CredhelperError` from `../src/errors.js`

- [X] T002 [US2] Add fail-closed startup error handling
  - File: `packages/credhelper-daemon/bin/credhelper-daemon.ts`
  - Wrap `loadConfig()` call in try/catch
  - On `ConfigValidationError`: log each error with file path and field location, then `process.exit(1)`
  - On other errors: log generic message, `process.exit(1)`
  - Ensure control socket never binds when config is invalid (config load before `daemon.start()`)

## Phase 2: Integration Tests
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [X] T003 [P] [US1] Add happy-path integration test for config loading
  - File: `packages/credhelper-daemon/__tests__/integration/config-loading.test.ts`
  - Create temp dir with minimal valid `.agency/` structure:
    - `secrets/backends.yaml` — one backend entry
    - `secrets/credentials.yaml` — one credential referencing the backend
    - `roles/test-role.yaml` — one role referencing the credential
  - Start daemon with `CREDHELPER_AGENCY_DIR` pointing at temp dir
  - Verify daemon reaches ready state (control socket accepting connections)
  - `POST /sessions` with the test role → verify 200 and role resolves correctly
  - Tear down (stop daemon, remove temp dir)
  - Follow patterns from `session-lifecycle.test.ts` (Unix socket HTTP requests, mock plugin setup)

- [X] T004 [P] [US2] Add negative integration test for invalid config
  - File: `packages/credhelper-daemon/__tests__/integration/config-loading.test.ts`
  - Create temp dir with invalid `.agency/` structure (role referencing nonexistent credential)
  - Spawn daemon as child process (since `process.exit()` can't be tested in-process)
  - Verify process exits with non-zero code
  - Verify stderr contains validation error with file path

## Phase 3: Verification
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [X] T005 Verify no remaining stub references
  - Run `grep -r 'not yet integrated' packages/` and confirm zero matches
  - Run full test suite: `pnpm --filter @generacy-ai/credhelper-daemon test`
  - Verify daemon starts against a valid `.agency/` directory (manual or via integration test)

## Dependencies & Execution Order

```
T001 ─┐
      ├──→ T003 [P] ─┐
T002 ─┘               ├──→ T005
      ├──→ T004 [P] ─┘
      └────────────────┘
```

- **T001 and T002** are sequential (both modify the same file, T002 wraps T001's code in try/catch)
- **T003 and T004** can run in parallel (different test scenarios, same test file but independent `describe` blocks)
- **T005** depends on all prior tasks (verification gate)
