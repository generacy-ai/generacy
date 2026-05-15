# Tasks: App Config & File Exposure for Application Clusters

**Input**: Design documents from `/specs/622-summary-application-clusters/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/api.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which scope area this task belongs to (S1-S5 from plan)

## Phase 1: Schema Foundation

- [ ] T001 [S1] Add `file` variant to `ExposureConfigSchema` in `packages/credhelper/src/schemas/exposure.ts` — new discriminated union member `{ kind: 'file', path: z.string(), mode: z.number().optional() }`
- [ ] T002 [P] [S1] Add `file` variant to `ExposureOutputSchema` in `packages/credhelper/src/schemas/exposure.ts` — `{ kind: 'file', data: z.string(), path: z.string(), mode: z.number() }`
- [ ] T003 [P] [S1] Add `PluginFileExposure` type to `packages/credhelper/src/types/plugin-exposure.ts` — `{ kind: 'file', data: Buffer, path: string, mode?: number }` and extend `PluginExposureData` union
- [ ] T004 [P] [S1] Add `as: 'file'` variant to `RoleExposeSchema` in `packages/credhelper/src/schemas/roles.ts` — `{ as: 'file', path: z.string(), mode: z.number().optional() }`
- [ ] T005 [P] [S3] Add `AppConfigSchema` to `ClusterYamlSchema` in `packages/generacy/src/cli/commands/cluster/context.ts` — `AppConfigEnvEntrySchema`, `AppConfigFileEntrySchema`, `AppConfigSchema` as optional field
- [ ] T006 [P] [S3] Export `AppConfigSchema` from `packages/control-plane/src/schemas.ts` — import or redefine for control-plane use, plus `PutAppConfigEnvBodySchema` and `PostAppConfigFileBodySchema`

## Phase 2: Credhelper File Exposure

- [ ] T007 [S1] Create `packages/credhelper-daemon/src/file-path-denylist.ts` — `isPathDenied(absPath): boolean` checking prefixes `/etc/`, `/usr/`, `/bin/`, `/sbin/`, `/lib/`, `/lib64/`, `/proc/`, `/sys/`, `/dev/`, `/boot/`, `/run/generacy-credhelper/`, `/var/lib/generacy-credhelper/`, `/run/generacy-control-plane/`, and root `/` itself
- [ ] T008 Create unit tests `packages/credhelper-daemon/src/__tests__/file-path-denylist.test.ts` — allowed paths, denied paths, edge cases (trailing slashes, `..` traversal, exact root)
- [ ] T009 [S1] Add `renderFileExposure()` to `packages/credhelper-daemon/src/exposure-renderer.ts` — write blob to path with denylist check, `mkdir -p` parent, atomic temp+rename, set mode (default `0o640`) and ownership, dispatch from main `render()` method
- [ ] T010 [P] [S2] Create `packages/credhelper-daemon/src/plugins/core/credential-file.ts` — `resolve()` reads base64 blob from backend, `renderExposure('file')` returns decoded bytes as `PluginFileExposure`, `supportedExposures: ['file']`
- [ ] T011 [S2] Register `credentialFilePlugin` in `packages/credhelper-daemon/src/plugins/core/index.ts`
- [ ] T012 [P] [S2] Extend `gcp-service-account` plugin in `packages/credhelper-daemon/src/plugins/core/gcp-service-account.ts` — add `'file'` to `supportedExposures`, add `renderExposure('file')` branch for SA JSON key mode
- [ ] T013 [S1] Wire `file` exposure cleanup in session end — ensure `SessionManager.endSession()` deletes session-scoped files written by `renderFileExposure()`

## Phase 3: Control-Plane App-Config Endpoints

- [ ] T014 [S4] Create `packages/control-plane/src/services/app-config-env-store.ts` — `AppConfigEnvStore` class: read/write `/var/lib/generacy-app-config/env` with bare `KEY="escaped_value"` format, atomic rewrite (temp+fsync+rename), advisory lock via `.lock` file, methods: `get()`, `set(name, value)`, `delete(name)`, `list()`
- [ ] T015 [P] [S4] Create `packages/control-plane/src/services/app-config-file-store.ts` — `AppConfigFileStore` class: write decoded blob to `mountPath` (atomic temp+rename, mode `0640`, mkdir parents), store encrypted blob in `ClusterLocalBackend` (key `app-config/file/<id>`), read/update values metadata YAML at `/var/lib/generacy-app-config/values.yaml`
- [ ] T016 [S4] Create `packages/control-plane/src/routes/app-config.ts` — 5 route handlers:
  - `handleGetManifest` — re-read `cluster.yaml` from working tree, parse `appConfig:`, return `{ appConfig }` or `{ appConfig: null }`
  - `handleGetValues` — read values metadata, cross-reference manifest for `inManifest` flag
  - `handlePutEnv` — validate body, dispatch secret vs non-secret, update metadata, emit `cluster.app-config` relay event
  - `handleDeleteEnv` — remove from env file or backend, remove metadata, emit relay event
  - `handlePostFile` — validate `:id` in manifest, denylist check on `mountPath`, decode base64, store + write, emit relay event
- [ ] T017 [S4] Register routes in `packages/control-plane/src/router.ts` — 5 routes under `/app-config/`: `GET /manifest`, `GET /values`, `PUT /env`, `DELETE /env/:name`, `POST /files/:id`
- [ ] T018 [S4] Wire stores in `packages/control-plane/bin/control-plane.ts` — instantiate `AppConfigEnvStore` and `AppConfigFileStore`, pass to route handlers, init stores on startup

## Phase 4: CLI Commands

- [ ] T019 [S5] Create `packages/generacy/src/cli/commands/app-config/index.ts` — Commander.js `app-config` subcommand group
- [ ] T020 [S5] Create `packages/generacy/src/cli/commands/app-config/show.ts` — `docker compose exec` + `curl --unix-socket` to `GET /app-config/manifest` + `GET /app-config/values`, format output as table
- [ ] T021 [P] [S5] Create `packages/generacy/src/cli/commands/app-config/set.ts` — `docker compose exec` + `curl --unix-socket -X PUT` to `PUT /app-config/env`, `--secret` flag for secret values
- [ ] T022 [S5] Register `app-config` command in `packages/generacy/src/cli/index.ts`

## Phase 5: Tests

- [ ] T023 [P] Create `packages/credhelper-daemon/src/__tests__/credential-file-plugin.test.ts` — resolve round-trips base64 blob, renderExposure returns decoded bytes, unsupported exposure kind rejected
- [ ] T024 [P] Create `packages/credhelper-daemon/src/__tests__/exposure-renderer-file.test.ts` — writes blob to path, sets correct mode, rejects denied paths, creates parent dirs, cleans up on session end
- [ ] T025 [P] Create `packages/generacy/src/cli/commands/cluster/__tests__/context-appconfig.test.ts` — `AppConfigSchema` accepts full example, minimal `cluster.yaml` (no `appConfig:`) still parses, validates field types and defaults
- [ ] T026 Create `packages/control-plane/src/__tests__/app-config.test.ts` — integration tests for all 5 endpoints: manifest retrieval (present/absent), values listing, env set/delete (secret/non-secret), file upload (valid/invalid ID/denied path), relay event emission

## Dependencies & Execution Order

**Phase 1** (Schema Foundation): All T001-T006 can run in parallel after T001 (T002-T006 marked [P]). Pure type/schema changes with no runtime deps.

**Phase 2** (Credhelper File Exposure): T007 first (denylist), then T008 (tests) and T009 (renderer) depend on T007. T010 and T012 are parallel (different plugins). T011 depends on T010. T013 depends on T009.

**Phase 3** (Control-Plane): T014 and T015 are parallel (env store vs file store). T016 depends on both T014 and T015. T017 depends on T016. T018 depends on T017.

**Phase 4** (CLI): T019 first (command group), then T020 and T021 parallel, T022 last.

**Phase 5** (Tests): T023, T024, T025 are parallel. T026 depends on Phase 3 completion.

**Cross-phase**: Phase 2 depends on Phase 1 schemas. Phase 3 depends on Phase 1 schemas + Phase 2 denylist. Phase 4 depends on Phase 3 endpoints. Phase 5 can begin alongside Phase 2+ for unit tests (T008, T023-T025).
