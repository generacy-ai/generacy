# Tasks: Config File Loading & Validation (Phase 2)

**Input**: Design documents from `/specs/462-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[AC#]**: Which acceptance criteria this task addresses

## Phase 1: Error Infrastructure & Config Types

- [X] T001 [AC5] Create `ConfigError` interface and `ConfigValidationError` class — `packages/credhelper/src/config/errors.ts`
  - `ConfigError`: `{ file, field?, message, source? }` interface
  - `ConfigValidationError` extending `Error` with `errors: ConfigError[]`
  - Human-readable `message` formatting listing all errors with file/field context

- [X] T002 [P] [AC1] Create `LoadConfigOptions` and `ConfigResult` types — `packages/credhelper/src/config/types.ts`
  - `LoadConfigOptions`: `{ agencyDir, pluginRegistry?, logger? }`
  - `ConfigResult`: `{ backends, credentials, trustedPlugins, roles, overlayIds }`
  - Re-export `ConfigError` from types for convenience

## Phase 2: File Reading Layer

- [X] T003 [AC1] Implement YAML file reader utilities — `packages/credhelper/src/config/file-reader.ts`
  - `readRequiredYaml(filePath, schema, errors)` — reads file, validates with Zod, pushes errors if missing/invalid
  - `readOptionalYaml(filePath, schema, errors)` — returns `null` if file doesn't exist
  - `readRoleDirectory(rolesDir, errors)` — globs `*.yaml`, reads each, validates against `RoleConfigSchema`
  - All functions accumulate errors into shared `ConfigError[]` array
  - Use `yaml ^2.4.0` `parse()` for YAML parsing

- [X] T004 [P] [AC5] Implement Zod/YAML error mapping — `packages/credhelper/src/config/file-reader.ts`
  - Map `ZodError` issues to `ConfigError` format with `file`, `field` (from Zod path), `message`
  - Handle YAML parse errors (syntax) with file path context
  - Overlay-related errors include `source: 'committed' | 'overlay'`

## Phase 3: Overlay Merge

- [X] T005 [AC2] Implement credential overlay merge — `packages/credhelper/src/config/overlay.ts`
  - `mergeCredentialOverlay(committed, overlay)` → merged entries + overlay id list
  - Merge by `id`: overlay fully replaces committed entry with same id
  - Overlay can add new ids not in committed file
  - Return both merged list and list of ids from overlay

## Phase 4: Role Resolution

- [X] T006 [AC3] Implement role extends resolver — `packages/credhelper/src/config/role-resolver.ts`
  - `resolveRoleExtends(roles, errors)` → `Map<string, RoleConfig>` with inheritance applied
  - For each role with `extends`, load parent and merge credentials by `ref`
  - Multi-level extends: resolve full chain (grandparent → parent → child)

- [X] T007 [P] [AC3] Implement circular extends detection — `packages/credhelper/src/config/role-resolver.ts`
  - Track visited set during resolution
  - Detect cycles: "Circular extends chain detected: roleA → roleB → roleA"
  - Push error and skip role (fail closed)

## Phase 5: Cross-Reference Validation

- [X] T008 [AC4] Implement credential→backend validation — `packages/credhelper/src/config/validator.ts`
  - For each credential, verify `credential.backend` matches a `backend.id`
  - Push error with credential file path and specific credential id on mismatch

- [X] T009 [P] [AC4] Implement role→credential validation — `packages/credhelper/src/config/validator.ts`
  - For each role, for each `ref` in `credentials[]`, verify it matches a declared credential id
  - Push error with role file path, role id, and specific ref on mismatch

- [X] T010 [P] [AC4] Implement exposure→plugin validation (optional registry) — `packages/credhelper/src/config/validator.ts`
  - Only when `pluginRegistry` is provided in options (per C1)
  - Look up credential `type` in registry, check each `expose[].as` is supported
  - When registry absent: skip entirely

## Phase 6: Main Loader & Exports

- [X] T011 [AC1][AC5] Implement `loadConfig()` entry point — `packages/credhelper/src/config/loader.ts`
  - Orchestrate: read backends → credentials → overlay merge → trusted-plugins → roles → resolve extends → validate cross-refs → log overlay → throw or return
  - Accumulate all errors across all stages
  - Throw `ConfigValidationError` if any errors; return `ConfigResult` on success

- [X] T012 [P] [AC1] Create barrel exports and update package — `packages/credhelper/src/config/index.ts`, `packages/credhelper/src/index.ts`, `packages/credhelper/package.json`
  - Create `src/config/index.ts` barrel exporting `loadConfig`, `ConfigResult`, `LoadConfigOptions`, `ConfigValidationError`, `ConfigError`
  - Update `src/index.ts` to re-export from `./config/index.js`
  - Promote `yaml` from devDependency to dependency in `package.json`

## Phase 7: Test Fixtures

- [X] T013 [P] [AC3] Create additional test fixtures for extends and error cases — `packages/credhelper/src/__tests__/fixtures/`
  - `roles/senior-developer.yaml` extending `developer` (multi-level extends)
  - `roles/circular-a.yaml` and `roles/circular-b.yaml` (circular extends)
  - Fixture for invalid cross-references (missing backend, missing credential ref)

## Phase 8: Unit Tests

- [X] T014 [P] [AC2] Overlay merge tests — `packages/credhelper/src/__tests__/overlay.test.ts`
  - Override by id (full replacement)
  - Add new ids from overlay
  - No overlay file (passthrough)
  - Empty overlay (no changes)
  - Overlay ids tracking

- [X] T015 [P] [AC3] Role resolver tests — `packages/credhelper/src/__tests__/role-resolver.test.ts`
  - Single-level extends
  - Multi-level extends (chain)
  - Credential merge by ref (child overrides parent)
  - Circular extends detection
  - Missing parent role
  - Role without extends (passthrough)

- [X] T016 [P] [AC4] Cross-reference validator tests — `packages/credhelper/src/__tests__/validator.test.ts`
  - Valid config passes
  - Missing backend reference caught
  - Missing credential ref in role caught
  - Unsupported exposure kind caught (with registry)
  - Exposure validation skipped (without registry)
  - Multiple errors accumulated

## Phase 9: Integration Tests

- [X] T017 [AC1][AC2][AC3][AC4][AC5] Config loader integration tests — `packages/credhelper/src/__tests__/config-loader.test.ts`
  - Full valid config directory loads successfully
  - Missing required file (backends.yaml) fails
  - Missing required file (credentials.yaml) fails
  - Optional files missing is OK
  - Overlay merge works end-to-end
  - Role extends resolved end-to-end
  - Multiple validation errors reported together
  - Empty roles directory (no roles = valid)
  - Missing roles directory (valid per C4)

## Phase 10: Build Verification

- [X] T018 [AC1] Build and test verification
  - `pnpm run build` in `packages/credhelper/` — must compile cleanly
  - `pnpm run test` — all tests pass (Phase 1 + Phase 2)
  - Verify new exports accessible from barrel
  - Run full monorepo build for regressions

## Dependencies & Execution Order

```
T001 (errors) ──┐
T002 (types)  ──┼── T003+T004 (file reader) ── T005 (overlay) ──┐
                │                                                 │
                └── T006+T007 (role resolver) ──────────────────┼── T011 (loader) ── T012 (exports)
                │                                                │
                └── T008+T009+T010 (validator) ─────────────────┘
                                                                        │
T013 (fixtures) ─────────────────────────────────┐                     │
                                                  ├── T014+T015+T016 (unit tests) ── T017 (integration) ── T018 (verify)
```

**Phase boundaries** (sequential):
- Phase 1 (T001–T002) → Phase 2 (T003–T004) → Phase 3 (T005) → done in order
- Phase 4 (T006–T007) can start after Phase 1 completes (parallel with Phase 2–3)
- Phase 5 (T008–T010) can start after Phase 1 completes (parallel with Phase 2–4)
- Phase 6 (T011–T012) requires Phases 3, 4, 5 all complete
- Phase 7 (T013) can start any time (independent fixtures)
- Phase 8 (T014–T016) requires their respective implementation phases + T013
- Phase 9 (T017) requires Phase 6 + Phase 8
- Phase 10 (T018) is final gate

**Parallel opportunities**:
- T001 ‖ T002 (different files, no deps)
- T003 ‖ T004 (same file but different concerns, can be one task)
- T006 ‖ T007 (same file, circular detection is part of resolver)
- T008 ‖ T009 ‖ T010 (different validation concerns in same file)
- T013 independent of all implementation tasks
- T014 ‖ T015 ‖ T016 (independent test suites)
