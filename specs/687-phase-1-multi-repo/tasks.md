# Tasks: Phase 1 Multi-Repo Workflow Support

**Input**: Design documents from `/specs/687-phase-1-multi-repo/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Config Package — `resolveSiblingWorkdirs()`

- [X] T001 Add `resolveSiblingWorkdirs()` function to `packages/config/src/repos.ts`
  - Implement the function with signature `(config: WorkspaceConfig, primaryWorkdir: string, basePath?: string) => Record<string, string>`
  - Derive `basePath` from `path.dirname(path.resolve(primaryWorkdir))` when not provided
  - Iterate `config.repos`, call `getRepoWorkdir(repo.name, basePath)` for each
  - Normalize paths with `fs.realpathSync.native()`, fallback to `path.resolve()` on error
  - Exclude repo whose resolved path matches normalized `primaryWorkdir`
  - Skip non-existent sibling paths (log info)
  - Return `{}` with warning if no repo matches primary
- [X] T002 [P] Export `resolveSiblingWorkdirs` from `packages/config/src/index.ts`
- [X] T003 [P] Add unit tests in `packages/config/src/__tests__/repos.test.ts`
  - Test: primary repo excluded from sibling map
  - Test: non-existent sibling paths skipped
  - Test: empty repos list → empty map
  - Test: no matching primary → empty map with warning
  - Test: custom `basePath` override
  - Test: symlink resolution via `realpathSync` fallback

## Phase 2: Workflow-Engine Types & Threading

- [X] T004 Add `siblingWorkdirs` to `ExecutionOptions` in `packages/workflow-engine/src/types/execution.ts:106-119`
  - Add optional field: `siblingWorkdirs?: Record<string, string>`
- [X] T005 [P] Add `siblingWorkdirs` to `ActionContext` in `packages/workflow-engine/src/types/action.ts:103-127`
  - Add non-optional field: `siblingWorkdirs: Record<string, string>` (defaults to `{}` in executor)
- [X] T006 Thread `siblingWorkdirs` through executor in `packages/workflow-engine/src/executor/index.ts`
  - In `execute()`: cache `const siblingWorkdirs = options.siblingWorkdirs ?? {};`
  - In `createActionContext()` (~line 575): add `siblingWorkdirs` to the returned object
- [X] T007 [P] Add integration test in `packages/workflow-engine/src/__tests__/sibling-workdirs.test.ts`
  - Test: executor threads sibling map from `ExecutionOptions` to `ActionContext`
  - Test: defaults to `{}` when `siblingWorkdirs` not provided in options

## Phase 3: Orchestrator Wiring

- [X] T008 Add `siblingWorkdirs` to `CliSpawnOptions` in `packages/orchestrator/src/worker/types.ts:167-180`
  - Add optional field: `siblingWorkdirs?: Record<string, string>`
- [X] T009 Forward `siblingWorkdirs` in `CliSpawner.spawnPhase()` at `packages/orchestrator/src/worker/cli-spawner.ts:39-70`
  - Pass `options.siblingWorkdirs` through to `AgentLauncher.launch()` request
- [X] T010 Resolve sibling map in `packages/orchestrator/src/worker/claude-cli-worker.ts` after checkout (~line 215)
  - Import `resolveSiblingWorkdirs` from `@generacy-ai/config`
  - After `checkoutPath` is resolved, load workspace config and call `resolveSiblingWorkdirs(config, checkoutPath)`
  - Fallback to `{}` if config is missing
- [X] T011 Thread `siblingWorkdirs` through `PhaseLoop` at `packages/orchestrator/src/worker/phase-loop.ts`
  - Pass `siblingWorkdirs` from `WorkerContext` or `CliSpawnOptions` into `cliSpawner.spawnPhase()` calls

## Phase 4: Verification

- [X] T012 Run `pnpm -r build` — verify all packages compile with new fields
- [X] T013 [P] Run `pnpm -r test` — verify all existing + new tests pass

## Dependencies & Execution Order

- **Phase 1** (T001–T003): Foundation. T001 must complete first; T002 and T003 can run in parallel after T001.
- **Phase 2** (T004–T007): Depends on Phase 1 for type awareness, but the type changes (T004, T005) are independent of each other and of Phase 1. T006 depends on T004 + T005. T007 depends on T006.
- **Phase 3** (T008–T011): Depends on Phase 1 (imports `resolveSiblingWorkdirs`) and Phase 2 (uses `siblingWorkdirs` field on types). T008 is independent. T009 depends on T008. T010 depends on T001. T011 depends on T008 + T009.
- **Phase 4** (T012–T013): Depends on all prior phases. T012 and T013 can run in parallel.

**Parallel opportunities**: T002+T003, T004+T005, T007 with T008 (different packages), T012+T013.
