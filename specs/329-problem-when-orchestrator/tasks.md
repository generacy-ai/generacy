# Tasks: Pre-Validate Dependency Installation

**Input**: Design documents from `/specs/329-problem-when-orchestrator/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Configuration

- [ ] T001 [US1] Add `preValidateCommand` field to `WorkerConfigSchema` in `packages/orchestrator/src/worker/config.ts` — add `preValidateCommand: z.string().default('pnpm install')` after the `validateCommand` field
- [ ] T002 [P] [US1] Add unit test for config schema default in `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` — verify `preValidateCommand` defaults to `'pnpm install'` and accepts empty string

## Phase 2: Core Implementation

- [ ] T003 [US1] Add `runPreValidateInstall` method to `CliSpawner` in `packages/orchestrator/src/worker/cli-spawner.ts` — new method with 5-minute timeout (300,000ms), uses `manageProcess`, returns `PhaseResult`
- [ ] T004 [US1] Add unit tests for `runPreValidateInstall` in `packages/orchestrator/src/worker/__tests__/cli-spawner.test.ts` — test success/failure cases, correct cwd, timeout behavior

## Phase 3: Integration

- [ ] T005 [US1] Integrate pre-validate install step in phase loop at `packages/orchestrator/src/worker/phase-loop.ts` — call `runPreValidateInstall` before `runValidatePhase` when `config.preValidateCommand` is non-empty, handle install failure by stopping phase loop
- [ ] T006 [US1] Add integration tests for phase loop pre-validate behavior — verify install runs before validate, skipped when empty string, install failure prevents validate from running

## Dependencies & Execution Order

- **T001** must complete first (config field needed by T003 and T005)
- **T002** can run in parallel with T001 (test file, no code dependency)
- **T003** depends on T001 (needs `preValidateCommand` type)
- **T004** depends on T003 (tests the new method)
- **T005** depends on T001 and T003 (uses config field and new method)
- **T006** depends on T005 (tests the integration)

Parallel opportunities:
- T001 and T002 can run in parallel
- T003 and T004 could overlap if test stubs are written first
