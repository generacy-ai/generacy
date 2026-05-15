# Tasks: Fix Control-plane GET /app-config/manifest envelope mismatch

**Input**: Design documents from `/specs/626-summary-control-plane-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Production Fix

- [ ] T001 [US1] Remove envelope wrapper in `handleGetManifest` — change `res.end(JSON.stringify({ appConfig }))` to `res.end(JSON.stringify(appConfig))` in `packages/control-plane/src/routes/app-config.ts:111`

## Phase 2: Test Updates

- [ ] T002 [US1] Update "returns null when no appConfig" test to assert `body` is `null` instead of `body.appConfig` is `null` in `packages/control-plane/__tests__/routes/app-config.test.ts` (~line 99-100)
- [ ] T003 [P] [US1] Update "returns parsed appConfig when present" test to assert bare shape (`body.env`, `body.files`, `body.schemaVersion`) instead of `body.appConfig.env` in `packages/control-plane/__tests__/routes/app-config.test.ts` (~line 121-126)
- [ ] T004 [P] [US1] Update "returns null when cluster.yaml does not exist" test to assert `body` is `null` instead of `body.appConfig` is `null` in `packages/control-plane/__tests__/routes/app-config.test.ts` (~line 133-134)
- [ ] T005 [US1] Add SC-001 assertion: when non-null, verify top-level keys are exactly `schemaVersion`, `env`, `files` (no `appConfig` wrapper key)

## Phase 3: Verification

- [ ] T006 Run `vitest run` in `packages/control-plane` to confirm all tests pass

## Dependencies & Execution Order

- **T001** must complete first (production fix enables test assertions to pass)
- **T002, T003, T004** can run in parallel (independent test case updates in the same file)
- **T005** depends on T003 (adds assertion to the non-null test case)
- **T006** depends on all prior tasks (runs full test suite)
