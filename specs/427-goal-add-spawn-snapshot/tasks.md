# Tasks: Spawn Snapshot Test Harness

**Input**: Design documents from `/specs/427-goal-add-spawn-snapshot/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [ ] T001 Create `packages/orchestrator/src/test-utils/` directory and barrel export `index.ts` re-exporting all test utilities

## Phase 2: Core Implementation

- [ ] T002 Implement `SpawnRecord` type and `RecordingProcessFactory` class in `packages/orchestrator/src/test-utils/recording-process-factory.ts` — implements `ProcessFactory`, records `{command, args, cwd, env}` to `calls[]`, returns dummy `ChildProcessHandle` with `EventEmitter`-based stdout/stderr, deterministic pid `12345`, configurable exit code, and `reset()` method
- [ ] T003 [P] Implement `normalizeSpawnRecords()` helper in `packages/orchestrator/src/test-utils/spawn-snapshot.ts` — sorts env keys alphabetically for deterministic snapshot output
- [ ] T004 Update barrel export `packages/orchestrator/src/test-utils/index.ts` to re-export `RecordingProcessFactory`, `SpawnRecord`, and `normalizeSpawnRecords`

## Phase 3: Baseline Snapshot Test

- [ ] T005 Write baseline snapshot test in `packages/orchestrator/src/worker/__tests__/cli-spawner-snapshot.test.ts` — two scenarios: (1) basic `spawnPhase` without session resume capturing `claude` command, all flags, phase command + prompt, cwd, env overrides; (2) `spawnPhase` with `resumeSessionId` capturing additional `--resume <id>` args. Uses `RecordingProcessFactory` + `normalizeSpawnRecords` + Vitest `toMatchSnapshot()`

## Phase 4: Documentation & Verification

- [ ] T006 Add JSDoc/README comment block at the top of `packages/orchestrator/src/test-utils/index.ts` explaining how Waves 2-3 issues should use the harness (import path, recording pattern, snapshot update workflow)
- [ ] T007 [P] Run `pnpm --filter orchestrator test` to verify all existing tests pass and new snapshot test passes

## Dependencies & Execution Order

```
T001 (barrel export setup)
  └─▶ T002 (RecordingProcessFactory) ─┐
  └─▶ T003 (normalizeSpawnRecords)  ──┤  [P] parallel
                                       ▼
                                     T004 (update barrel export)
                                       ▼
                                     T005 (snapshot test)
                                       ▼
                                     T006 (documentation) ──┐
                                     T007 (verification)  ──┤  [P] parallel
```

- **T002 and T003** can run in parallel (separate files, no dependencies between them)
- **T004** depends on T002 and T003 (needs both exports to exist)
- **T005** depends on T004 (imports from barrel export)
- **T006 and T007** can run in parallel after T005
