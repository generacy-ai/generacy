# Tasks: Scoped Private-Registry Credentials for `generacy launch`

**Input**: Design documents from `/specs/639-context-generacy-launch-cli/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Types

- [ ] T001 [US1] Add `RegistryCredentialsSchema` and extend `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts`

## Phase 2: Core Implementation

- [ ] T002 [US1] Implement scoped Docker config write + cleanup in `pullImage` (`packages/generacy/src/cli/commands/launch/compose.ts`)
  - Accept optional `registryCredentials?: RegistryCredentials` parameter
  - When present: create `<projectDir>/.docker/`, write `config.json` (mode 0600), set `DOCKER_CONFIG` env on subprocess
  - `finally` block: `rmSync('<projectDir>/.docker', { recursive: true, force: true })`
- [ ] T003 [US2] Preserve no-creds path — when `registryCredentials` is undefined, run `docker compose pull` with inherited env (existing behavior)
- [ ] T004 [US3] Add error parsing for 401/unauthorized and 404/not-found patterns in pull stderr, emit actionable error messages
- [ ] T005 [US1] Thread `config.registryCredentials` from launch orchestration to `pullImage` call in `packages/generacy/src/cli/commands/launch/index.ts`

## Phase 3: Tests

- [ ] T006 [P] [US2] Test: no-creds path calls `execSync` without `DOCKER_CONFIG` env override
- [ ] T007 [P] [US1] Test: with-creds path writes scoped `<projectDir>/.docker/config.json` with correct base64 auth, passes `DOCKER_CONFIG` env
- [ ] T008 [P] [US1] Test: scoped config directory is removed after successful pull
- [ ] T009 [P] [US1] Test: scoped config directory is removed even when pull throws
- [ ] T010 [P] [US3] Test: 401 stderr pattern produces auth-failure error message
- [ ] T011 [P] [US3] Test: 404 stderr pattern produces image-not-found error message

## Dependencies & Execution Order

- **T001** must complete first (types used by T002-T005)
- **T002, T003, T004** are sequential within `compose.ts` (same function modifications)
- **T005** depends on T001 and T002 (threads the new type through)
- **T006-T011** are all parallelizable (independent test cases), depend on T002-T005 being complete
