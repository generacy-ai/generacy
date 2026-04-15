# Tasks: Populate LaunchRequest.credentials and Wire CredhelperClient

**Input**: Design documents from `/specs/478-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Config Plumbing

- [ ] T001 Add `tryLoadDefaultsRole()` to `packages/config/src/loader.ts` — follow existing `tryLoadOrchestratorSettings()` pattern, read `defaults.role` from `.generacy/config.yaml`, return `string | null`. Export from `packages/config/src/index.ts`.
- [ ] T002 [P] Add `credentialRole: z.string().optional()` to `WorkerConfigSchema` in `packages/orchestrator/src/worker/config.ts`.
- [ ] T003 Read `defaults.role` in `packages/orchestrator/src/config/loader.ts` — call `tryLoadDefaultsRole(configPath)` and set `worker.credentialRole`. Also support `GENERACY_CREDENTIAL_ROLE` env var override.

## Phase 2: Launcher Wiring

- [ ] T004 Update `createAgentLauncher()` in `packages/orchestrator/src/launcher/launcher-setup.ts` — add optional `credhelperClient?: CredhelperClient` parameter, pass it to `AgentLauncher` constructor.
- [ ] T005 Instantiate `CredhelperHttpClient` in `packages/orchestrator/src/worker/claude-cli-worker.ts` — check `existsSync(socketPath)` where `socketPath = process.env.GENERACY_CREDHELPER_SOCKET ?? '/run/generacy-credhelper/control.sock'`, pass client to `createAgentLauncher()`.
- [ ] T006 Add fail-fast startup check in `ClaudeCliWorker` constructor (`packages/orchestrator/src/worker/claude-cli-worker.ts`) — if `config.credentialRole` is set but socket doesn't exist, throw `CredhelperUnavailableError` with actionable message per clarification Q3.

## Phase 3: Credential Population at Spawn Sites

- [ ] T007 Create `buildLaunchCredentials()` helper in `packages/orchestrator/src/worker/credentials-helper.ts` — accepts `credentialRole: string | undefined`, returns `LaunchRequestCredentials | undefined` using `GENERACY_WORKFLOW_UID` (default 1001) and `GENERACY_WORKFLOW_GID` (default 1000).
- [ ] T008 Update `CliSpawner` in `packages/orchestrator/src/worker/cli-spawner.ts` — add `credentialRole?: string` to constructor, call `buildLaunchCredentials(this.credentialRole)` and add `credentials` to launch requests in `spawnPhase()` (line ~54), `runValidatePhase()` (line ~88), and `runPreValidateInstall()` (line ~117).
- [ ] T009 [P] Update `PrFeedbackHandler` in `packages/orchestrator/src/worker/pr-feedback-handler.ts` — read `this.config.credentialRole` in `spawnClaudeForFeedback()` (line ~301), add `credentials: buildLaunchCredentials(this.config.credentialRole)` to the launch request.
- [ ] T010 [P] Update `ConversationSpawner` in `packages/orchestrator/src/conversation/conversation-spawner.ts` — add `credentialRole?: string` to constructor, add `credentials: buildLaunchCredentials(this.credentialRole)` to launch request in `spawnTurn()` (line ~53).
- [ ] T011 Update `packages/orchestrator/src/server.ts` — pass `credentialRole` when constructing `ConversationSpawner` (line ~349). Also wire `CredhelperHttpClient` for the conversation launcher (line ~346). Pass `credentialRole` to `CliSpawner` via `ClaudeCliWorker`.

## Phase 4: Tests

- [ ] T012 [P] Create `packages/orchestrator/src/__tests__/launcher/launcher-setup.test.ts` — test that `createAgentLauncher()` passes client to `AgentLauncher` when provided, passes undefined when not.
- [ ] T013 [P] Extend `packages/orchestrator/src/__tests__/worker/cli-spawner.test.ts` — test `spawnPhase()`, `runValidatePhase()`, `runPreValidateInstall()` include `credentials` when `credentialRole` is set and omit when undefined.
- [ ] T014 [P] Extend `packages/orchestrator/src/__tests__/worker/pr-feedback-handler.test.ts` — test launch request includes `credentials` when `config.credentialRole` is set, omits when not.
- [ ] T015 [P] Extend `packages/orchestrator/src/__tests__/conversation/conversation-spawner.test.ts` — test `spawnTurn()` includes `credentials` when `credentialRole` is set, omits when not.
- [ ] T016 [P] Extend `packages/orchestrator/src/__tests__/worker/claude-cli-worker.test.ts` — test constructor throws `CredhelperUnavailableError` when `credentialRole` is set but socket doesn't exist; succeeds when `credentialRole` is undefined.

## Dependencies & Execution Order

```
Phase 1 (sequential):
  T001 ──► T003 (T003 uses tryLoadDefaultsRole from T001)
  T002 ──┘      (T003 sets worker.credentialRole from T002)

Phase 2 (sequential, after Phase 1):
  T004 ──► T005 ──► T006
  (T005 needs T004's updated createAgentLauncher signature)
  (T006 extends T005's ClaudeCliWorker changes)

Phase 3 (partially parallel, after Phase 2):
  T007 ──► T008 (T008 uses buildLaunchCredentials from T007)
           T009 [P] (uses T007, touches different file than T008)
           T010 [P] (uses T007, touches different file than T008/T009)
  T008 + T010 ──► T011 (T011 wires CliSpawner + ConversationSpawner changes)

Phase 4 (all parallel, after Phase 3):
  T012, T013, T014, T015, T016 [all P]
```

**Parallel opportunities**:
- T001 and T002 can run in parallel (different packages)
- T009 and T010 can run in parallel with T008 (different files, all depend on T007)
- All Phase 4 tests (T012-T016) can run in parallel
