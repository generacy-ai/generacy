# Tasks: Forward Registry Credentials to Credhelper After Launch

**Input**: Design documents from `/specs/640-context-after-generacy-launch/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema Extension

- [ ] T001 [US1] Add `registryCredentials` field to `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts` — array of `{ host: z.string(), auth: z.string() }`, optional

## Phase 2: Core Implementation

- [ ] T002 [US1] Create `packages/generacy/src/cli/commands/launch/credential-forward.ts` with `probeControlPlaneReady(projectDir, opts)` — runs `docker compose exec -T orchestrator curl --unix-socket /run/generacy-control-plane/control.sock -sf http://localhost/state` with retry loop (10 attempts, 2s interval)
- [ ] T003 [P] [US1] Implement `forwardRegistryCredentials(projectDir, credentials)` in `credential-forward.ts` — for each `{ host, auth }`, PUTs to `/credentials/registry-<host>` via docker compose exec curl. Returns `{ forwarded: string[], failed: string[] }`
- [ ] T004 [P] [US1] Implement `cleanupScopedDockerConfig(projectDir)` in `credential-forward.ts` — removes `<projectDir>/.generacy/.docker/` recursively using `fs.rm({ recursive: true, force: true })`

## Phase 3: Integration

- [ ] T005 [US1] Integrate credential forwarding into `launchAction` in `packages/generacy/src/cli/commands/launch/index.ts` — after `streamLogsUntilActivation` resolves and before `registerCluster`: probe control-plane, forward creds, cleanup on success, warn on failure (non-fatal)

## Phase 4: Tests

- [ ] T006 [P] [US1] Write unit tests for `probeControlPlaneReady` — mock `spawnSync`, test success on first attempt, success after retries, and timeout exhaustion
- [ ] T007 [P] [US1] Write unit tests for `forwardRegistryCredentials` — mock `spawnSync`, test success path (200 exit 0), partial failure (some hosts fail), and all-fail scenario
- [ ] T008 [P] [US1] Write unit tests for `cleanupScopedDockerConfig` — mock `fs.rm`, test successful deletion and idempotent behavior when dir doesn't exist
- [ ] T009 [US1] Write integration test for the full credential-forward flow in `launchAction` — verify: creds forwarded + cleanup on success, warning logged + no cleanup on probe failure, warning logged + no cleanup on PUT failure

## Dependencies & Execution Order

```
T001 (schema) ─────────────────────────────────┐
                                                 ├─→ T005 (integration) ─→ T009 (integration test)
T002 (probe) ──┐                                │
T003 (forward) ┼─ parallel within Phase 2 ─────┘
T004 (cleanup) ┘

T006 (probe test) ──┐
T007 (forward test) ┼─ parallel, can start after Phase 2
T008 (cleanup test) ┘
```

- **Phase 1** (T001): Must complete first — T002-T004 import the `RegistryCredential` type
- **Phase 2** (T002-T004): T003 and T004 are parallel with each other; T002 is independent
- **Phase 3** (T005): Depends on T001-T004 (imports all three functions + type)
- **Phase 4** (T006-T008): Parallel, can start after their respective Phase 2 targets exist; T009 depends on T005
