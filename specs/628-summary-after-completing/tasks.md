# Tasks: Wizard-env-writer emits GH_USERNAME / GH_EMAIL from github-app credential

**Input**: Design documents from `/specs/628-summary-after-completing/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Tests

- [ ] T001 [US1] Add unit test: `github-app` with `accountLogin` returns 3 entries (`GH_TOKEN`, `GH_USERNAME`, `GH_EMAIL`) in `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`
- [ ] T002 [P] [US1] Add unit test: `github-app` without `accountLogin` returns `GH_TOKEN` only (backwards compat) in `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`
- [ ] T003 [P] [US1] Add unit test: `github-app` with empty string `accountLogin` returns `GH_TOKEN` only in `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`
- [ ] T004 [P] [US1] Add integration test: `writeWizardEnvFile` with `accountLogin` in stored secret verifies env file contains `GH_TOKEN`, `GH_USERNAME`, `GH_EMAIL` in `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`

## Phase 2: Implementation

- [ ] T005 [US1] Widen type assertion in `mapCredentialToEnvEntries` `github-app` branch from `{ token?: unknown }` to `{ token?: unknown; accountLogin?: unknown }` in `packages/control-plane/src/services/wizard-env-writer.ts`
- [ ] T006 [US1] Extract `accountLogin` from parsed JSON and emit `GH_USERNAME` + `GH_EMAIL` entries when present and non-empty in `packages/control-plane/src/services/wizard-env-writer.ts`

## Phase 3: Verification

- [ ] T007 Run existing + new tests via `pnpm --filter @generacy-ai/control-plane test` and confirm all pass

## Dependencies & Execution Order

- **T001-T004** are all independent test additions in the same file, marked `[P]` where applicable. T001 is the primary test; T002-T004 are edge-case variants that can be written alongside.
- **T005-T006** are sequential edits to the same function — T005 (type widening) before T006 (logic addition).
- **T007** depends on all prior tasks.
- Phases are sequential: write tests first (TDD), then implement, then verify.
