# Tasks: AgentLauncher Credentials Interceptor (Phase 3)

**Input**: Design documents from `/specs/465-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/credhelper-client.ts
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Types

- [ ] T001 [P] [US1] Add `@generacy-ai/credhelper` dependency to `packages/orchestrator/package.json` and run `pnpm install`
- [ ] T002 [P] [US1] Add `credentials?: LaunchRequestCredentials` field to `LaunchRequest` in `packages/orchestrator/src/launcher/types.ts` — import from `@generacy-ai/credhelper`
- [ ] T003 [P] [US1] Define error types (`CredhelperUnavailableError`, `CredhelperSessionError`) in `packages/orchestrator/src/launcher/credhelper-errors.ts` per contracts
- [ ] T004 [P] [US1] Export new types and modules from `packages/orchestrator/src/launcher/index.ts`

## Phase 2: Core Implementation

- [ ] T010 [US1] Implement `CredhelperClient` in `packages/orchestrator/src/launcher/credhelper-client.ts` — HTTP-over-Unix-socket client using `node:http` with `beginSession()` and `endSession()` methods, configurable `socketPath`, `connectTimeout` (5s), and `requestTimeout` (30s)
- [ ] T011 [P] [US1] Implement `generateSessionId()` in `packages/orchestrator/src/launcher/credentials-interceptor.ts` — composite key format `{agentId}-{workflowId}-{timestamp}-{random4}` using env vars `AGENT_ID`/`HOSTNAME`/`WORKFLOW_ID`
- [ ] T012 [US1] Implement `buildSessionEnv()` and `wrapCommand()` helpers in `packages/orchestrator/src/launcher/credentials-interceptor.ts` — env merge (4 vars: `GENERACY_SESSION_DIR`, `GIT_CONFIG_GLOBAL`, `GOOGLE_APPLICATION_CREDENTIALS`, `DOCKER_HOST`) and `sh -c` positional parameter wrapping
- [ ] T013 [US1] Implement `applyCredentials()` interceptor function in `packages/orchestrator/src/launcher/credentials-interceptor.ts` — orchestrates beginSession → env merge → command wrap → returns transformed spawn params with uid/gid and sessionId

## Phase 3: Async Migration & Wiring

- [ ] T020 [US1] Convert `AgentLauncher.launch()` from sync to `async` in `packages/orchestrator/src/launcher/agent-launcher.ts` — accept optional `CredhelperClient` in constructor, call interceptor when `request.credentials` is present, register `endSession()` cleanup on `exitPromise`
- [ ] T021 [P] [US2] Update caller: `packages/orchestrator/src/worker/claude-cli-worker.ts` (line ~117) — `await` the now-async `launch()` call, update `registerProcessLauncher` callback to handle async
- [ ] T022 [P] [US2] Update caller: `packages/orchestrator/src/conversation/conversation-spawner.ts` (line ~53) — `await` the now-async `launch()` call
- [ ] T023 [P] [US2] Update caller: `packages/orchestrator/src/worker/cli-spawner.ts` (lines ~54, ~89, ~118) — `await` all three `launch()` calls
- [ ] T024 [P] [US2] Update caller: `packages/orchestrator/src/worker/pr-feedback-handler.ts` (line ~301) — `await` the now-async `launch()` call

## Phase 4: Unit Tests

- [ ] T030 [P] [US3] Write unit tests for `CredhelperClient` in `packages/orchestrator/src/launcher/__tests__/credhelper-client.test.ts` — mock Unix socket HTTP server, test beginSession success/failure, endSession success/failure, connection timeout → `CredhelperUnavailableError`, response timeout, error code propagation
- [ ] T031 [P] [US1] Write unit tests for credentials interceptor in `packages/orchestrator/src/launcher/__tests__/credentials-interceptor.test.ts` — test `generateSessionId()` format, `buildSessionEnv()` output, `wrapCommand()` positional params, `applyCredentials()` full transform
- [ ] T032 [US1][US2] Extend existing `packages/orchestrator/src/launcher/__tests__/agent-launcher.test.ts` — add tests for: launch with credentials (mock client, verify session lifecycle), launch without credentials (no-op, no client call), credentials set but client unavailable throws, async return type
- [ ] T033 [US2] Update existing tests in `packages/orchestrator/src/launcher/__tests__/spawn-e2e.test.ts` and `claude-code-launch-plugin-integration.test.ts` — update all `launcher.launch()` calls to `await launcher.launch()` for async compatibility

## Phase 5: Integration

- [ ] T040 [US1] Write integration test: full lifecycle with mock credhelper daemon — begin session → spawn subprocess → verify session env in child → exit → end session called
- [ ] T041 [US3] Write integration test: credentials requested but no daemon running → verify `CredhelperUnavailableError` with descriptive message including socket path

## Dependencies & Execution Order

**Phase 1** (Setup): T001–T004 are all independent — run in parallel. T001 must complete before T010 (dependency installation).

**Phase 2** (Core): T010 (client) and T011 (session ID) can run in parallel. T012 (helpers) is independent. T013 (interceptor function) depends on T010, T011, T012.

**Phase 3** (Async Migration): T020 (async launcher) depends on T013. T021–T024 (caller updates) depend on T020 and can run in parallel with each other.

**Phase 4** (Tests): T030 and T031 can run in parallel (test independent modules). T032 depends on T020. T033 depends on T020.

**Phase 5** (Integration): T040 and T041 depend on all prior phases.

**Parallel opportunities**: 9 of 18 tasks are marked [P] — significant parallelism within each phase.
