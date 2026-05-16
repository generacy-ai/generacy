# Tasks: Sync launch scaffolder docker-compose with cluster-base

**Input**: Design documents from `/specs/634-summary-npx-generacy-launch/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] [US2] Add app-config tmpfs mount to `tmpfsMounts` array in `packages/generacy/src/cli/commands/cluster/scaffolder.ts:162-165` — append `/run/generacy-app-config:mode=1750,uid=1000,gid=1000`
- [X] T002 [US1] Add `generacy-app-config-data:/var/lib/generacy-app-config` to `orchestratorVolumes` array in `scaffolder.ts:156-160` (read-write)
- [X] T003 [US1] Add `generacy-app-config-data:/var/lib/generacy-app-config:ro` to worker volumes in `scaffolder.ts:210` — inline spread `[...sharedVolumes, 'generacy-app-config-data:/var/lib/generacy-app-config:ro']`
- [X] T004 [US1] Add `'generacy-app-config-data': null` to top-level `volumes` declaration in `scaffolder.ts:247-255`

## Phase 2: Tests

- [X] T005 [P] [US2] Extend tmpfs test (line 185-193) in `__tests__/scaffolder.test.ts` to assert `/run/generacy-app-config:mode=1750,uid=1000,gid=1000` on both orchestrator and worker services
- [X] T006 [P] [US1] Add test in `__tests__/scaffolder.test.ts`: orchestrator volumes contain `generacy-app-config-data:/var/lib/generacy-app-config` (rw, no suffix)
- [X] T007 [P] [US1] Add test in `__tests__/scaffolder.test.ts`: worker volumes contain `generacy-app-config-data:/var/lib/generacy-app-config:ro` (read-only) and do NOT contain the rw variant
- [X] T008 [P] [US1] Extend named volumes test (line 303-313) in `__tests__/scaffolder.test.ts` to assert `generacy-app-config-data` is in top-level volumes declaration

## Phase 3: Verification

- [X] T009 Run `pnpm vitest packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` and confirm all tests pass

## Dependencies & Execution Order

- **T001–T004** are all in `scaffolder.ts` and touch adjacent lines — execute sequentially in a single edit pass
- **T005–T008** are all in `scaffolder.test.ts` and independent of each other — can run in parallel (marked `[P]`), but in practice will be a single edit pass
- **T009** depends on all prior tasks completing
- Phase 1 → Phase 2 → Phase 3 (sequential phases, but Phase 2 tasks are internally parallel)

**Total tasks**: 9
**Phases**: 3 (Core Implementation, Tests, Verification)
**Parallel opportunities**: T005–T008 within Phase 2
**Suggested next step**: `/speckit:implement` to begin execution
