# Tasks: Agent Invocation Abstraction

**Input**: Design documents from `/specs/004-agent-invocation-abstraction/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup & Types

- [ ] T001 Create `src/agents/` directory and `src/agents/index.ts` barrel export
- [ ] T002 [P] Create `src/agents/types.ts` with AgentFeature enum, AgentInvoker interface, InvocationConfig, InvocationContext, InvocationResult, ToolCallRecord, InvocationError types
- [ ] T003 [P] Create `src/agents/errors.ts` with AgentUnavailableError, AgentInitializationError, AgentNotFoundError, DefaultAgentNotConfiguredError, AgentExistsError classes and InvocationErrorCodes const

## Phase 2: Tests First

- [ ] T010 [US2] Create `tests/agents/agent-registry.test.ts` with tests for:
  - Register an agent invoker
  - Unregister an agent invoker
  - Get agent by name (found and not found)
  - List all registered agents
  - Set and get default agent
  - Throw AgentExistsError on duplicate registration
  - Throw AgentNotFoundError when getting non-existent agent
  - Throw DefaultAgentNotConfiguredError when default not set
  - Throw AgentNotFoundError when setting default to non-existent agent

- [ ] T011 [US1] [US3] Create `tests/agents/claude-code-invoker.test.ts` with tests for:
  - isAvailable() returns true when claude CLI exists
  - isAvailable() returns false when claude CLI missing
  - initialize() succeeds when CLI available
  - initialize() throws AgentInitializationError when CLI unavailable
  - supports() returns true for Streaming and McpTools features
  - invoke() executes command and captures stdout/stderr
  - invoke() returns success=true with output on zero exit code
  - invoke() returns success=false with COMMAND_FAILED error on non-zero exit
  - invoke() returns success=false with TIMEOUT error when timeout exceeded
  - invoke() passes mode via environment variable
  - invoke() uses working directory from context
  - invoke() parses tool calls from structured output
  - shutdown() completes without error

## Phase 3: Core Implementation

- [ ] T020 [US2] Create `src/agents/agent-registry.ts` implementing AgentRegistry class with:
  - Private agents Map<string, AgentInvoker>
  - Private defaultAgentName: string | undefined
  - register(invoker) - throws AgentExistsError if duplicate
  - unregister(name) - removes from map
  - get(name) - returns invoker or undefined
  - list() - returns all invokers
  - setDefault(name) - throws AgentNotFoundError if not registered
  - getDefault() - throws DefaultAgentNotConfiguredError if not set

- [ ] T021 [US1] [US2] [US3] Create `src/agents/claude-code-invoker.ts` implementing ClaudeCodeInvoker class with:
  - name = 'claude-code' readonly property
  - Private supportedFeatures Set with Streaming and McpTools
  - supports(feature) - checks supportedFeatures set
  - isAvailable() - checks if 'claude' command exists using which/where
  - initialize() - throws AgentInitializationError if not available
  - invoke(config) - spawns claude process with context, handles timeout, captures output
  - shutdown() - no-op for CLI-based invoker
  - Private parseToolCalls(output) - extracts ToolCallRecord[] from output

## Phase 4: Integration & Export

- [ ] T030 Update `src/agents/index.ts` to export all types, errors, AgentRegistry, and ClaudeCodeInvoker
- [ ] T031 [P] Update `src/types/index.ts` to re-export agent types from `../agents/index.js`

## Phase 5: Verification

- [ ] T040 Run all tests with `npm test` and ensure 100% pass rate
- [ ] T041 [P] Run linter with `npm run lint` and fix any issues
- [ ] T042 Verify acceptance criteria:
  - Claude Code agent invocation works
  - Plugin interface (AgentInvoker) is available for additional agents
  - Mode passed through InvocationConfig.context
  - Output capture and parsing works
  - Timeout and error handling (hybrid approach) works
  - Agent availability checks work
  - Default agent configuration works (fail if unavailable)
  - ToolCallRecord captures standard detail level

## Dependencies & Execution Order

### Phase 1 (Setup)
- T001 creates the directory structure
- T002 and T003 can run in parallel after T001 (different files, no dependencies)

### Phase 2 (Tests)
- T010 and T011 can run in parallel after Phase 1 (test files for different components)
- Tests depend on types and errors from Phase 1

### Phase 3 (Implementation)
- T020 depends on T002, T003 (needs types and errors)
- T021 depends on T002, T003, and implicitly T020 (may reference registry patterns)
- T020 and T021 cannot run in parallel as T021 may need registry patterns from T020

### Phase 4 (Integration)
- T030 depends on T020, T021 (exports implementations)
- T031 can run in parallel with T030 (different file)

### Phase 5 (Verification)
- T040 depends on all implementation tasks
- T041 can run in parallel with T040
- T042 depends on T040 passing

### Summary
- **Parallel opportunities**: T002+T003, T010+T011, T030+T031, T040+T041
- **Critical path**: T001 → T002/T003 → T010/T011 → T020 → T021 → T030 → T040 → T042

---

*Generated by speckit*
