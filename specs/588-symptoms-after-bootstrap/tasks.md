# Tasks: Fix code-server EACCES on /run/code-server.sock

**Input**: Design documents from `/specs/588-symptoms-after-bootstrap/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fix

- [X] T001 [P] [US1] Update `DEFAULT_CODE_SERVER_SOCKET` from `'/run/code-server.sock'` to `'/run/generacy-control-plane/code-server.sock'` in `packages/control-plane/src/services/code-server-manager.ts`
- [X] T002 [P] [US1] Update orchestrator relay-route fallback for `CODE_SERVER_SOCKET_PATH` from `'/run/code-server.sock'` to `'/run/generacy-control-plane/code-server.sock'` in `packages/orchestrator/src/server.ts`

## Phase 2: Verification

- [X] T003 [US1] Verify no other references to the old socket path `/run/code-server.sock` remain in the codebase (grep check)

## Dependencies & Execution Order

- T001 and T002 are independent (different packages) and can run in parallel
- T003 depends on T001 + T002 completion — confirms consistency across the codebase
