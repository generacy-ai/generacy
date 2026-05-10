# Tasks: Launch scaffolder writes `GENERACY_BOOTSTRAP_MODE=wizard`

**Input**: Design documents from `/specs/556-summary-companion-generacy-ai/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Add `GENERACY_BOOTSTRAP_MODE=wizard` to `scaffoldEnvFile()` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — append 3 lines (2 comments + env var) after the "Cluster runtime" section
- [X] T002 [US1] Update existing `scaffoldEnvFile` tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` to assert `GENERACY_BOOTSTRAP_MODE=wizard` is present in output

## Phase 2: Verification

- [X] T003 [US1][US2] Run `pnpm test` in `packages/generacy` to confirm all tests pass (including updated snapshots)

## Dependencies & Execution Order

- **T001 → T002**: Tests should be updated after the implementation change (or simultaneously)
- **T001, T002 → T003**: Verification runs after both source and test changes
- **US2 coverage**: Deploy flow shares `scaffoldEnvFile()` — no deploy-specific changes needed (T001 covers both)
