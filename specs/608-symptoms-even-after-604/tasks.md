# Tasks: VS Code tunnel name exceeds 20-char limit

**Input**: Design documents from `/specs/608-symptoms-even-after-604/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Implementation

- [X] T001 [US1] Add `deriveTunnelName()` pure function to `packages/control-plane/src/services/vscode-tunnel-manager.ts` — strips hyphens, prefixes `g-`, takes first 18 hex chars (total 20). Export it.
- [X] T002 [US1] Update `loadOptionsFromEnv()` in `packages/control-plane/src/services/vscode-tunnel-manager.ts` — rename `tunnelName` variable to `clusterId`, call `deriveTunnelName(clusterId)` for `tunnelName` field.

## Phase 2: Tests

- [X] T003 [US1] Add `deriveTunnelName` unit tests in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` — known UUID mapping (`9e5c8a0d-...` → `g-9e5c8a0d755e40b3b0`), output length <= 20, determinism, hyphen-free input handling.
- [X] T004 [US1] Update existing `loadOptionsFromEnv` test in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` — expect derived name (`g-9e5c8a0d755e40b3b0`) instead of raw cluster ID.

## Phase 3: Verify

- [X] T005 Run `vitest` for `packages/control-plane` to confirm all tests pass.

## Dependencies & Execution Order

- T001 → T002 (deriveTunnelName must exist before loadOptionsFromEnv calls it)
- T001, T002 → T003, T004 (tests depend on implementation)
- T003, T004 can run in parallel (different test sections, same file — but logically independent)
- T005 depends on all prior tasks
