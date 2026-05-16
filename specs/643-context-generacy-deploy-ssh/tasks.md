# Tasks: Deploy SSH — Registry Credential Authentication

**Input**: Design documents from `/specs/643-context-generacy-deploy-ssh/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Setup

- [ ] T001 [US1] Add `CREDENTIAL_WRITE_FAILED` to `DeployErrorCode` in `packages/generacy/src/cli/commands/deploy/types.ts`
- [ ] T002 [P] [US1] Add `sshExecWithInput()` helper to `packages/generacy/src/cli/commands/deploy/ssh-client.ts` — wraps `execSync` with `input` option for stdin-piped content (needed for writing Docker config without shell escaping)

## Phase 2: Core Implementation

- [ ] T003 [US1] Create `packages/generacy/src/cli/commands/deploy/remote-credentials.ts` — three exports: `buildDockerConfigJson(credentials)`, `writeRemoteDockerConfig(target, remotePath, credentials)` (uses `sshExecWithInput` to pipe config.json via stdin), `cleanupRemoteDockerConfig(target, remotePath)` (idempotent `rm -f` + `rmdir || true`)
- [ ] T004 [P] [US1] Create `packages/generacy/src/cli/commands/deploy/credential-forward.ts` — `forwardCredentialsToCluster(target, remotePath, credentials, logger)` returns `ForwardResult`; for each credential, runs `sshExec` wrapping `docker compose exec -T orchestrator curl --unix-socket /run/generacy-control-plane/control.sock -sf -X PUT http://localhost/credentials/registry-<host>` with JSON body `{type:"registry",value:"<base64>"}`. Catches individual failures, returns aggregated result.

## Phase 3: Integration

- [ ] T005 [US1] Modify `packages/generacy/src/cli/commands/deploy/remote-compose.ts` — `deployToRemote()` gains optional `registryCredentials?: RegistryCredential[]` param; when present, calls `writeRemoteDockerConfig` before pull, prepends `DOCKER_CONFIG=<remotePath>/.docker` to the `docker compose pull` command, wraps pull in try/finally calling `cleanupRemoteDockerConfig`
- [ ] T006 [US1] Modify `packages/generacy/src/cli/commands/deploy/index.ts` — pass `launchConfig.registryCredentials` to `deployToRemote()`; after `pollClusterStatus()`, if credentials exist, call `forwardCredentialsToCluster()` and handle result: log warnings for failures, print remediation message suggesting `generacy registry-login --remote` or UI re-entry, continue to exit 0

## Phase 4: Tests

- [ ] T007 [P] [US1] Create `packages/generacy/src/cli/commands/deploy/__tests__/remote-credentials.test.ts` — unit tests for `buildDockerConfigJson` (single/multi registry output), `writeRemoteDockerConfig` (mocked `sshExecWithInput` called with correct stdin + path), `cleanupRemoteDockerConfig` (mocked `sshExec` called with `rm -f` command)
- [ ] T008 [P] [US1] Create `packages/generacy/src/cli/commands/deploy/__tests__/credential-forward.test.ts` — unit tests for `forwardCredentialsToCluster`: success path (all forwarded), partial failure (one fails, others succeed → correct ForwardResult), full failure (all fail → still returns without throwing)
- [ ] T009 [US2] Verify existing deploy tests still pass (no regression for default-image deploys without credentials) — run existing test suite, ensure `deployToRemote` with `undefined` credentials skips all credential logic

## Dependencies & Execution Order

```
T001 ─┐
      ├──> T003 ──> T005 ──> T006
T002 ─┘           /
                 /
T004 ───────────────────────> T006

T007 (parallel, after T003)
T008 (parallel, after T004)
T009 (after T005 + T006)
```

- **T001 + T002** are independent setup tasks (parallel)
- **T003** depends on T002 (uses `sshExecWithInput`)
- **T004** depends on T002 (uses `sshExec`) — parallel with T003
- **T005** depends on T003 (imports remote-credentials functions)
- **T006** depends on T004 + T005 (wires both modules into orchestration)
- **T007** parallel with T005+ (tests T003)
- **T008** parallel with T005+ (tests T004)
- **T009** runs last (validates no regression)
