# Tasks: CLI deploy ssh://host command

**Input**: Design documents from `/specs/500-context-technical-cloud-power/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ssh-target.schema.json
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Activation Client Package

- [X] T001 Create `packages/activation-client/` package structure — `package.json` (name `@generacy-ai/activation-client`, ESM, zero runtime deps beyond zod), `tsconfig.json`
- [X] T002 [P] Create `packages/activation-client/src/types.ts` — `DeviceCodeResponseSchema`, `PollResponseSchema`, `ActivationClientOptions`, `ActivationResult` (from data-model.md)
- [X] T003 [P] Create `packages/activation-client/src/errors.ts` — `ActivationError` class with codes `CLOUD_UNREACHABLE`, `DEVICE_CODE_EXPIRED`, `INVALID_RESPONSE`
- [X] T004 Create `packages/activation-client/src/client.ts` — HTTP client: `initDeviceFlow()` → `POST /api/clusters/device-code`, `pollDeviceCode()` → `POST /api/clusters/device-code/poll`. Uses `node:http`/`node:https`
- [X] T005 Create `packages/activation-client/src/poller.ts` — `pollForApproval()` with `slow_down` (+5s) and `expired` (auto-retry up to 3 cycles) handling
- [X] T006 Create `packages/activation-client/src/index.ts` — Public API re-exports: `initDeviceFlow`, `pollForApproval`, all types/errors
- [X] T007 [P] Write unit tests `packages/activation-client/tests/unit/client.test.ts` and `poller.test.ts`
- [X] T008 Update `packages/orchestrator/src/activation/index.ts` to delegate to `@generacy-ai/activation-client` — remove inlined `client.ts`/`poller.ts`, keep `persistence.ts` wrapper. Update `packages/orchestrator/package.json` to add workspace dep

## Phase 2: Deploy Command Core

- [ ] T009 Create `packages/generacy/src/cli/commands/deploy/types.ts` — `SshTarget`, `DeployOptions`, `DeployResult`, `DeployError` class with error codes (from data-model.md)
- [ ] T010 [P] [US1] Implement `packages/generacy/src/cli/commands/deploy/ssh-target.ts` — `parseSshTarget(target: string): SshTarget` using `URL` constructor with defaults (user → `os.userInfo().username`, port → 22, path → null). Validate scheme is `ssh://`
- [ ] T011 [P] [US1] Implement `packages/generacy/src/cli/commands/deploy/ssh-client.ts` — `verifySshConnectivity(target)`, `verifyDockerPresence(target)`, `scpDirectory(target, localDir, remotePath)`, `sshExec(target, command)`. Uses `node:child_process`, `BatchMode=yes`, `StrictHostKeyChecking=accept-new`
- [ ] T012 [US1] Implement `packages/generacy/src/cli/commands/deploy/activation.ts` — Device-flow wrapper: calls `@generacy-ai/activation-client`, opens browser with `verification_uri` via `openUrl()` from `src/cli/utils/browser.ts`
- [ ] T013 [P] [US1] Implement `packages/generacy/src/cli/commands/deploy/cloud-client.ts` — `fetchLaunchConfig(cloudUrl, claimCode)` reused from `launch/cloud-client.ts` (import or extract shared helper)
- [ ] T014 [US1] Implement `packages/generacy/src/cli/commands/deploy/scaffolder.ts` — Generate bootstrap bundle in temp dir: `cluster.yaml`, `cluster.json`, `docker-compose.yml` from `LaunchConfig` + `ActivationResult`
- [ ] T015 [US1] Implement `packages/generacy/src/cli/commands/deploy/remote-compose.ts` — SCP bundle via `scpDirectory()`, then SSH `docker compose pull && docker compose up -d`
- [ ] T016 [US1] Implement `packages/generacy/src/cli/commands/deploy/status-poller.ts` — Poll cloud cluster status until `status === 'connected'`. Exponential backoff (3s initial, 1.5x, 15s max). Default 5-min timeout, configurable via `--timeout`

## Phase 3: Integration & Wiring

- [ ] T017 [US2] Extend `packages/generacy/src/cli/commands/cluster/registry.ts` — Add optional `managementEndpoint` field to `RegistryEntrySchema`
- [ ] T018 [US1] Implement `packages/generacy/src/cli/commands/deploy/index.ts` — Main orchestration: parse target, verify SSH+Docker, activate device-flow, fetch LaunchConfig, scaffold, SCP, compose up, stream logs + poll status, register cluster. Commander.js command with `--timeout` flag
- [ ] T019 [US1] Register deploy command in `packages/generacy/src/cli/index.ts`
- [ ] T020 [US2] Extend `packages/generacy/src/cli/commands/cluster/compose.ts` — Add SSH-forwarding branch: when `managementEndpoint` starts with `ssh://`, parse target and run `docker compose` over SSH instead of locally. Add `packages/generacy/package.json` workspace dep on `@generacy-ai/activation-client`

## Phase 4: Tests

- [ ] T021 [P] [US1] Unit test `packages/generacy/tests/unit/deploy/ssh-target.test.ts` — Parse valid URLs, defaults, IPv6, invalid schemes, edge cases
- [ ] T022 [P] [US1] Unit test `packages/generacy/tests/unit/deploy/ssh-client.test.ts` — Mock child_process, verify SSH flag construction, error handling
- [ ] T023 [P] [US1] Unit test `packages/generacy/tests/unit/deploy/activation.test.ts` — Mock activation-client, verify browser-open call
- [ ] T024 [P] [US1] Unit test `packages/generacy/tests/unit/deploy/scaffolder.test.ts` — Verify bundle file generation from LaunchConfig
- [ ] T025 [P] [US1] Unit test `packages/generacy/tests/unit/deploy/status-poller.test.ts` — Verify backoff, timeout, connected detection
- [ ] T026 [P] [US1] Unit test `packages/generacy/tests/unit/deploy/remote-compose.test.ts` — Mock SSH client, verify SCP + compose sequence
- [ ] T027 [US2] Unit test `packages/generacy/tests/unit/cluster/compose-ssh.test.ts` — Verify SSH forwarding branch in compose helper
- [ ] T028 [US1] Integration test `packages/generacy/tests/integration/deploy-dind.test.ts` — DinD container as SSH target, end-to-end deploy flow

## Dependencies & Execution Order

**Phase 1 → Phase 2 → Phase 3 → Phase 4** (sequential phase boundaries)

### Phase 1 (Activation Client)
- T001 first (package structure)
- T002, T003 in parallel (types and errors, no deps)
- T004 after T002+T003 (client uses types/errors)
- T005 after T004 (poller wraps client)
- T006 after T004+T005 (re-exports all)
- T007 in parallel with T005/T006 (tests can be written against types)
- T008 after T006 (orchestrator refactor needs complete package)

### Phase 2 (Deploy Command)
- T009 first (types used by all other files)
- T010, T011, T013 in parallel (independent modules)
- T012 after T010 (uses SshTarget type, activation-client)
- T014 after T013 (scaffolder uses LaunchConfig)
- T015 after T011+T014 (uses ssh-client + scaffolder output)
- T016 independent (only needs types)

### Phase 3 (Integration)
- T017 first (registry schema needed by deploy index)
- T018 after T017 + all Phase 2 (orchestrates everything)
- T019 after T018 (registers command)
- T020 after T017 (uses updated registry schema)

### Phase 4 (Tests)
- T021–T026 all in parallel (independent test files)
- T027 after T020 (tests SSH forwarding)
- T028 last (integration test needs everything wired)

**Parallel opportunities**: 8 tasks can run in parallel within their phases (marked with [P])
