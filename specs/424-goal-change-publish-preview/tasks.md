# Tasks: Gate publish-preview.yml on Manual Dispatch

**Input**: Design documents from `/specs/424-goal-change-publish-preview/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Replace push trigger with workflow_dispatch in `.github/workflows/publish-preview.yml` (lines 3–5): change `on: push: branches: [develop]` to `on: workflow_dispatch:`
- [X] T002 [US2] Add inline YAML comment block at top of `.github/workflows/publish-preview.yml` explaining why the trigger was changed (spawn-refactor safety) and how to manually trigger (`gh workflow run publish-preview.yml --ref develop` or Actions UI)

## Phase 2: Verification & Documentation

- [X] T003 [US1] Verify `publish-devcontainer-feature` job `needs: publish-npm` chain is unaffected by trigger change (review `.github/workflows/publish-preview.yml` lines 69–74 — no code change expected)
- [X] T004 [US1] Verify `concurrency` group (`github.workflow`) remains valid under `workflow_dispatch` trigger (review line 8 — no code change expected)
- [X] T005 [P] [US1] Confirm `.github/workflows/release.yml` is completely untouched (FR-004 guard rail)
- [X] T006 [P] [US2] Verify `specs/424-goal-change-publish-preview/quickstart.md` covers manual dispatch instructions for PR description reference

## Dependencies & Execution Order

- **T001** must complete first — it's the core trigger change
- **T002** depends on T001 (modifies the same file, needs trigger context)
- **T003, T004** depend on T001 (verification of the trigger change)
- **T005, T006** are independent and can run in parallel with each other and with T003/T004
- Phase 1 (T001–T002) → Phase 2 (T003–T006)

## Parallel Opportunities

- T005 and T006 can run in parallel (different files, read-only verification)
- T003 and T004 can run in parallel (different verification checks on the same file)
