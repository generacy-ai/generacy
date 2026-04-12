# Tasks: Migrate SubprocessAgency to AgentLauncher

**Input**: Design documents from `/specs/429-goal-phase-4a-spawn/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/subprocess-agency-launcher.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Orchestrator — Enable stdioProfile on GenericSubprocessIntent

- [X] T001 [US1] Add `stdioProfile?: 'default' | 'interactive'` field to `GenericSubprocessIntent` in `packages/orchestrator/src/launcher/types.ts`
- [X] T002 [US1] Update `GenericSubprocessPlugin.buildLaunch()` to pass `intent.stdioProfile ?? 'default'` to `LaunchSpec.stdioProfile` in `packages/orchestrator/src/launcher/generic-subprocess-plugin.ts`
- [X] T003 [P] [US1] Add unit tests for stdioProfile pass-through in `packages/orchestrator/src/launcher/__tests__/generic-subprocess-plugin.test.ts` — test 'interactive' reflects in LaunchSpec, test omission defaults to 'default'

## Phase 2: Orchestrator — Export Launcher Types

- [X] T004 [US1] Create barrel export `packages/orchestrator/src/launcher/index.ts` exporting `AgentLauncher`, `GenericSubprocessPlugin`, and all types from `types.ts`
- [X] T005 [US1] Add re-export of launcher module from `packages/orchestrator/src/index.ts`

## Phase 3: Core Implementation — SubprocessAgency Migration

- [X] T006 [US1] Define internal `ProcessHandle` interface in `packages/generacy/src/agency/subprocess.ts` covering `stdin`, `stdout`, `stderr`, `kill()` — not exported
- [X] T007 [US1] Add second optional constructor parameter `agentLauncher?: AgentLauncher` to `SubprocessAgency` (NOT in `SubprocessAgencyOptions`)
- [X] T008 [US1] Change `private process` field from `ChildProcess | null` to `ProcessHandle | null`
- [X] T009 [US1] Implement launcher path in `connect()` — call `agentLauncher.launch()` with `{ kind: 'generic-subprocess', command, args, stdioProfile: 'interactive' }`, `cwd`, `env: this.env`; wire stdout/stderr data handlers, exitPromise for exit logging and spawn error rejection
- [X] T010 [US1] Preserve direct-spawn fallback path in `connect()` when `agentLauncher` is undefined — existing code unchanged
- [X] T011 [US1] Verify `disconnect()` and `sendMessage()` work with both `ChildProcess` and `ChildProcessHandle` via `ProcessHandle` interface

## Phase 4: Tests

- [ ] T012 [US1] Create unit tests in `packages/generacy/src/agency/__tests__/subprocess.test.ts` — launcher path: mock AgentLauncher, verify `launch()` called with correct intent, verify stdin/stdout wiring
- [ ] T013 [P] [US1] Create unit test for fallback path: verify direct spawn when no launcher provided
- [ ] T014 [P] [US1] Create unit test for error propagation: verify launcher `launch()` throw is not silently caught, connect() rejects
- [ ] T015 [P] [US1] Create unit test for spawn error: verify ENOENT-like error produces immediate rejection via exitPromise rejection
- [ ] T016 [US1] Create snapshot parity test in `packages/generacy/src/agency/__tests__/subprocess-snapshot.test.ts` — use `RecordingProcessFactory` to assert `{command, args, env, cwd, stdio}` is byte-identical between launcher and direct paths
- [ ] T017 [P] [US1] Add type-level test asserting `SubprocessAgencyOptions` is assignable to the original shape (no new required fields)

## Phase 5: Verification

- [ ] T018 [US1] Run all existing SubprocessAgency tests — verify 100% pass rate unchanged
- [ ] T019 [P] [US1] Run orchestrator tests — verify stdioProfile changes don't break existing tests
- [ ] T020 [US1] Verify `packages/generacy/src/index.ts` exports are unchanged (read-only check)

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

**Within-phase dependencies**:
- T001 → T002 (type must exist before plugin uses it)
- T003 can run in parallel with T002 (tests can be written against the type)
- T004 → T005 (barrel must exist before re-export)
- T006 → T007 → T008 → T009 → T010 → T011 (sequential refactor)
- T012 → T013, T014, T015 can run in parallel after T012 scaffolding
- T016 depends on T012 scaffolding
- T017 can run in parallel with any Phase 4 task
- T018 depends on all Phase 3 + Phase 4 tasks
- T019 can run in parallel with T018

**Parallel opportunities**:
- T003 ∥ T002 (test file vs plugin file)
- T013 ∥ T014 ∥ T015 ∥ T017 (independent test cases)
- T018 ∥ T019 (different package test suites)
