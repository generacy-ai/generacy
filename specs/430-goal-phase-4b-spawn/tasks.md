# Tasks: Phase 4b — Migrate executeCommand / executeShellCommand to AgentLauncher

**Input**: Design documents from `/specs/430-goal-phase-4b-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
  - **US1**: Public API preservation (signatures unchanged)
  - **US2**: Process-group semantics (detached, group-kill)
  - **US3**: Backward compatibility (fallback for external npm consumers)
  - **US4**: Snapshot & regression testing

---

## Phase 1: Extend ProcessFactory with `detached` Support

- [X] T001 [US2] Add `detached?: boolean` to `ProcessFactory.spawn()` options in `packages/orchestrator/src/worker/types.ts` (line ~272)
- [X] T002 [P] [US2] Add `detached?: boolean` to `LaunchSpec` in `packages/orchestrator/src/launcher/types.ts` (line ~46)
- [X] T003 [P] [US2] Add `detached?: boolean` to `LaunchRequest` in `packages/orchestrator/src/launcher/types.ts` (line ~32)
- [X] T004 [P] [US2] Add `detached?: boolean` to `GenericSubprocessIntent` and `ShellIntent` in `packages/orchestrator/src/launcher/types.ts` (lines ~6, ~16)
- [X] T005 [US2] Update `defaultProcessFactory` in `packages/orchestrator/src/worker/claude-cli-worker.ts` (line ~28) to pass `detached` through to `child_process.spawn`
- [X] T006 [P] [US2] Update `conversationProcessFactory` in `packages/orchestrator/src/conversation/process-factory.ts` to pass `detached` through to `child_process.spawn`
- [X] T007 [US2] Update `GenericSubprocessPlugin.buildLaunch()` in `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts` (line ~18) to forward `detached` from intent to `LaunchSpec`
- [X] T008 [US2] Update `AgentLauncher.launch()` in `packages/orchestrator/src/launcher/agent-launcher.ts` (line ~47) to pass `request.detached` (or `launchSpec.detached`) to the factory's `spawn()` options
- [X] T009 [US4] Update `RecordingProcessFactory` in `packages/orchestrator/src/test-utils/recording-process-factory.ts` to capture `detached` in `SpawnRecord`

## Phase 2: Module-level Registration in workflow-engine

- [X] T010 [US1] Create `packages/workflow-engine/src/actions/process-launcher.ts` with `LaunchFunctionRequest`, `LaunchFunctionHandle`, `LaunchFunction` types, and `registerProcessLauncher()` / `getProcessLauncher()` / `clearProcessLauncher()` functions
- [X] T011 [US1] Export registration API (`registerProcessLauncher`, `getProcessLauncher`, `LaunchFunction`, `LaunchFunctionRequest`, `LaunchFunctionHandle`) from `packages/workflow-engine/src/actions/index.ts`
- [X] T012 [US1] Re-export registration API from `packages/workflow-engine/src/index.ts` (public API surface)

## Phase 3: Refactor executeCommand / executeShellCommand

- [X] T013 [US1] [US2] [US3] Refactor `executeCommand` in `packages/workflow-engine/src/actions/cli-utils.ts` (line ~109): check for registered launcher → if present, build `LaunchFunctionRequest` with `kind: 'generic-subprocess'`, `detached: true`; if absent, fall back to direct `child_process.spawn`. Preserve StringDecoder, callbacks, timeout, abort, and group-kill logic in both paths.
- [X] T014 [US1] [US2] [US3] Refactor `executeShellCommand` in `packages/workflow-engine/src/actions/cli-utils.ts` (line ~224): same approach with `kind: 'shell'`, `detached: true`. Preserve timeout, abort, and group-kill logic.
- [X] T015 [US3] Add `// Wave 5 lint allow-list: direct spawn fallback for external consumers` comment on fallback paths in both functions

## Phase 4: Wire Registration at Orchestrator Boot

- [X] T016 [US1] In `packages/orchestrator/src/worker/claude-cli-worker.ts` (or `packages/orchestrator/src/server.ts`), import `registerProcessLauncher` from `@generacy-ai/workflow-engine` and call it during initialization with an adapter function that maps `LaunchFunctionRequest` → `AgentLauncher.launch()` → `LaunchFunctionHandle`

## Phase 5: Snapshot & Regression Tests

- [X] T017 [US4] Create `packages/workflow-engine/src/actions/__tests__/cli-utils-snapshot.test.ts` with inline recording mock to verify spawn call composition for `executeCommand` (launcher path and fallback path)
- [X] T018 [P] [US4] Add snapshot tests for `executeShellCommand` spawn composition in `cli-utils-snapshot.test.ts` (launcher path and fallback path)
- [X] T019 [US4] Verify existing `packages/workflow-engine/src/actions/__tests__/cli-utils.test.ts` passes unchanged (all 12 test cases)
- [X] T020 [P] [US4] Verify existing `cli-spawner-snapshot.test.ts` in orchestrator passes unchanged
- [X] T021 [US4] Run full workflow-engine test suite — all tests must pass
- [X] T022 [P] [US4] Run full orchestrator test suite — all tests must pass

---

## Dependencies & Execution Order

### Phase boundaries (sequential)
- **Phase 1** → **Phase 2** → **Phase 3** → **Phase 4** → **Phase 5**
- Phases must complete in order (each builds on prior)

### Parallel opportunities within phases

**Phase 1**:
- T001 is independent (types file)
- T002, T003, T004 can run in parallel (all modify `launcher/types.ts` but different interfaces — may need sequential if same file)
- T005, T006 can run in parallel (different factory files) — both depend on T001
- T007 depends on T002 + T004 (needs LaunchSpec.detached + intent.detached)
- T008 depends on T001 + T002 (needs factory options.detached + launchSpec.detached)
- T009 independent of T005-T008 (test utility)

**Phase 2**:
- T010 first (creates the file)
- T011, T012 depend on T010, can run in parallel

**Phase 3**:
- T013, T014 depend on Phase 2 complete; can run in parallel (different functions, same file — sequential recommended)
- T015 runs after T013, T014

**Phase 4**:
- T016 depends on Phase 2 (registration API) and Phase 1 (AgentLauncher detached support)

**Phase 5**:
- T017, T018 can be created together (same file)
- T019, T020 can run in parallel (different packages)
- T021, T022 can run in parallel (different packages) — run after T017-T020
