# Tasks: Fix atomicWrite EXDEV in worker-scaler

**Input**: Design documents from `/specs/701-problem-packages-control-plane/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Fix

- [ ] T001 [US1] Fix `atomicWrite()` temp file location in `packages/control-plane/src/services/worker-scaler.ts` — change `join(tmpdir(), ...)` to `join(dirname(targetPath), ...)` with dot-prefixed hidden name, remove unused `tmpdir` import from `node:os`, add `dirname` import from `node:path`
- [ ] T002 [P] [US1] Update test in `packages/control-plane/__tests__/services/worker-scaler.test.ts` — add assertion that `atomicWrite` creates temp file in `dirname(targetPath)` (not `os.tmpdir()`), add comment documenting the same-filesystem constraint for EXDEV prevention

## Phase 2: Verify

- [ ] T003 [US1] Run `pnpm test` in `packages/control-plane` to verify all existing and new tests pass

## Dependencies & Execution Order

- T001 and T002 can run in parallel (different files, no data dependency)
- T003 depends on both T001 and T002 completing
