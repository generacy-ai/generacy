# Tasks: Claude CLI Worker with Phase Loop

**Input**: Design documents from `/specs/198-cli-worker-phase-loop/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US7 from spec)

## Phase 1: Types, Config, and Setup

- [X] T001 Define worker types in `packages/orchestrator/src/worker/types.ts` — WorkflowPhase, PhaseResult, WorkerContext, CliSpawnOptions, GateDefinition, OutputChunk, PHASE_SEQUENCE, PHASE_TO_COMMAND, PHASE_TO_STAGE constants
- [X] T002 [P] Define WorkerConfig schema in `packages/orchestrator/src/worker/config.ts` — Zod schema for phaseTimeoutMs, workspaceDir, shutdownGracePeriodMs, validateCommand, maxTurns, gates (per-workflow-type)
- [X] T003 [P] Extend OrchestratorConfig in `packages/orchestrator/src/config/schema.ts` — add `worker` field using WorkerConfigSchema, update loadConfig to include worker defaults
- [X] T004 Create barrel export in `packages/orchestrator/src/worker/index.ts` — re-export all public types and classes from the worker module

## Phase 2: Core Components (independently testable)

- [X] T005 [US1] Implement PhaseResolver in `packages/orchestrator/src/worker/phase-resolver.ts` — resolveStartPhase(labels, command) returns starting WorkflowPhase; handles 'process' (from labels/completed phases) and 'continue' (from waiting-for satisfaction) commands (FR-1)
- [X] T006 [P] [US2] Implement LabelManager in `packages/orchestrator/src/worker/label-manager.ts` — onPhaseStart (add phase:X, remove previous phase:*), onPhaseComplete (add completed:X), onGateHit (add waiting-for:X, add agent:paused, remove phase:X), onError (add agent:error, remove phase:X), onWorkflowComplete (remove agent:in-progress); all operations use createGitHubClient with exponential backoff retry (3 attempts) (FR-4)
- [X] T007 [P] [US4] Implement StageCommentManager in `packages/orchestrator/src/worker/stage-comment-manager.ts` — findOrCreateStageComment(stage) using HTML markers `<!-- generacy-stage:X -->`, updateStageComment(stageData) with phase progress table, timestamps, and PR link (FR-5)
- [X] T008 [P] [US3] Implement GateChecker in `packages/orchestrator/src/worker/gate-checker.ts` — checkGate(phase, workflowName, config) returns GateDefinition or null; uses config-driven gate mapping with defaults per workflow type (FR-4, Q3 answer)
- [X] T009 [P] [US5] Implement OutputCapture in `packages/orchestrator/src/worker/output-capture.ts` — parse newline-delimited JSON from Claude CLI stdout; emit SSE events (workflow:started, step:started, step:completed, workflow:completed/failed) via SubscriptionManager; buffer chunks for post-processing (FR-6)

## Phase 3: Process Management

- [X] T010 [US1] Implement CliSpawner in `packages/orchestrator/src/worker/cli-spawner.ts` — spawnClaudeCliPhase(options: CliSpawnOptions) spawns `claude --headless --output json --print all --max-turns N --prompt "<command>"` as child process; handles stdout/stderr capture, timeout with SIGTERM→SIGKILL, abort signal propagation; injectable ProcessFactory for testing (FR-3, FR-8, FR-10)
- [X] T011 [P] [US1] Implement RepoCheckout in `packages/orchestrator/src/worker/repo-checkout.ts` — ensureCheckout(workerId, owner, repo, branch) at path `{workspaceDir}/{workerId}/{owner}/{repo}`; clone if missing, fetch+checkout if exists; cleanup method for post-processing (FR-9, Q4 answer)
- [X] T012 [US1] Implement validate phase runner in CliSpawner — runValidatePhase(checkoutPath, command) spawns configurable test command (default: `pnpm test && pnpm build`); returns PhaseResult with pass/fail (FR-2, Q2 answer)

## Phase 4: Phase Loop and Worker Assembly

- [X] T013 [US1][US2][US3] Implement PhaseLoop in `packages/orchestrator/src/worker/phase-loop.ts` — executeLoop(context: WorkerContext, config: WorkerConfig) iterates from startPhase through PHASE_SEQUENCE; for each phase: call LabelManager.onPhaseStart, spawn CLI (or run validate), call LabelManager.onPhaseComplete, check gate, update stage comment; stop on gate hit, error, or completion; full-loop-per-claim per Q1 answer (FR-1, FR-2)
- [X] T014 [US1-US7] Implement ClaudeCliWorker in `packages/orchestrator/src/worker/claude-cli-worker.ts` — top-level class composing all components; constructor accepts WorkerConfig + dependencies; handle(item: QueueItem) method creates WorkerContext, calls RepoCheckout, PhaseResolver, PhaseLoop; try/finally for label cleanup; emits SSE events for workflow lifecycle (all FRs)

## Phase 5: Server Integration

- [X] T015 Replace placeholder handler in `packages/orchestrator/src/server.ts` — instantiate ClaudeCliWorker with config.worker and server dependencies; pass worker.handle.bind(worker) to WorkerDispatcher constructor; remove placeholder handler code

## Phase 6: Tests

- [ ] T016 [P] Unit tests for PhaseResolver in `packages/orchestrator/src/worker/__tests__/phase-resolver.test.ts` — test process command (no labels → specify, has completed:specify → clarify, has phase:plan → plan); test continue command (waiting-for:clarification satisfied → clarify/plan)
- [ ] T017 [P] Unit tests for GateChecker in `packages/orchestrator/src/worker/__tests__/gate-checker.test.ts` — test speckit-feature defaults (clarify gates), speckit-bugfix defaults (no gates), custom gate config, unknown workflow fallback
- [ ] T018 [P] Unit tests for LabelManager in `packages/orchestrator/src/worker/__tests__/label-manager.test.ts` — test onPhaseStart adds/removes labels, onPhaseComplete adds completed label, onGateHit adds waiting-for + paused, onError adds agent:error; mock Octokit; test retry on API failure
- [ ] T019 [P] Unit tests for CliSpawner in `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` — test successful spawn with mock ProcessFactory, test timeout triggers SIGTERM→SIGKILL, test abort signal kills process, test non-zero exit code handling, test stdout/stderr capture
- [ ] T020 [P] Unit tests for OutputCapture in `packages/orchestrator/src/worker/__tests__/output-capture.test.ts` — test JSON line parsing, test SSE event emission for each event type, test malformed JSON handling, test buffering
- [ ] T021 Integration test for ClaudeCliWorker in `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts` — test full phase loop with mock CLI (specify→clarify→gate hit), test continue command (resume after gate), test error handling (CLI crash), test validate phase (test pass/fail), test graceful shutdown

## Dependencies & Execution Order

**Phase 1** (Setup): T001 first (types are imported by everything), then T002-T004 in parallel.

**Phase 2** (Core Components): T005-T009 can all run in parallel — each is a standalone module with no cross-dependencies. All depend on T001 (types).

**Phase 3** (Process Management): T010 depends on T001 (types) and T009 (OutputCapture for streaming). T011 runs in parallel with T010. T012 depends on T010 (extends CliSpawner).

**Phase 4** (Assembly): T013 depends on T005 (PhaseResolver), T006 (LabelManager), T007 (StageCommentManager), T008 (GateChecker), T010 (CliSpawner). T014 depends on T013 + T011 (RepoCheckout).

**Phase 5** (Integration): T015 depends on T014 (ClaudeCliWorker) and T003 (config extension).

**Phase 6** (Tests): T016-T020 can run in parallel (unit tests for individual modules). T021 depends on T014 (integration test needs full worker). All tests can start after their corresponding implementation is done.

**Parallel opportunities**: 5 tasks in Phase 2 are fully parallel. 4 unit test tasks in Phase 6 are fully parallel.
