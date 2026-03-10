# Tasks: Fix RepoCheckout Dirty-State Blocking Branch Switch

**Input**: Design documents from `/specs/366-summary-repocheckout/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Fixes

- [X] T001 [US1] Fix `updateRepo()` in `packages/orchestrator/src/worker/repo-checkout.ts` — add `git reset --hard HEAD` + `git clean -fd` before `git fetch origin` (after the existing `logger.info` call, around line 185)
- [X] T002 [US1] Fix `switchBranch()` in `packages/orchestrator/src/worker/repo-checkout.ts` — add `git reset --hard HEAD` + `git clean -fd` before `git fetch origin` (around lines 102-121)
- [X] T003 [P] [US1] Update `/workspaces/tetrad-development/.devcontainer/bootstrap-worker.sh` — add `--clean` flag to both `generacy setup workspace` calls (around lines 106-112): `generacy setup workspace --clean --config "$CONFIG_PATH"` and `generacy setup workspace --clean`

## Phase 2: Tests

- [X] T004 [US1] Add dirty-state tests for `updateRepo()` path to `packages/orchestrator/src/worker/__tests__/repo-checkout.test.ts` — new `describe` block verifying call order: `reset --hard HEAD` → `clean -fd` → `fetch origin` → `checkout` (use existing `callOrder` pattern from the test file)
- [X] T005 [US1] Add dirty-state tests for `switchBranch()` to `packages/orchestrator/src/worker/__tests__/repo-checkout.test.ts` — verify call order: `reset --hard HEAD` → `clean -fd` → `fetch origin` → `checkout` (same `callOrder` pattern)

## Dependencies & Execution Order

- T001 and T002 both modify `repo-checkout.ts` — run sequentially (T001 first, then T002)
- T003 modifies `bootstrap-worker.sh` in a separate repo — can run in parallel with T001/T002 (marked `[P]`)
- T004 and T005 both modify `repo-checkout.test.ts` — run sequentially after T001 and T002 are complete
- Phase 2 must wait for Phase 1 to complete (tests validate the implementation)
