# Tasks: @generacy-ai/generacy-plugin-claude-code

**Input**: Design documents from `/specs/013-plugin-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, research.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1=Orchestrator Invokes Agent, US2=Handle Human Decisions, US3=Handle Agent Errors)

## Phase 1: Setup & Core Types

- [ ] T001 Create package scaffolding: `packages/generacy-plugin-claude-code/package.json` with dependencies (dockerode, pino, zod)
- [ ] T002 [P] Create `packages/generacy-plugin-claude-code/tsconfig.json` extending root config
- [ ] T003 [P] Create `packages/generacy-plugin-claude-code/src/index.ts` with placeholder exports
- [ ] T004 Define core types in `packages/generacy-plugin-claude-code/src/types.ts` (copy from contracts/plugin-interface.ts, add internal types)
- [ ] T005 [P] Define Zod validation schemas in `packages/generacy-plugin-claude-code/src/schemas.ts` (ContainerConfigSchema, InvokeOptionsSchema, InvokeParamsSchema)
- [ ] T006 [P] [US3] Create custom error classes in `packages/generacy-plugin-claude-code/src/errors.ts` (SessionNotFoundError, ContainerStartError, InvocationError classes)

## Phase 2: Container Management

- [ ] T010 [US1] Implement `ContainerManager` class in `packages/generacy-plugin-claude-code/src/container/container-manager.ts` with dockerode integration
- [ ] T011 [P] Define container types in `packages/generacy-plugin-claude-code/src/container/types.ts` (internal container state, health check types)
- [ ] T012 [US1] Implement container lifecycle methods: create(), start(), attach(), cleanup()
- [ ] T013 [US3] Add health check and timeout handling to ContainerManager
- [ ] T014 [US1] Write unit tests for ContainerManager in `packages/generacy-plugin-claude-code/tests/unit/container-manager.test.ts`

## Phase 3: Session Management

- [ ] T020 [US1] Define session types in `packages/generacy-plugin-claude-code/src/session/types.ts` (SessionState discriminated union, internal session interface)
- [ ] T021 [US1] Implement `Session` class in `packages/generacy-plugin-claude-code/src/session/session.ts` with state machine
- [ ] T022 [US1] Implement state transitions: created → running → executing → terminated
- [ ] T023 [US2] Add awaiting_input state for human decision handling
- [ ] T024 [US1] Implement `SessionManager` class in `packages/generacy-plugin-claude-code/src/session/session-manager.ts` (registry pattern)
- [ ] T025 Write unit tests for Session state machine in `packages/generacy-plugin-claude-code/tests/unit/session.test.ts`
- [ ] T026 [P] Write unit tests for SessionManager in `packages/generacy-plugin-claude-code/tests/unit/session-manager.test.ts`

## Phase 4: Output Streaming

- [ ] T030 [US1] Define output types in `packages/generacy-plugin-claude-code/src/streaming/types.ts` (RawOutputChunk from Claude Code JSON)
- [ ] T031 [US1] Implement `OutputParser` in `packages/generacy-plugin-claude-code/src/streaming/output-parser.ts` to parse Claude Code JSON Lines format
- [ ] T032 [US1] Implement `OutputStream` async generator in `packages/generacy-plugin-claude-code/src/streaming/output-stream.ts`
- [ ] T033 [US2] Add question detection logic to OutputParser (detect type: 'question' chunks with urgency)
- [ ] T034 [US3] Add error chunk detection and classification in OutputParser
- [ ] T035 Write unit tests for OutputParser in `packages/generacy-plugin-claude-code/tests/unit/output-parser.test.ts`

## Phase 5: Invocation

- [ ] T040 [US1] Define invocation types in `packages/generacy-plugin-claude-code/src/invocation/types.ts` (internal invocation state)
- [ ] T041 [US1] Implement `Invoker` class in `packages/generacy-plugin-claude-code/src/invocation/invoker.ts`
- [ ] T042 [US1] Build Claude Code CLI command with headless mode: `claude --headless --prompt "..." --output json`
- [ ] T043 [US1] Connect Invoker to Session and ContainerManager for execution flow
- [ ] T044 [US1] Implement mode setting via Agency integration (call `agency mode set <mode>` in container)
- [ ] T045 Write unit tests for Invoker in `packages/generacy-plugin-claude-code/tests/unit/invoker.test.ts`

## Phase 6: Plugin Integration

- [ ] T050 [US1] Implement `ClaudeCodePlugin` main class in `packages/generacy-plugin-claude-code/src/plugin/claude-code-plugin.ts`
- [ ] T051 [US1] Wire SessionManager, ContainerManager, Invoker, and OutputStream together
- [ ] T052 [US1] Implement public API: invoke(), invokeWithPrompt(), startSession()
- [ ] T053 [US2] Implement continueSession() for providing answers to questions
- [ ] T054 [US1] Implement endSession() with proper cleanup
- [ ] T055 [US1] Implement streamOutput() returning AsyncIterable<OutputChunk>
- [ ] T056 [US1] Implement setMode() for Agency mode control
- [ ] T057 Add pino structured logging throughout the plugin
- [ ] T058 Update `packages/generacy-plugin-claude-code/src/index.ts` with final exports

## Phase 7: Testing

- [ ] T060 Write integration tests in `packages/generacy-plugin-claude-code/tests/integration/plugin.integration.test.ts`
- [ ] T061 [P] Add mock Docker tests for CI environments without Docker access
- [ ] T062 [P] Create test fixtures for Claude Code JSON output samples
- [ ] T063 Verify all acceptance criteria pass: invoke in container, mode setting, output streaming, session management, headless mode, error handling, human decision handling

## Dependencies & Execution Order

**Sequential dependencies:**
- T001 → T002, T003 (package.json needed first)
- T004 → T005, T006 (types before schemas/errors)
- T010 → T012 → T013 (ContainerManager before lifecycle before health checks)
- T020 → T021 → T022, T023 (session types before Session class before states)
- T024 depends on T021 (SessionManager needs Session)
- T030 → T031 → T032 (output types before parser before stream)
- T040 → T041 → T042 → T043, T044 (invocation types before Invoker before CLI before wiring)
- T050 depends on T024, T012, T032, T041 (plugin needs all components)
- T060 depends on T050 (integration tests need plugin)

**Parallel opportunities (marked with [P]):**
- T002, T003, T005, T006 can run in parallel after T004
- T011 can run in parallel with T010
- T014 can run in parallel with T020-T026
- T025, T026 can run in parallel
- T030-T035 can run after Phase 3 setup is done, in parallel with T040-T045
- T061, T062 can run in parallel with T060

**Phase boundaries:**
- Phase 1 must complete before Phase 2
- Phase 2 (T010-T013) must complete before Phase 3 (SessionManager depends on ContainerManager)
- Phase 3 must complete before Phase 5 (Invoker depends on Session)
- Phase 4 must complete before Phase 6 (Plugin depends on OutputStream)
- Phase 5 must complete before Phase 6 (Plugin depends on Invoker)
- Phase 6 must complete before Phase 7 integration tests
