# Tasks: `generacy registry-login` / `registry-logout`

**Input**: Design documents from `/specs/642-context-power-users-who/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Helpers

- [ ] T001 [US1] Create `packages/generacy/src/cli/commands/registry-login/docker-config.ts` — Docker config read/write/add/remove helpers with atomic writes (tmp+rename), `getDockerConfigDir()`, `dockerConfigExists()`. Uses `node:fs` and `node:path`.
- [ ] T002 [P] [US1] Create `packages/generacy/src/cli/commands/registry-login/credential-forward.ts` — `forwardCredential()`, `removeCredential()`, `isClusterRunning()`. Uses `execSafe()` to run `docker compose exec orchestrator curl --unix-socket ...` pattern.

## Phase 2: Commands

- [ ] T003 [US1] Create `packages/generacy/src/cli/commands/registry-login/index.ts` — Commander.js subcommand `registry-login <host>`. Flow: resolve cluster context via `getClusterContext()`, prompt username (`p.text()`), prompt token (`p.password()`), write scoped config, forward if cluster running.
- [ ] T004 [P] [US1] Create `packages/generacy/src/cli/commands/registry-logout/index.ts` — Commander.js subcommand `registry-logout <host>`. Flow: resolve cluster context, remove from scoped config, remove from control-plane if running, print success.

## Phase 3: Integration

- [ ] T005 [US1] Modify `packages/generacy/src/cli/commands/cluster/compose.ts` — In `runCompose()`, before spawning, check if `<ctx.generacyDir>/.docker/config.json` exists. If yes, set `DOCKER_CONFIG=<ctx.generacyDir>/.docker` in spawn env. Pass merged env to `execSafe()`.
- [ ] T006 [US1] Register commands in `packages/generacy/src/cli/index.ts` — Import and `addCommand()` for both `registryLoginCommand()` and `registryLogoutCommand()`.

## Phase 4: Tests

- [ ] T007 [P] [US1] Create `packages/generacy/src/cli/commands/registry-login/__tests__/docker-config.test.ts` — Unit tests: write/read round-trip, addAuth base64 encoding, removeAuth, atomic write (no partial), never modifies `~/.docker`, creates `.docker/` dir if missing.
- [ ] T008 [P] [US1] Create `packages/generacy/src/cli/commands/registry-login/__tests__/credential-forward.test.ts` — Unit tests: mock `execSafe`, verify curl command structure for PUT and DELETE, verify `isClusterRunning` parsing.
- [ ] T009 [P] [US1] Create `packages/generacy/src/cli/commands/registry-login/__tests__/registry-login.test.ts` — Unit tests: mock prompts + helpers, verify full flow (offline and online paths), cancel handling.
- [ ] T010 [P] [US1] Create `packages/generacy/src/cli/commands/registry-logout/__tests__/registry-logout.test.ts` — Unit tests: mock helpers, verify removal from both scoped config and control-plane.
- [ ] T011 [P] [US1] Add test case in compose tests verifying `DOCKER_CONFIG` auto-detection — when `.docker/config.json` exists, env is set; when absent, env is not set.

## Dependencies & Execution Order

```
Phase 1: T001, T002 (parallel — independent helper modules)
    ↓
Phase 2: T003, T004 (parallel — both depend on Phase 1 helpers)
    ↓
Phase 3: T005, T006 (T005 independent of Phase 2; T006 depends on T003+T004)
    ↓
Phase 4: T007–T011 (all parallel — independent test files)
```

- T003 depends on T001 + T002 (imports helpers)
- T004 depends on T001 + T002 (imports helpers)
- T005 is independent of T003/T004 (modifies compose.ts only)
- T006 depends on T003 + T004 (imports command constructors)
- All test tasks (T007–T011) can run in parallel once implementation is complete
