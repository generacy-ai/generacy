# Tasks: @generacy-ai/generacy-plugin-copilot

**Input**: Design documents from `/specs/014-plugin-generacy-ai-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/plugin-interface.ts
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story/acceptance criteria this task addresses

## Phase 1: Project Setup

- [ ] T001 Create package directory `packages/generacy-plugin-copilot/` with package.json
- [ ] T002 [P] Create tsconfig.json with ES module and strict TypeScript settings
- [ ] T003 [P] Create vitest.config.ts for test configuration

## Phase 2: Core Types and Schemas

- [ ] T010 [P] [AC1-4] Create `src/types.ts` with Workspace, WorkspaceStatus, WorkspaceStatusEvent types
- [ ] T011 [P] [AC1-4] Create `src/schemas.ts` with Zod validation schemas for all types
- [ ] T012 [P] [AC1-4] Create `src/errors.ts` with PluginError, WorkspaceNotFoundError, GitHubAPIError hierarchy

## Phase 3: GitHub Client

- [ ] T020 [AC4] Create `src/github/types.ts` with GitHub-specific type definitions
- [ ] T021 [AC4] Create `src/github/client.ts` with Octokit wrapper for issue and PR operations

## Phase 4: Polling Infrastructure

- [ ] T030 [AC2] Create `src/polling/types.ts` with PollingConfig interface
- [ ] T031 [AC2] Create `src/polling/status-poller.ts` with exponential backoff implementation

## Phase 5: Workspace Management

- [ ] T040 [AC1] Create `src/workspace/types.ts` with InternalWorkspace, CreateWorkspaceParams
- [ ] T041 [AC1-3] Create `src/workspace/workspace-manager.ts` with workspace lifecycle management

## Phase 6: Main Plugin

- [ ] T050 [AC1-4] Create `src/plugin/copilot-plugin.ts` implementing CopilotPluginInterface
- [ ] T051 Create `src/index.ts` with public API exports

## Phase 7: Tests

- [ ] T060 [P] Create `tests/plugin.test.ts` with plugin initialization and stub behavior tests
- [ ] T061 [P] Create `tests/workspace.test.ts` with workspace lifecycle tests
- [ ] T062 [P] Create `tests/polling.test.ts` with polling and backoff tests

## Phase 8: Integration

- [ ] T070 [AC4] Verify integration with @generacy-ai/generacy core package peer dependency
- [ ] T071 [AC4] Create usage example in package README

## Dependencies & Execution Order

**Sequential Dependencies**:
- T001 must complete before T002, T003 (project must exist)
- T010-T012 can run in parallel (no interdependencies)
- T020 must complete before T021 (types before implementation)
- T030 must complete before T031 (types before implementation)
- T040 must complete before T041 (types before implementation)
- T021, T031, T041 must complete before T050 (plugin depends on all modules)
- T050 must complete before T051 (exports need plugin)
- All implementation must complete before tests (T060-T062)
- Tests must pass before T070-T071

**Parallel Opportunities**:
- T002, T003 can run in parallel after T001
- T010, T011, T012 can run in parallel
- T060, T061, T062 can run in parallel

## Task-to-Acceptance Criteria Mapping

| Acceptance Criteria | Tasks |
|---------------------|-------|
| AC1: Can create Copilot Workspace from issue | T040, T041, T050 |
| AC2: Status polling works | T030, T031, T050 |
| AC3: Output (changes, PR) accessible | T041, T050 |
| AC4: Integration with workflow engine | T020, T021, T050, T070, T071 |
