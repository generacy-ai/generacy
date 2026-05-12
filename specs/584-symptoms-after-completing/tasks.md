# Tasks: VS Code Tunnel Lifecycle in Control-Plane

**Input**: Design documents from `/specs/584-symptoms-after-completing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Types

- [ ] T001 [US1] Add `vscode-tunnel-start` and `vscode-tunnel-stop` to `LifecycleActionSchema` in `packages/control-plane/src/schemas.ts`

## Phase 2: Core Implementation

- [ ] T002 [US1] Create `VsCodeTunnelProcessManager` in `packages/control-plane/src/services/vscode-tunnel-manager.ts` — singleton DI, `start()`/`stop()`/`getStatus()`/`shutdown()`, child process spawn with SIGTERM/SIGKILL, stdout line-by-line parsing for device code (`/[A-Z0-9]{4}-[A-Z0-9]{4}/`) and verification URI, 30s device-code timeout, relay event emission on `cluster.vscode-tunnel` channel, env-based options (`VSCODE_CLI_BIN`, `GENERACY_CLUSTER_ID`)
- [ ] T003 [P] [US1] Add `vscode-tunnel-start` and `vscode-tunnel-stop` dispatch branches in `packages/control-plane/src/routes/lifecycle.ts` — call `getVsCodeTunnelManager().start()`/`.stop()`, return JSON result
- [ ] T004 [P] [US1] Wire tunnel auto-start into `bootstrap-complete` handler in `packages/control-plane/src/routes/lifecycle.ts` — call `getVsCodeTunnelManager().start()` after writing sentinel file
- [ ] T005 [P] [US1] Add `shutdown()` call for tunnel manager in `packages/control-plane/src/server.ts` close handler

## Phase 3: Scaffolder Volume

- [ ] T006 [US2] Add `vscode-cli:/home/node/.vscode-cli` named volume to orchestrator service in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — volume declaration + mount, orchestrator only

## Phase 4: Tests

- [ ] T007 [P] [US1] Create unit tests for `VsCodeTunnelProcessManager` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` — mock `child_process.spawn`, test state machine transitions (stopped→starting→authorization_pending→connected), device code parsing, 30s timeout→error, stop/SIGTERM/SIGKILL, relay event emission
- [ ] T008 [P] [US1] Create lifecycle route integration tests in `packages/control-plane/__tests__/lifecycle-vscode-tunnel.test.ts` — test `vscode-tunnel-start`/`vscode-tunnel-stop` dispatch, bootstrap-complete auto-start
- [ ] T009 [P] [US2] Add `vscode-cli` volume assertions to scaffolder tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts`

## Dependencies & Execution Order

1. **T001** first — schemas must exist before lifecycle routes or manager reference them
2. **T002** next — core manager implementation, required by T003-T005
3. **T003, T004, T005** in parallel — all modify different sections/files, depend only on T002
4. **T006** independent — can run anytime (different package), but logically after core
5. **T007, T008, T009** in parallel — all test files, independent of each other, depend on T002-T006 being complete
