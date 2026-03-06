# Tasks: Skip source builds for external projects

**Input**: Design documents from `/specs/335-problem-generacy-setup-build/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1][US2] Add `isExternalProject()` helper function to `packages/generacy/src/cli/commands/setup/build.ts` — checks `!existsSync(config.agencyDir) && !existsSync(config.latencyDir)`
- [X] T002 [US1] Update Phase 2 skip logging in `buildAgency()` (`packages/generacy/src/cli/commands/setup/build.ts` ~line 128-133) — change `logger.warn` to `logger.info` with message "Skipping source build for agency/latency — using installed packages"
- [X] T003 [US1] Update Phase 3 skip logging in `buildGeneracy()` (`packages/generacy/src/cli/commands/setup/build.ts` ~line 203-208) — change `logger.warn` to `logger.info` with message "Skipping source build for generacy — using installed packages"
- [X] T004 [US1] Guard Phase 4 fallback in `installClaudeCodeIntegration()` (`packages/generacy/src/cli/commands/setup/build.ts`) — skip file-copy fallback and MCP server configuration when agency dir doesn't exist, use `info` instead of `warn` for skip messages

## Phase 2: Tests

- [X] T005 [US1] Add test case for "external project" scenario in `packages/generacy/src/__tests__/setup/build.test.ts` — no source repos present, marketplace install succeeds, build exits 0
- [X] T006 [US1] Update existing tests that assert `warn`-level messages for missing dirs to expect `info`-level logging instead (`packages/generacy/src/__tests__/setup/build.test.ts`)
- [X] T007 [US2] Add/verify test case that when source dirs exist, build proceeds unchanged (regression guard) in `packages/generacy/src/__tests__/setup/build.test.ts`

## Phase 3: Validation

- [X] T008 Run `vitest` for `packages/generacy/src/__tests__/setup/build.test.ts` and verify all tests pass

## Dependencies & Execution Order

- **T001** must be completed first (helper used by T002-T004)
- **T002, T003, T004** can run in parallel after T001 (different functions in same file, but independent changes)
- **T005, T006, T007** depend on T001-T004 being complete (tests validate implementation)
- **T008** depends on all prior tasks
