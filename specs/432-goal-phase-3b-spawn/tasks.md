# Tasks: Migrate pr-feedback-handler to AgentLauncher

**Input**: Design documents from `/specs/432-goal-phase-3b-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Constructor Wiring

- [X] T001 [US1] Add optional `agentLauncher?: AgentLauncher` parameter to `PrFeedbackHandler` constructor and store as private field — `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- [X] T002 [US1] Pass `this.agentLauncher` when constructing `PrFeedbackHandler` in `ClaudeCliWorker` — `packages/orchestrator/src/worker/claude-cli-worker.ts` (around line 213-218)

## Phase 2: Core Migration

- [X] T003 [US1] Replace direct `processFactory.spawn('claude', args, ...)` call (line ~305) with dual-path: `agentLauncher.launch()` when available, fallback to existing spawn — `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- [X] T004 [US1] [US2] Construct `PrFeedbackIntent` with `kind: 'pr-feedback'`, `prNumber`, and `prompt` fields; pass `cwd: checkoutPath` and `env: {}` to launcher — `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- [X] T005 [US2] Extract `handle.process` from `LaunchHandle` and wire into existing downstream code (stdout capture, stderr buffering, signal handling) — `packages/orchestrator/src/worker/pr-feedback-handler.ts`

## Phase 3: Tests

- [X] T006 [US2] Update existing `PrFeedbackHandler` constructor calls in tests to pass `undefined` for the new `agentLauncher` param (backward compat) — `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts`
- [X] T007 [P] [US1] Add unit test: construct `PrFeedbackHandler` with a mock `AgentLauncher`, verify `launch()` called with correct `PrFeedbackIntent` and `handle.process` used for downstream ops — `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts`
- [X] T008 [P] [US2] Add snapshot test using `RecordingProcessFactory` + `normalizeSpawnRecords()` to validate spawn-arg parity between direct and launcher paths — `packages/orchestrator/src/worker/__tests__/pr-feedback-handler.test.ts`

## Phase 4: Validation

- [X] T009 Run existing PR feedback test suite and confirm all tests pass without modification (SC-002)
- [X] T010 Verify snapshot test produces byte-identical spawn records (SC-001, SC-003)

## Dependencies & Execution Order

**Phase 1** (sequential): T001 → T002 (constructor must be updated before wiring injection site)

**Phase 2** (sequential, depends on Phase 1): T003 → T004 → T005 (spawn replacement, intent construction, and handle extraction are tightly coupled edits in the same function — best done in order)

**Phase 3** (depends on Phase 2): T006 first (fix existing tests), then T007 and T008 can run in **parallel** (they test different aspects in the same file but are independent test cases)

**Phase 4** (depends on Phase 3): T009 and T010 can run in **parallel** (independent validation steps)

**Parallel opportunities**: T007 ∥ T008, T009 ∥ T010
