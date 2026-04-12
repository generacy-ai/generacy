# Tasks: Consolidate root-level claude-code-invoker

**Input**: Design documents from `/specs/436-goal-phase-5-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/invoke-intent.ts
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

### User Stories
- **US1**: Rewrite ClaudeCodeInvoker as thin adapter over AgentLauncher
- **US2**: Extend ClaudeCodeLaunchPlugin with `invoke` intent kind
- **US3**: Wire root worker to use AgentLauncher path
- **US4**: Test coverage for adapter, plugin, and integration

## Phase 1: Setup & Plugin Extension

- [X] T001 [US2] Add `InvokeIntent` interface and extend `ClaudeCodeIntent` union in `packages/generacy-plugin-claude-code/src/launch/types.ts`
- [X] T002 [US2] Add `'invoke'` to `supportedKinds` and implement `buildInvokeLaunch()` in `packages/generacy-plugin-claude-code/src/launch/claude-code-launch-plugin.ts`
- [X] T003 [P] [US1] Add `"@generacy-ai/orchestrator": "workspace:*"` to root `package.json` dependencies and run `pnpm install`
- [X] T004 [US2] Add invoke intent tests to `packages/generacy-plugin-claude-code/src/launch/__tests__/claude-code-launch-plugin.test.ts` — verify argv `['--print', '--dangerously-skip-permissions', '<command>']`, `stdioProfile: 'default'`, and no-op output parser

## Phase 2: Adapter Rewrite

- [X] T005 [US1] Rewrite `ClaudeCodeInvoker` constructor to accept `AgentLauncher`, remove `child_process` import — `src/agents/claude-code-invoker.ts`
- [X] T006 [US1] Implement `isAvailable()` via `generic-subprocess` intent (`{ kind: 'generic-subprocess', command: 'claude', args: ['--version'] }`) through `AgentLauncher` — `src/agents/claude-code-invoker.ts`
- [X] T007 [US1] Implement `invoke()`: build `LaunchRequest` with `invoke` intent, collect stdout/stderr from `LaunchHandle.process`, set up `setTimeout` + `kill('SIGTERM')` timeout, call `parseToolCalls()` and `combineOutput()`, return `InvocationResult` — `src/agents/claude-code-invoker.ts`
- [X] T008 [US1] Remove `buildArgs()` method; keep `parseToolCalls()`, `combineOutput()`, `buildEnvironment()` (adapted for `LaunchRequest.env`), and error code mapping — `src/agents/claude-code-invoker.ts`

## Phase 3: Worker Integration

- [X] T009 [US3] Update `src/worker/main.ts`: import `createAgentLauncher` and process factories from `@generacy-ai/orchestrator`, create launcher instance, pass to `new ClaudeCodeInvoker(agentLauncher)`

## Phase 4: Tests

- [X] T010 [P] [US4] Rewrite `tests/agents/claude-code-invoker.test.ts` as adapter-level tests — mock `AgentLauncher.launch()`, verify `InvocationConfig` → `LaunchRequest` translation, env merge, timeout handling, `parseToolCalls()` integration, `isAvailable()` via `generic-subprocess`, error propagation
- [X] T011 [P] [US4] Update `tests/worker/handlers/agent-handler.test.ts` — mock `AgentLauncher` in integration tests, verify end-to-end path: job payload → registry → invoker.invoke() → LaunchRequest

## Phase 5: Verification

- [X] T012 [US1] Verify `grep -n "child_process" src/agents/` returns nothing, `AgentInvoker` interface unchanged, and all tests pass

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

**Parallel opportunities within phases**:
- **Phase 1**: T003 (workspace dep) can run in parallel with T001/T002 (plugin types). T004 depends on T001+T002.
- **Phase 2**: T005 → T006 → T007 → T008 (sequential within the same file rewrite)
- **Phase 4**: T010 and T011 can run in parallel (different test files, no shared state)

**Cross-phase dependencies**:
- T005–T008 depend on T001–T002 (InvokeIntent type must exist before adapter uses it)
- T005–T008 depend on T003 (orchestrator workspace dep must be linked)
- T009 depends on T005–T008 (adapter must be rewritten before worker wiring)
- T010–T011 depend on T009 (tests exercise the fully wired path)
- T012 depends on T010–T011 (verification after all changes and tests)
