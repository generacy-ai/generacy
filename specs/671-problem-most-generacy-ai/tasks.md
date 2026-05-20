# Tasks: Fix stale @latest npm dist-tag

**Input**: Design documents from `/specs/671-problem-most-generacy-ai/`
**Prerequisites**: plan.md (required), spec.md (required), research.md (available)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Workflow Fix

- [X] T001 [US1] Replace the `Add @stable dist-tag` step (lines 55-67) in `.github/workflows/release.yml` with a new `Advance @latest dist-tag for all stable releases` step that loops over `steps.changesets.outputs.publishedPackages` and runs `npm dist-tag add "$name@$version" latest` for each package
- [X] T002 [US2] Verify `publish-preview.yml` is unchanged — confirm it uses `--tag preview` and does NOT touch `@latest`

## Phase 2: Post-Merge Manual Cleanup

- [ ] T003 [US1] One-time manual `npm dist-tag add` to advance `@latest` to current `@stable` for all ~16 stale packages (run after workflow fix merges)
- [ ] T004 [US1] Verify all packages: `npm view @generacy-ai/<pkg> dist-tags` shows `@latest` matching `@stable`

## Dependencies & Execution Order

- **T001** is the core fix — must land first
- **T002** is a verification task, can run in parallel with T001 (read-only check)
- **T003** depends on T001 merging to `main`
- **T004** depends on T003 completing
- T001 and T002 are the only automatable tasks; T003 and T004 are manual post-merge steps
