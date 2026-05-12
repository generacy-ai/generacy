# Tasks: VS Code Tunnel Device Code Race Condition Fix

**Input**: Design documents from `/specs/604-symptoms-after-all-594/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Add `deviceCode` and `verificationUri` private instance fields to `VsCodeTunnelProcessManager` in `packages/control-plane/src/services/vscode-tunnel-manager.ts` — initialize both as `null`
- [ ] T002 [US1] Populate `deviceCode` and `verificationUri` in `handleStdoutLine` when device code pattern matches (alongside existing `authorization_pending` event emission)
- [ ] T003 [US1] Clear `deviceCode` and `verificationUri` on process exit handler, spawn error handler, and transition to `connected` state
- [ ] T004 [US1] Modify idempotent `start()` early-return path: when `this.child` exists and status is `authorization_pending` with stored `deviceCode`, re-emit `authorization_pending` event with stored fields
- [ ] T005 [US2] Extend idempotent `start()` re-emit: when status is `connected`, re-emit `connected` event with `tunnelName`

## Phase 2: Tests

- [ ] T006 [P] [US1] Add test: idempotent `start()` in `authorization_pending` state re-emits device code event — in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts`
- [ ] T007 [P] [US2] Add test: idempotent `start()` in `connected` state re-emits connected event
- [ ] T008 [P] [US1] Add test: idempotent `start()` in `starting` state does NOT re-emit (no device code stored yet)
- [ ] T009 [P] [US1] Add test: stored `deviceCode`/`verificationUri` cleared on process exit
- [ ] T010 [P] [US1] Add test: stored `deviceCode`/`verificationUri` cleared on transition to `connected`

## Dependencies & Execution Order

- **Phase 1** is sequential: T001 → T002 → T003 → T004 → T005 (each builds on prior fields/logic)
- **Phase 2** tasks are all parallel `[P]` — independent test cases in the same test file, no data dependencies between them
- Phase 2 depends on Phase 1 completion (tests exercise the new logic)

All changes are in `packages/control-plane/` — no cross-package dependencies.
