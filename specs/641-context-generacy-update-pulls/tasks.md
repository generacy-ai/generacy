# Tasks: Fetch Registry Credentials for `generacy update`

**Input**: Design documents from `/specs/641-context-generacy-update-pulls/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Control-Plane Endpoint

- [ ] T001 [US1] Add `handleGetCredentialValue` handler in `packages/control-plane/src/routes/credentials.ts`
  - New exported function `handleGetCredentialValue(req, res, actor, params)`
  - Call `getCredentialBackend()` to get `ClusterLocalBackend` instance
  - Call `backend.fetchSecret(credentialId)` to get decrypted value
  - Return `{ value: string }` on success (200)
  - Return `{ error, code: 'CREDENTIAL_NOT_FOUND' }` on missing credential (404)
  - Return `{ error, code: 'BACKEND_ERROR' }` on decrypt/store failure (500)
  - Emit audit relay event on `cluster.credentials` channel (`action: 'credential_value_read'`)

- [ ] T002 [US1] Register route `GET /credentials/:id/value` in `packages/control-plane/src/router.ts`
  - Add route entry: `{ method: 'GET', pattern: /^\/credentials\/([^/]+)\/value$/, paramNames: ['id'], handler: handleGetCredentialValue }`
  - Import `handleGetCredentialValue` from `./routes/credentials.js`
  - Place before the existing `GET /credentials/:id` route (more specific pattern first)

## Phase 2: CLI Docker Config Utility

- [ ] T003 [P] [US1] Create `packages/generacy/src/cli/utils/docker-config.ts`
  - `materializeScopedDockerConfig(options: { projectDir, host, username, password })`: writes `<projectDir>/.generacy/.docker/config.json` with Docker auth JSON format (`{"auths":{"<host>":{"auth":"base64(user:pass)"}}}"`), mode 0600
  - `cleanupScopedDockerConfig(projectDir)`: removes `<projectDir>/.generacy/.docker/` directory recursively
  - `getScopedDockerConfigPath(projectDir)`: returns `<projectDir>/.generacy/.docker` (for `DOCKER_CONFIG` env)
  - Use `node:fs`, `node:path`, `node:buffer` (for base64 encoding)
  - Create parent `.generacy/.docker/` directory with `recursive: true`

- [ ] T004 [P] [US1] Add `extractImageHost` helper in `packages/generacy/src/cli/commands/update/index.ts` (or a local util)
  - Parse `image:` field from `.generacy/docker-compose.yml` (read YAML, extract from orchestrator service)
  - Extract registry host: split on first `/`, check if first segment contains `.` or `:` (port)
  - Return `undefined` for Docker Hub images (no host prefix) — signals no credential lookup needed

## Phase 3: Wire Update Command

- [ ] T005 [US1] Add `fetchRegistryCredential` helper in update command
  - Use `execSafe()` to run `docker compose exec -T orchestrator curl -sf --unix-socket /run/generacy-control-plane/control.sock http://localhost/credentials/registry-<host>/value`
  - Parse JSON response, validate with `CredentialValueResponseSchema`
  - Parse inner `value` field with `RegistryCredentialValueSchema` to get `{ username, password }`
  - Return `undefined` on any failure (exec error, non-200, parse failure)

- [ ] T006 [US1] [US2] Modify `updateCommand` action in `packages/generacy/src/cli/commands/update/index.ts`
  - After `getClusterContext()`, call `extractImageHost()` on compose file
  - If host is non-default, check cluster is running via `docker compose ps` (or rely on exec failure)
  - If running, call `fetchRegistryCredential(ctx, host)`
  - If credential found, call `materializeScopedDockerConfig()`
  - Modify `runCompose(ctx, ['pull'])` call to pass `DOCKER_CONFIG` env when scoped config exists
  - Wrap pull in `try/finally` with `cleanupScopedDockerConfig()` in finally block
  - If cluster offline (exec fails), print warning message and proceed with ambient Docker login

- [ ] T007 [US2] Add env option support to `runCompose` in `packages/generacy/src/cli/commands/cluster/compose.ts`
  - Add optional `env?: Record<string, string>` parameter to `runCompose()` signature
  - Pass env to `execSafe()` (merge with `process.env`)
  - SSH branch: export env vars in remote command prefix

## Phase 4: Tests

- [ ] T008 [P] [US1] Unit tests for `handleGetCredentialValue` endpoint
  - Test: returns `{ value }` when backend has the credential
  - Test: returns 404 when credential not found
  - Test: returns 500 when backend throws
  - Test: emits audit relay event on success
  - File: `packages/control-plane/src/routes/__tests__/credentials-value.test.ts`

- [ ] T009 [P] [US1] Unit tests for `docker-config.ts` utility
  - Test: `materializeScopedDockerConfig` writes correct JSON with base64 auth
  - Test: `cleanupScopedDockerConfig` removes directory
  - Test: `extractImageHost` parses various image formats correctly
  - File: `packages/generacy/src/cli/utils/__tests__/docker-config.test.ts`

- [ ] T010 [P] [US1] [US2] Unit tests for update command credential flow
  - Test: with-creds-running — scoped config materialized, DOCKER_CONFIG passed, cleaned up
  - Test: without-creds — no credential lookup for default images, pull proceeds normally
  - Test: cluster-offline — warning printed, pull proceeds with ambient config
  - File: `packages/generacy/src/cli/commands/update/__tests__/index.test.ts`

## Dependencies & Execution Order

```
T001 ──→ T002 (handler must exist before route registration)
T003 ─┐
T004 ─┼─→ T005 ──→ T006 (helpers needed before wiring)
T007 ─┘         ↗
T008 (parallel, after T001-T002)
T009 (parallel, after T003-T004)
T010 (after T006-T007)
```

- **Phase 1** (T001-T002): Sequential — endpoint handler then route registration
- **Phase 2** (T003-T004): Parallel — independent utility modules
- **Phase 3** (T005-T007): Sequential — helpers then wiring; T007 can parallel with T005
- **Phase 4** (T008-T010): T008 and T009 are parallel (independent test files); T010 depends on Phase 3 completion
