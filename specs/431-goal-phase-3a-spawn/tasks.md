# Tasks: Phase 3a — Migrate spawnPhase to AgentLauncher

**Input**: Design documents from `/specs/431-goal-phase-3a-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Constructor Wiring

- [ ] T001 [US1] Add `AgentLauncher` as first constructor parameter to `CliSpawner` — import from `../launcher/agent-launcher.js`, keep `processFactory` (still needed by `runValidatePhase`/`runPreValidateInstall`)
  - File: `packages/orchestrator/src/worker/cli-spawner.ts`
- [ ] T002 [US1] Update `claude-cli-worker.ts` to pass `this.agentLauncher` as first arg when constructing `CliSpawner`
  - File: `packages/orchestrator/src/worker/claude-cli-worker.ts` (line ~338)

## Phase 2: Core Migration

- [ ] T003 [US1] Replace spawn logic in `spawnPhase()` — remove `PHASE_TO_COMMAND` lookup/null-check, manual `args` construction, and `processFactory.spawn()` call; replace with `agentLauncher.launch({ intent: { kind: 'phase', phase, prompt: options.prompt, sessionId: options.resumeSessionId }, cwd: options.cwd, env: options.env })`; extract `handle.process` for `manageProcess()`; ignore `handle.outputParser`
  - File: `packages/orchestrator/src/worker/cli-spawner.ts`
  - Do NOT pass `signal` to `launch()` (prevents double-kill race — `manageProcess()` owns abort)
  - Do NOT delete `PHASE_TO_COMMAND` constant (still used by `phase-loop.ts` and `runValidatePhase`)
- [ ] T004 [P] [US1] Update `spawnPhase()` log message to indicate spawn goes through AgentLauncher (append `(via AgentLauncher)` to log strings)
  - File: `packages/orchestrator/src/worker/cli-spawner.ts`
- [ ] T005 [P] [US1] Consider narrowing `spawnPhase()` `phase` parameter type from `WorkflowPhase` to `Exclude<WorkflowPhase, 'validate'>` to leverage compile-time safety (since `PhaseIntent.phase` excludes `'validate'`)
  - File: `packages/orchestrator/src/worker/cli-spawner.ts`

## Phase 3: Test Updates

- [ ] T006 [US2] Update `cli-spawner.test.ts` — create mock `AgentLauncher` wired to real `ClaudeCodeLaunchPlugin` and existing mock factory (`new AgentLauncher(new Map([['default', factory]]))`; `agentLauncher.registerPlugin(new ClaudeCodeLaunchPlugin())`); update `CliSpawner` constructor call in `beforeEach` to pass launcher as first arg
  - File: `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts`
  - Adjust env assertions to use `expect.objectContaining()` since `AgentLauncher` merges `process.env` into env
  - All behavioral assertions (phase sequencing, session resume, abort, env inheritance, timeout) must remain identical
- [ ] T007 [P] [US2] Update `cli-spawner-snapshot.test.ts` — route through `AgentLauncher → ClaudeCodeLaunchPlugin → RecordingProcessFactory` chain; verify snapshot is byte-identical to pre-refactor for command/args; check that `normalizeSpawnRecords()` handles env normalization (update if needed)
  - File: `packages/orchestrator/src/worker/__tests__/cli-spawner-snapshot.test.ts`
  - Snapshot env will include `process.env` entries from AgentLauncher merge — normalizer should strip these

## Phase 4: Verification

- [ ] T008 Run unit tests: `pnpm --filter orchestrator test -- cli-spawner.test.ts`
- [ ] T009 [P] Run snapshot tests: `pnpm --filter orchestrator test -- cli-spawner-snapshot.test.ts`
- [ ] T010 [P] Run type check: `pnpm --filter orchestrator typecheck`
- [ ] T011 Run full orchestrator test suite: `pnpm --filter orchestrator test`

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4

**Within Phase 1**: T001 → T002 (T002 depends on new constructor signature from T001)

**Within Phase 2**: T003 first (core migration), then T004 and T005 in parallel (both are independent refinements to `spawnPhase`)

**Within Phase 3**: T006 and T007 can run in parallel [P] (different test files, no shared state)

**Within Phase 4**: T008 first (unit tests catch wiring issues), then T009+T010 in parallel, then T011 (full suite as final gate)
