# Tasks: Add Lint Rule Forbidding Direct child_process

**Input**: Design documents from `/specs/437-goal-add-lint-rule/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Add `no-restricted-imports` rule to `.eslintrc.json` — Add `"no-restricted-imports"` to the `rules` section forbidding both `"child_process"` and `"node:child_process"` with a descriptive error message pointing developers to `ProcessFactory` / `AgentLauncher`. File: `.eslintrc.json`
- [X] T002 [US1] Add overrides for sanctioned and grandfathered files — Add an `overrides` entry listing the 3 sanctioned files (`claude-cli-worker.ts`, `process-factory.ts`, `cli-utils.ts`) and the 11 grandfathered files with `"no-restricted-imports": "off"`. File: `.eslintrc.json`
- [X] T003 [US1] Add overrides for test files — Add a second `overrides` entry with glob patterns `**/__tests__/**`, `**/tests/**`, `**/*.test.ts`, `**/*.spec.ts` with `"no-restricted-imports": "off"`. File: `.eslintrc.json`

## Phase 2: Validation

- [X] T004 [US1] Run `pnpm lint` and verify it passes — Execute `pnpm lint` across all packages to confirm no existing code violates the new rule. Fix any missed files by adding them to the override list.
- [X] T005 [US1] Regression test — Create a temporary file importing `child_process.spawn` in an unlisted path, run lint to confirm it fails with the expected error message, then remove the test file.
- [X] T006 [US1] Verify error message clarity — Confirm the lint error message includes the directive to use `ProcessFactory` or `AgentLauncher` and references issue #437.

## Dependencies & Execution Order

**Phase 1** (all sequential — T001→T002→T003, all modify same file `.eslintrc.json`):
- T001 must come first (adds the rule before overrides reference it)
- T002 and T003 both add overrides and modify the same file, so they are sequential
- In practice, T001–T003 will likely be done in a single edit pass

**Phase 2** (T004, T005, T006 can run in parallel after Phase 1):
- T004 [P] — lint pass validation
- T005 [P] — regression test (independent temporary file)
- T006 [P] — message verification (can be checked during T005)

**Parallel opportunities**: 3 tasks in Phase 2 are independent and can run concurrently.
