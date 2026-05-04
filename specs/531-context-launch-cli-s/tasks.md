# Tasks: Launch scaffolder must set DEPLOYMENT_MODE and CLUSTER_VARIANT env vars

**Input**: Design documents from `/specs/531-context-launch-cli-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fix

- [X] T001 [US1][US2] Extend `ScaffoldComposeInput` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — add `variant: 'cluster-base' | 'cluster-microservices'` (required) and `deploymentMode?: 'local' | 'cloud'` (optional, defaults to `'local'`)
- [X] T002 [US1][US2] Add `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars to the `environment` array in `scaffoldDockerCompose()` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`

## Phase 2: Caller Updates

- [X] T003 [P] [US1] Update `packages/generacy/src/cli/commands/launch/scaffolder.ts` — pass `variant: config.variant` to `scaffoldDockerCompose()` call (deploymentMode omitted, defaults to `'local'`)
- [X] T004 [P] [US2] Update `packages/generacy/src/cli/commands/deploy/scaffolder.ts` — pass `variant: config.variant` and `deploymentMode: 'cloud'` to `scaffoldDockerCompose()` call

## Phase 3: Test Updates

- [X] T005 [P] [US1][US2] Update `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` — add `variant` to test inputs, assert `DEPLOYMENT_MODE=local` and `CLUSTER_VARIANT=cluster-base` in compose output
- [X] T006 [P] [US1] Update `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts` — assert `DEPLOYMENT_MODE` and `CLUSTER_VARIANT` env vars present in scaffolded compose output
- [X] T007 [P] [US2] Update `packages/generacy/tests/unit/deploy/scaffolder.test.ts` — assert `DEPLOYMENT_MODE=cloud` and correct `CLUSTER_VARIANT` in compose output

## Phase 4: Verification

- [X] T008 Run `pnpm test` in `packages/generacy/` to verify all tests pass

## Dependencies & Execution Order

- **T001 → T002**: Interface must be extended before env vars are added (same file, sequential)
- **T003 and T004**: Independent caller updates, can run in parallel after T002
- **T005, T006, T007**: Independent test files, can all run in parallel after T003/T004
- **T008**: Final verification after all changes

**Critical path**: T001 → T002 → T003/T004 (parallel) → T005/T006/T007 (parallel) → T008
