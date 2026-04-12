# Tasks: Migrate conversation-spawner to AgentLauncher

**Input**: Design documents from `/specs/433-goal-phase-3c-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Shared Factory & Env Fix

- [X] T001 [US1] Create shared `createAgentLauncher()` factory in `packages/orchestrator/src/launcher/launcher-setup.ts`
  - New file exporting `createAgentLauncher(factories: { default: ProcessFactory; interactive: ProcessFactory }): AgentLauncher`
  - Encapsulates: `new AgentLauncher(factoryMap)`, `registerPlugin(GenericSubprocessPlugin)`, `registerPlugin(ClaudeCodeLaunchPlugin)`
  - Import `AgentLauncher`, `GenericSubprocessPlugin`, `ClaudeCodeLaunchPlugin` from existing modules

- [X] T002 [P] [US1] Fix `conversationProcessFactory` double-merge in `packages/orchestrator/src/conversation/process-factory.ts`
  - Change `env: { ...process.env, ...options.env }` → `env: options.env` (AgentLauncher owns the `process.env` base layer)
  - Per clarification Q3 and alignment with #425's ProcessFactory standardization

## Phase 2: Core Migration

- [X] T003 [US1] Migrate `ConversationSpawner` to use `AgentLauncher` in `packages/orchestrator/src/conversation/conversation-spawner.ts`
  - Replace constructor: `(processFactory: ProcessFactory, gracePeriodMs)` → `(agentLauncher: AgentLauncher, gracePeriodMs)`
  - Update `spawnTurn()`: build `LaunchRequest` with `intent: { kind: 'conversation-turn', message, sessionId, model, skipPermissions }`, `cwd`, `env: {}`, `signal: undefined`; call `agentLauncher.launch()`; return `launchHandle.process`
  - Update deprecated `spawn()`: same pattern but check for callers first — remove if unused, or make `message` optional in intent
  - Remove `PTY_WRAPPER` constant and `python3` command composition (lives in `ClaudeCodeLaunchPlugin`)
  - Remove `ProcessFactory` import, add `AgentLauncher` + `LaunchHandle` imports
  - `gracefulKill()` unchanged (no factory dependency)

## Phase 3: Wiring Updates

- [X] T004 [US1] Update `server.ts` to use `createAgentLauncher()` and pass to `ConversationSpawner`
  - File: `packages/orchestrator/src/server.ts`
  - Import `createAgentLauncher` from `./launcher/launcher-setup.js`
  - Create `agentLauncher` with `{ default: defaultProcessFactory, interactive: conversationProcessFactory }`
  - Pass `agentLauncher` to `new ConversationSpawner(agentLauncher, gracePeriodMs)` instead of `conversationProcessFactory`

- [X] T005 [P] [US1] Update `claude-cli-worker.ts` to use `createAgentLauncher()`
  - File: `packages/orchestrator/src/worker/claude-cli-worker.ts`
  - Replace inline `new AgentLauncher(...)` + `registerPlugin()` calls (lines 110-117) with `createAgentLauncher({ default: this.processFactory, interactive: conversationProcessFactory })`
  - Import `createAgentLauncher` from `../launcher/launcher-setup.js`
  - Remove now-unused direct imports of `AgentLauncher`, `GenericSubprocessPlugin`, `ClaudeCodeLaunchPlugin` if no longer referenced

## Phase 4: Test Updates

- [X] T006 [US2] Update `conversation-spawner.test.ts` mock targets from `processFactory.spawn()` to `agentLauncher.launch()`
  - File: `packages/orchestrator/src/conversation/__tests__/conversation-spawner.test.ts`
  - Replace `ProcessFactory` mock with `AgentLauncher` mock: `const launchFn = vi.fn()` returning `{ process: handle, outputParser: noopParser, metadata: { pluginId: 'claude-code', intentKind: 'conversation-turn' } }`
  - Update assertions: check `LaunchRequest` intent fields (`kind`, `message`, `sessionId`, `model`, `skipPermissions`) and `cwd` instead of positional spawn args
  - Update `gracefulKill()` test setup (constructor mock changes, kill logic unchanged)
  - If `spawn()` was removed in T003, delete its tests; otherwise update similarly

- [X] T007 [P] [US2] Add snapshot test verifying spawn command parity with pre-refactor baseline
  - File: `packages/orchestrator/src/conversation/__tests__/conversation-spawner.test.ts` (or new snapshot file)
  - Capture full `LaunchRequest` passed to `agentLauncher.launch()` as snapshot
  - Cross-verify `ClaudeCodeLaunchPlugin.buildConversationTurnLaunch()` produces byte-identical command to pre-refactor `python3 -u -c PTY_WRAPPER claude ...` invocation
  - Snapshot must include the embedded Python wrapper script content

- [X] T008 [P] [US2] Add integration test with mock binary verifying end-to-end PTY wrapper invocation
  - File: `packages/orchestrator/src/conversation/__tests__/conversation-spawner.integration.test.ts` (new)
  - Test full path: `ConversationSpawner → AgentLauncher → ClaudeCodeLaunchPlugin → ProcessFactory → child process`
  - Use mock binary (simple echo script) to verify: PTY wrapper invocation, stdin writing, stdout streaming, process exit handling

## Phase 5: Validation

- [X] T009 Run full test suites and verify zero regressions
  - Run `pnpm test --filter @generacy-ai/orchestrator` — all tests pass
  - Run `pnpm test --filter @generacy-ai/generacy-plugin-claude-code` — plugin tests pass
  - Verify `conversation-manager.test.ts` passes with ZERO changes (mocks `spawner.spawnTurn()` directly)
  - Verify snapshot tests confirm byte-identical spawn output

## Dependencies & Execution Order

```
T001 (launcher-setup) ──┬──> T003 (ConversationSpawner migration)
                         │
T002 (env fix) [P] ──────┘
                              │
T003 ────────────────────┬──> T004 (server.ts wiring)
                         │
T001 ────────────────────┴──> T005 (claude-cli-worker wiring) [P with T004]
                              │
T004 + T005 ─────────────┬──> T006 (test mock updates)
                         │
                         ├──> T007 (snapshot test) [P with T006, T008]
                         │
                         └──> T008 (integration test) [P with T006, T007]
                              │
T006 + T007 + T008 ──────> T009 (validation)
```

**Parallel opportunities**:
- T001 and T002 can run in parallel (different files, no shared dependencies)
- T004 and T005 can run in parallel (different files, both depend on T001+T003)
- T006, T007, and T008 can run in parallel (different test files/concerns)

**Phase boundaries** (sequential):
- Phase 1 (setup & fix) → Phase 2 (core migration) → Phase 3 (wiring) → Phase 4 (tests) → Phase 5 (validation)
