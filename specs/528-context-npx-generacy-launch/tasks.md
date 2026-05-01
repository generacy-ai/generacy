# Tasks: CLI launch-config schema: dev/clone repos should be string[], not single string

**Input**: Design documents from `/specs/528-context-npx-generacy-launch/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema Fix

- [ ] T001 [US1] Fix `repos.dev` and `repos.clone` in `LaunchConfigSchema` — change from `z.string().optional()` to `z.array(z.string()).optional()` in `packages/generacy/src/cli/commands/launch/types.ts:28-29`

## Phase 2: Test Fixture Updates

- [ ] T002 [P] [US1] Update `cloud-client.test.ts` — add `dev` and `clone` array fields to `VALID_LAUNCH_CONFIG` fixture; add test case for multi-repo response validation in `packages/generacy/src/cli/commands/launch/__tests__/cloud-client.test.ts`
- [ ] T003 [P] [US2] Update `integration.test.ts` — add array-format `dev`/`clone` fields to `VALID_CONFIG` fixture in `packages/generacy/src/cli/commands/launch/__tests__/integration.test.ts`
- [ ] T004 [P] [US2] Update `scaffolder.test.ts` — add array-format `dev`/`clone` fields to `mockConfig` fixture in `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts`

## Phase 3: Verification

- [ ] T005 [US1] Run type-check — `pnpm -C packages/generacy tsc --noEmit` must pass with zero errors
- [ ] T006 [US1] Run test suite — `pnpm -C packages/generacy vitest run` must pass with zero failures

## Dependencies & Execution Order

- **T001** must complete first — schema fix is required before test fixtures reference the new types.
- **T002, T003, T004** can run in parallel — they modify independent test files and only depend on T001.
- **T005, T006** run after all code changes — final verification gate.
- Total: 6 tasks across 3 phases. 3 parallel opportunities in Phase 2.
