# Tasks: Discovery-Based Workflow Verification

**Input**: Design documents from `/specs/392-problem-verification-phase/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [P] [US1] Replace verification steps in `speckit-feature.yaml` — Remove the `run-tests` and `run-lint` steps (lines 198–208) in Phase 7 and replace with a single `build.validate` step with `continueOnError: true`. Update or remove the phase comment about `--if-present` and monorepo detection (lines 193–195). File: `.generacy/speckit-feature.yaml`
- [ ] T002 [P] [US1] Replace verification steps in `speckit-bugfix.yaml` — Remove the `run-tests` and `run-lint` steps (lines 166–176) in Phase 6 and replace with a single `build.validate` step with `continueOnError: true`. File: `.generacy/speckit-bugfix.yaml`

## Phase 2: Verification

- [ ] T003 [US1] Verify no hardcoded `pnpm` references remain in verification phases — Grep both files' verification phases for `pnpm` to confirm SC-001. Confirm each file has exactly 1 verification step using `build.validate` (SC-002). Confirm `continueOnError: true` is present (FR-004). Confirm no changes outside the verification phase (Out of Scope constraint).

## Dependencies & Execution Order

- **T001 and T002** are independent (different files) and can run in parallel `[P]`
- **T003** depends on T001 and T002 (verifies the changes made in both files)
- Phase 1 → Phase 2 (verification requires implementation to be complete)
