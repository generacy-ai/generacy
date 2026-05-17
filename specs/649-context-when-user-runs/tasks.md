# Tasks: Launch directory selection prompt

**Input**: Design documents from `/specs/649-context-when-user-runs/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US1] Replace `confirmDirectory` with `selectDirectory` in `packages/generacy/src/cli/commands/launch/prompts.ts`
  - Remove `confirmDirectory` export
  - Add `selectDirectory(defaultDir: string, cwd: string): Promise<string>` export
  - Build options array: default path, cwd (if different from default), custom sentinel
  - Annotate cwd option with "(already contains .generacy/)" if applicable
  - Handle `__custom__` selection with `p.text()` follow-up and `path.resolve()`
  - Guard all prompts with `exitIfCancelled`

- [ ] T002 [US1] [US2] Update caller in `packages/generacy/src/cli/commands/launch/index.ts`
  - Replace `confirmDirectory` import with `selectDirectory`
  - When `opts.dir` provided: use `resolveProjectDir(config.projectName, opts.dir)` directly (no prompt)
  - When `opts.dir` not provided: call `selectDirectory(resolveProjectDir(config.projectName), process.cwd())`
  - Remove the "confirmed === false → exit" branch (selection always returns valid path)
  - Pass selected path to `scaffoldProject()`

## Phase 2: Verification

- [ ] T003 [US1] Manual verification of interactive flow
  - Verify 3 options appear when cwd != default
  - Verify 2 options appear when cwd == default (collapsed)
  - Verify custom path resolves correctly (relative and absolute)
  - Verify cancel (Ctrl+C) exits with code 130

- [ ] T004 [US2] Verify `--dir` bypass
  - Confirm `generacy launch --claim=X --dir=/tmp/test` skips prompt entirely
  - Confirm scaffolder receives the correct path

## Dependencies & Execution Order

- T001 → T002 (T002 imports from T001's output)
- T003 and T004 depend on both T001 and T002 being complete
- T003 and T004 can run in parallel with each other
